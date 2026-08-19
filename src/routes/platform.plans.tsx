import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  createPlatformPlan,
  getPlatformContext,
  getPlatformStripeConfig,
  mirrorPlatformPlan,
  updatePlatformPlan,
} from "@/lib/platform.functions";
import { reassignAllBillingTiers } from "@/lib/platform-billing.functions";
import {
  normalizePlanSlug,
  planMirrorState,
  planShapeProblem,
  planSlugProblem,
  PLATFORM_CATALOG_CURRENCY,
} from "@/lib/platform-plan-catalog";
import {
  planTierDeclarationProblem,
  PLAN_ENTITLEMENTS,
  PLAN_TIERS,
  TIER_NAMES,
  ENTITLEMENT_LABELS,
  type PlanTier,
} from "@/lib/entitlements";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { CloudUpload, Eye, EyeOff, Pencil, Plus } from "lucide-react";
import { useConfirmDialog } from "@/components/ConfirmDialog";

export const Route = createFileRoute("/platform/plans")({
  component: PlansPage,
});

type Plan = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  price_cents: number | null;
  annual_price_cents: number | null;
  included_seats: number | null;
  price_per_seat_cents: number | null;
  is_enterprise: boolean;
  currency: string;
  interval: string;
  is_active: boolean;
  sort_order: number;
  // All five Stripe columns, not just the base price. The table used to read
  // one of them and print a dash for everything else, which made "billed by
  // contract", "free" and "the mirroring failed" look identical.
  stripe_product_id: string | null;
  stripe_price_id: string | null;
  stripe_annual_price_id: string | null;
  stripe_seat_price_id: string | null;
  stripe_annual_seat_price_id: string | null;
};

function formatBase(p: Plan): string {
  if (p.is_enterprise) return "Custom";
  // price_cents is ALWAYS the monthly base; annual plans additionally carry
  // their yearly base in annual_price_cents.
  if (p.interval === "year" && p.annual_price_cents !== null) {
    return `$${(p.annual_price_cents / 100).toFixed(0)}/year`;
  }
  if (p.price_cents !== null) return `$${(p.price_cents / 100).toFixed(0)}/month`;
  return "-";
}

function formatSeats(p: Plan): string {
  if (p.is_enterprise) return "Custom";
  if (p.included_seats === null) return "-";
  return `${p.included_seats} employee${p.included_seats === 1 ? "" : "s"} included`;
}

function formatOverage(p: Plan): string {
  if (p.is_enterprise) return "By contract";
  if (!p.price_per_seat_cents) return "-";
  return `$${(p.price_per_seat_cents / 100).toFixed(0)}/employee/${p.interval}`;
}

/** Dollars as typed → integer cents, or undefined for "left blank". Shared by
 *  both forms so the create dialog cannot round differently from the edit one. */
function dollarsToCents(s: string): number | undefined {
  if (s.trim() === "") return undefined;
  const n = Math.round(parseFloat(s) * 100);
  return Number.isFinite(n) ? n : undefined;
}

function wholeNumber(s: string): number | undefined {
  if (s.trim() === "") return undefined;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** What the Stripe column should say for a plan, and whether there is anything
 *  to do about it. `planMirrorState` is shared with the server so the console
 *  and the mirroring agree on what "mirrored" means. */
function mirrorLabel(p: Plan): { text: string; muted: boolean; canMirror: boolean } {
  switch (planMirrorState(p)) {
    case "enterprise":
      return { text: "Billed by contract", muted: true, canMirror: false };
    case "nothing-to-mirror":
      return { text: "No chargeable price", muted: true, canMirror: false };
    case "mirrored":
      return { text: p.stripe_price_id ?? "In Stripe", muted: false, canMirror: false };
    case "partial":
      return { text: "Partly in Stripe", muted: false, canMirror: true };
    default:
      return { text: "Not in Stripe", muted: false, canMirror: true };
  }
}

type NewPlanForm = {
  name: string;
  /** Blank means "derive it from the name". Typed once, it stops following. */
  slug: string;
  description: string;
  isEnterprise: boolean;
  /** What the plan UNLOCKS. Not derived from the slug and not defaulted on the
   *  way to the database — see planTierDeclarationProblem. */
  entitlementTier: PlanTier;
  price: string; // MONTHLY base dollars
  annualPrice: string; // ANNUAL base dollars ($/year)
  includedSeats: string;
  pricePerSeat: string;
  interval: "month" | "year";
  aiActionsIncluded: string;
  aiOverageCents: string;
  sortOrder: string;
};

const BLANK_NEW_PLAN: NewPlanForm = {
  name: "",
  slug: "",
  description: "",
  isEnterprise: false,
  entitlementTier: "launch",
  price: "",
  annualPrice: "",
  includedSeats: "",
  pricePerSeat: "",
  interval: "month",
  aiActionsIncluded: "",
  aiOverageCents: "",
  sortOrder: "",
};

type EditForm = {
  name: string;
  description: string;
  price: string; // MONTHLY base dollars, raw string while typing
  annualPrice: string; // ANNUAL base dollars ($/year) — only used when interval=year
  includedSeats: string;
  pricePerSeat: string; // dollars per interval
  interval: "month" | "year";
  isActive: boolean;
  sortOrder: string;
};

function PlansPage() {
  const qc = useQueryClient();
  const ctxFn = useServerFn(getPlatformContext);
  useQuery({ queryKey: ["platform", "ctx"], queryFn: () => ctxFn() });
  const updateFn = useServerFn(updatePlatformPlan);

  const q = useQuery({
    queryKey: ["platform", "plans", "list"],
    queryFn: async () => {
      // Platform admins read the whole catalog (incl. deactivated plans) via
      // the "Platform admins manage plans" RLS policy.
      const { data, error } = await (supabase as any)
        .from("platform_plans")
        .select(
          "id, name, slug, description, price_cents, annual_price_cents, included_seats, price_per_seat_cents, is_enterprise, currency, interval, is_active, sort_order, stripe_product_id, stripe_price_id, stripe_annual_price_id, stripe_seat_price_id, stripe_annual_seat_price_id",
        )
        .order("sort_order", { ascending: true });
      if (error) throw new Error(error.message);
      return (data ?? []) as Plan[];
    },
  });

  const { confirm, dialog } = useConfirmDialog();
  const recomputeFn = useServerFn(reassignAllBillingTiers);
  const recompute = useMutation({
    mutationFn: () => recomputeFn(),
    onSuccess: (r: { count: number }) => {
      toast.success(
        r.count === 0
          ? "Every tenant was already on the right tier"
          : `Moved ${r.count} organization${r.count === 1 ? "" : "s"} onto a different tier`,
      );
      qc.invalidateQueries({ queryKey: ["platform"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ── WHY is_active NEEDS ITS OWN ACTION ──────────────────────────────────
  //
  // updatePlatformPlan takes `isActive` on its own. Its only caller was the
  // edit dialog's Save, which sends the whole form and validates the whole
  // form first — and one of those checks is `interval === "year" && no annual
  // price → toast and return`. An annual plan whose annual_price_cents is NULL
  // therefore cannot be saved at all, so its is_active could not be reached by
  // anything in the product. Taking a plan off sale is also not an edit: it is
  // the one plan action with a blast radius, and it belongs behind a
  // confirmation that names the plan rather than behind a switch in a form
  // that rewrites eight other columns on the way past.
  const setActive = useMutation({
    mutationFn: (v: { plan: Plan; isActive: boolean }) =>
      updateFn({ data: { planId: v.plan.id, isActive: v.isActive } }),
    onSuccess: (_r, v) => {
      toast.success(
        v.isActive
          ? `${v.plan.name} is on sale again`
          : `${v.plan.name} is no longer offered to new tenants`,
      );
      qc.invalidateQueries({ queryKey: ["platform", "plans"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const requestSetActive = async (p: Plan) => {
    if (p.is_active) {
      if (
        await confirm({
          title: `Stop offering ${p.name}?`,
          description: `${p.name} (${formatBase(p)}) disappears from signup and from every tenant's plan picker. Tenants already on it stay on it and keep being billed — this only stops anybody new choosing it. You can put it back at any time.`,
          destructive: true,
          confirmLabel: "Stop offering it",
        })
      )
        setActive.mutate({ plan: p, isActive: false });
      return;
    }
    if (
      await confirm({
        title: `Offer ${p.name} again?`,
        description: `${p.name} goes back into signup and into every tenant's plan picker at its current price of ${formatBase(p)}, ${formatSeats(p).toLowerCase()}. Check the price is what you want before putting it back on sale.`,
        confirmLabel: "Offer it again",
      })
    )
      setActive.mutate({ plan: p, isActive: true });
  };

  // ── Creating a plan ─────────────────────────────────────────────────────
  //
  // The server writes the row OFF SALE whatever this form says, then mirrors it
  // to Stripe. So this dialog has no Active switch: putting a plan on sale is
  // the existing "Offer again" action, which already spells out that it appears
  // in signup and in every tenant's plan picker. Creating something is not the
  // moment to also start selling it.
  const [creating, setCreating] = useState(false);
  const [newPlan, setNewPlan] = useState<NewPlanForm>(BLANK_NEW_PLAN);
  const createFn = useServerFn(createPlatformPlan);
  const mirrorFn = useServerFn(mirrorPlatformPlan);
  const stripeCfgFn = useServerFn(getPlatformStripeConfig);
  const stripeCfg = useQuery({
    queryKey: ["platform", "plans", "stripe-config"],
    queryFn: () => stripeCfgFn(),
  });

  const create = useMutation({
    mutationFn: (v: {
      name: string;
      slug: string;
      description: string | null;
      currency: string;
      isEnterprise: boolean;
      entitlementTier: PlanTier;
      priceCents: number | null;
      annualPriceCents: number | null;
      includedSeats: number | null;
      pricePerSeatCents: number | null;
      interval: "month" | "year";
      aiActionsIncluded: number | null;
      aiOverageCentsPerAction: number | null;
      sortOrder?: number;
    }) => createFn({ data: v }),
    onSuccess: (r) => {
      // Two different things happened and they get two different sentences.
      // "Plan created" alone would be true and would hide the half that did not
      // run, which is the fault this whole round is about.
      if (r.mirror.problem) {
        toast.warning(`${r.name} was created, off sale. ${r.mirror.problem}`, { duration: 12000 });
      } else if (r.mirror.mirrored) {
        toast.success(
          `${r.name} was created, off sale, with ${r.mirror.created.length + r.mirror.reused.length} Stripe price(s). ` +
            `Use “Offer again” when you want to sell it.`,
        );
      } else {
        toast.success(
          `${r.name} was created, off sale. ${r.mirror.skipped[0]?.reason ?? "Nothing needed mirroring."}`,
        );
      }
      qc.invalidateQueries({ queryKey: ["platform", "plans"] });
      setCreating(false);
      setNewPlan(BLANK_NEW_PLAN);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const mirror = useMutation({
    mutationFn: (p: Plan) => mirrorFn({ data: { planId: p.id } }),
    onSuccess: (r, p) => {
      toast.success(
        r.created.length
          ? `${p.name}: created ${r.created.length} Stripe price(s).`
          : `${p.name}: adopted ${r.reused.length} price(s) Stripe already had under those names.`,
      );
      qc.invalidateQueries({ queryKey: ["platform", "plans"] });
    },
    onError: (e: Error) => toast.error(e.message, { duration: 12000 }),
  });

  const existingSlugs = (q.data ?? []).map((p) => p.slug);
  const newSlug = normalizePlanSlug(newPlan.slug || newPlan.name);
  const newSlugProblem = newPlan.name.trim() === "" && newPlan.slug.trim() === ""
    ? null
    : planSlugProblem(newSlug, existingSlugs);
  // Same rule as the server's, evaluated as the form is filled in. Blank while
  // the dialog is still empty, so it does not shout at somebody who has typed
  // nothing yet.
  const newTierProblem =
    newPlan.name.trim() === "" && newPlan.slug.trim() === ""
      ? null
      : planTierDeclarationProblem(newSlug, newPlan.entitlementTier);

  function submitCreate() {
    if (!newPlan.name.trim()) {
      toast.error("Name can't be empty");
      return;
    }
    if (newSlugProblem) {
      toast.error(newSlugProblem);
      return;
    }
    const priceCents = newPlan.isEnterprise ? null : (dollarsToCents(newPlan.price) ?? null);
    const annualPriceCents = newPlan.isEnterprise
      ? null
      : (dollarsToCents(newPlan.annualPrice) ?? null);
    const pricePerSeatCents = dollarsToCents(newPlan.pricePerSeat) ?? null;
    const includedSeats = wholeNumber(newPlan.includedSeats) ?? null;
    // The same function the server validates with, so the form says what the
    // server would say instead of round-tripping to find out.
    const shapeProblem = planShapeProblem({
      slug: newSlug,
      currency: PLATFORM_CATALOG_CURRENCY,
      isEnterprise: newPlan.isEnterprise,
      priceCents,
      annualPriceCents,
      includedSeats,
      pricePerSeatCents,
      interval: newPlan.interval,
    });
    if (shapeProblem) {
      toast.error(shapeProblem);
      return;
    }
    // Same function the server refuses with, so the dialog says what the server
    // would say rather than round-tripping to find out.
    const tierProblem = planTierDeclarationProblem(newSlug, newPlan.entitlementTier);
    if (tierProblem) {
      toast.error(tierProblem, { duration: 12000 });
      return;
    }
    create.mutate({
      name: newPlan.name.trim(),
      slug: newSlug,
      description: newPlan.description.trim() === "" ? null : newPlan.description.trim(),
      currency: PLATFORM_CATALOG_CURRENCY,
      isEnterprise: newPlan.isEnterprise,
      entitlementTier: newPlan.entitlementTier,
      priceCents,
      annualPriceCents,
      includedSeats,
      pricePerSeatCents,
      interval: newPlan.interval,
      aiActionsIncluded: wholeNumber(newPlan.aiActionsIncluded) ?? null,
      aiOverageCentsPerAction: wholeNumber(newPlan.aiOverageCents) ?? null,
      ...(wholeNumber(newPlan.sortOrder) !== undefined
        ? { sortOrder: wholeNumber(newPlan.sortOrder) }
        : {}),
    });
  }

  const [editing, setEditing] = useState<Plan | null>(null);
  const [form, setForm] = useState<EditForm | null>(null);

  const openEdit = (p: Plan) => {
    setEditing(p);
    setForm({
      name: p.name,
      description: p.description ?? "",
      price: p.price_cents === null ? "" : (p.price_cents / 100).toFixed(2),
      annualPrice: p.annual_price_cents === null ? "" : (p.annual_price_cents / 100).toFixed(2),
      includedSeats: p.included_seats === null ? "" : String(p.included_seats),
      pricePerSeat:
        p.price_per_seat_cents === null ? "" : (p.price_per_seat_cents / 100).toFixed(2),
      interval: p.interval === "year" ? "year" : "month",
      isActive: p.is_active,
      sortOrder: String(p.sort_order),
    });
  };

  const save = useMutation({
    mutationFn: (v: {
      planId: string;
      name?: string;
      description?: string | null;
      priceCents?: number;
      annualPriceCents?: number | null;
      includedSeats?: number | null;
      pricePerSeatCents?: number | null;
      interval?: "month" | "year";
      isActive?: boolean;
      sortOrder?: number;
    }) => updateFn({ data: v }),
    onSuccess: () => {
      toast.success("Plan updated");
      qc.invalidateQueries({ queryKey: ["platform", "plans"] });
      setEditing(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function submit() {
    if (!editing || !form) return;
    if (!form.name.trim()) {
      toast.error("Name can't be empty");
      return;
    }
    const dollars = (s: string): number | undefined => {
      if (s.trim() === "") return undefined;
      const n = Math.round(parseFloat(s) * 100);
      return Number.isFinite(n) ? n : undefined;
    };
    const price = dollars(form.price);
    const annualPrice = dollars(form.annualPrice);
    const perSeat = dollars(form.pricePerSeat);
    if (
      (price !== undefined && price < 0) ||
      (annualPrice !== undefined && annualPrice < 0) ||
      (perSeat !== undefined && perSeat < 0)
    ) {
      toast.error("Prices must be zero or more");
      return;
    }
    if (form.interval === "year" && annualPrice === undefined) {
      toast.error("Annual plans need an annual price ($/year)");
      return;
    }
    const seats = form.includedSeats.trim() === "" ? null : parseInt(form.includedSeats, 10);
    const sort = form.sortOrder.trim() === "" ? undefined : parseInt(form.sortOrder, 10);
    if (seats !== null && !Number.isFinite(seats)) {
      toast.error("Included employees must be a number");
      return;
    }
    save.mutate({
      planId: editing.id,
      name: form.name.trim(),
      description: form.description.trim() === "" ? null : form.description.trim(),
      // price_cents is ALWAYS monthly dollars; the annual base lives in
      // annual_price_cents. Annual dollars are never written into
      // price_cents/price_per_seat_cents (that corrupted MRR by 12x).
      ...(price !== undefined ? { priceCents: price } : {}),
      annualPriceCents: annualPrice ?? null,
      // Blank clears the nullable per-seat fields (matching description) —
      // omitting them would silently keep the old values.
      pricePerSeatCents: perSeat === undefined ? null : perSeat,
      includedSeats: seats,
      interval: form.interval,
      ...(sort !== undefined && Number.isFinite(sort) ? { sortOrder: sort } : {}),
      isActive: form.isActive,
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Plans</h1>
          <p className="text-sm text-muted-foreground">
            Per-employee SaaS pricing, matching houndstack.com. Each tier includes a set number of
            employees; additional active employees are billed at the per-employee overage rate.
            <strong> Customers, dogs, jobs, routes, and zones are unlimited on every plan.</strong>{" "}
            New signups start on a 14-day free trial.
          </p>
          {/* The sentence this replaces said "Stripe products/prices are
              mirrored from here once the platform Stripe key is set", which was
              true of no path in this repo: add-ons mirrored, plans never did.
              Creating one now does. Editing one still does not, and saying so is
              the whole point — a screen that overstates what it does is worse
              than one that does less. */}
          <p className="mt-2 text-sm text-muted-foreground">
            Creating a plan here also creates its Stripe product and prices, named so either Stripe
            account can answer to them. Editing an existing plan changes this catalog only — it does
            not create or re-price anything in Stripe.
          </p>
          {stripeCfg.data && !stripeCfg.data.stripeConfigured ? (
            <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
              No platform Stripe key is set on this deployment, so a new plan is saved off sale with
              no Stripe prices. Mirror it from the catalog once the key is set.
            </p>
          ) : null}
          {stripeCfg.data?.mode === "test" ? (
            <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
              The platform Stripe key is a <strong>test</strong> key: prices created here go to the
              sandbox, not to the live account.
            </p>
          ) : null}
        </div>
        {/* Editing a plan's bands here does not move anybody onto or off it —
            each org's tier was decided the last time assign_billing_tier_for_org
            ran for them. Without this, changing a band leaves every existing org
            on the tier the OLD band put them in, with nothing in the product to
            recompute it. reassignAllBillingTiers has existed for exactly this
            and had no caller; it is one of the 28 the dead-machinery detector
            has been carrying. */}
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button className="shrink-0" onClick={() => setCreating(true)}>
            <Plus className="mr-1 h-4 w-4" /> New plan
          </Button>
          <Button
            variant="outline"
            className="shrink-0"
            disabled={recompute.isPending}
            onClick={async () => {
              if (
                await confirm({
                  title: "Recompute every tenant's billing tier?",
                  description:
                    "Re-runs the tier rules against each organization's current employee count and moves any that no longer match. Run this after changing a plan's included employees or price bands — otherwise existing tenants keep the tier their old band gave them.",
                  confirmLabel: "Recompute tiers",
                })
              )
                recompute.mutate();
            }}
          >
            {recompute.isPending ? "Recomputing…" : "Recompute tiers"}
          </Button>
        </div>
      </div>
      {dialog}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Catalog</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Plan</TableHead>
                  <TableHead>Base price</TableHead>
                  <TableHead>Included employees</TableHead>
                  <TableHead>Additional employee</TableHead>
                  <TableHead>Customers</TableHead>
                  <TableHead>Stripe price</TableHead>
                  <TableHead className="text-right"><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(q.data ?? []).map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{p.name}</span>
                        {p.is_enterprise && <Badge variant="outline">Enterprise</Badge>}
                        {!p.is_active && <Badge variant="secondary">Inactive</Badge>}
                      </div>
                      {p.description ? (
                        <div className="text-xs text-muted-foreground">{p.description}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm">{formatBase(p)}</TableCell>
                    <TableCell className="text-sm">{formatSeats(p)}</TableCell>
                    <TableCell className="text-sm">{formatOverage(p)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">Unlimited</TableCell>
                    {/* A dash used to stand for three unrelated situations —
                        billed by contract, nothing to charge, and "the mirror
                        never ran" — and only the last one is a problem. */}
                    <TableCell className="text-xs">
                      {(() => {
                        const m = mirrorLabel(p);
                        return (
                          <div className="flex flex-col items-start gap-1">
                            <span
                              className={
                                m.muted
                                  ? "text-muted-foreground"
                                  : m.canMirror
                                    ? "font-medium text-amber-600 dark:text-amber-500"
                                    : "font-mono break-all"
                              }
                            >
                              {m.text}
                            </span>
                            {m.canMirror ? (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={mirror.isPending}
                                onClick={() => mirror.mutate(p)}
                              >
                                <CloudUpload className="mr-1 h-4 w-4" /> Mirror to Stripe
                              </Button>
                            ) : null}
                          </div>
                        );
                      })()}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1 whitespace-nowrap">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={setActive.isPending}
                          onClick={() => requestSetActive(p)}
                        >
                          {p.is_active ? (
                            <><EyeOff className="mr-1 h-4 w-4" /> Stop offering</>
                          ) : (
                            <><Eye className="mr-1 h-4 w-4" /> Offer again</>
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Edit ${p.name}`}
                          onClick={() => openEdit(p)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {!q.isLoading && (q.data ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
                      No plans yet.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={creating}
        onOpenChange={(o) => {
          if (!o && !create.isPending) setCreating(false);
        }}
      >
        {/* The form is taller than a phone. Without the scroll container the
            dialog is centred, clipped top and bottom, and the Save button is
            somewhere off-screen with no way to reach it. */}
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New plan</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="new-plan-name">Name</Label>
              <Input
                id="new-plan-name"
                value={newPlan.name}
                onChange={(e) => setNewPlan({ ...newPlan, name: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="new-plan-slug">Slug</Label>
              <Input
                id="new-plan-slug"
                value={newPlan.slug}
                placeholder={normalizePlanSlug(newPlan.name) || "e.g. growth"}
                onChange={(e) => setNewPlan({ ...newPlan, slug: e.target.value })}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Permanent. Its Stripe prices are named after it —{" "}
                <span className="font-mono break-all">{newSlug || "slug"}_base_monthly</span> — which
                is how the same plan is found in both the live and the sandbox account.
              </p>
              {newSlugProblem ? (
                <p className="mt-1 text-xs font-medium text-destructive">{newSlugProblem}</p>
              ) : null}
            </div>
            <div>
              <Label htmlFor="new-plan-description">Description</Label>
              <Textarea
                id="new-plan-description"
                rows={2}
                value={newPlan.description}
                onChange={(e) => setNewPlan({ ...newPlan, description: e.target.value })}
              />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm font-medium">Priced by contract</div>
                <div className="text-xs text-muted-foreground">
                  An enterprise tier: no prices here, and nothing created in Stripe.
                </div>
              </div>
              <Switch
                checked={newPlan.isEnterprise}
                onCheckedChange={(v) => setNewPlan({ ...newPlan, isEnterprise: v })}
              />
            </div>
            <div>
              <Label htmlFor="new-plan-tier">Unlocks</Label>
              <select
                id="new-plan-tier"
                value={newPlan.entitlementTier}
                onChange={(e) =>
                  setNewPlan({ ...newPlan, entitlementTier: e.target.value as PlanTier })
                }
                className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm max-md:min-h-11"
              >
                {PLAN_TIERS.map((t) => (
                  <option key={t} value={t}>
                    {TIER_NAMES[t]}
                  </option>
                ))}
              </select>
              {/* Read out of PLAN_ENTITLEMENTS rather than written here, so this
                  cannot describe a matrix the app stopped honoring. */}
              <p className="mt-1 text-xs text-muted-foreground">
                {PLAN_ENTITLEMENTS[newPlan.entitlementTier].length === 0
                  ? "The core platform, and nothing gated on top of it."
                  : `Adds ${PLAN_ENTITLEMENTS[newPlan.entitlementTier]
                      .map((e) => ENTITLEMENT_LABELS[e].toLowerCase())
                      .join(", ")}.`}{" "}
                Separate from “priced by contract” above, which is about how the plan is billed, not
                about what it includes.
              </p>
              {newTierProblem ? (
                <p className="mt-1 text-xs font-medium text-destructive">{newTierProblem}</p>
              ) : null}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="new-plan-price">Base price ($/month)</Label>
                <Input
                  id="new-plan-price"
                  type="number" step="0.01" min="0"
                  value={newPlan.price}
                  onChange={(e) => setNewPlan({ ...newPlan, price: e.target.value })}
                  disabled={newPlan.isEnterprise}
                />
              </div>
              <div>
                <Label htmlFor="new-plan-annual">Annual price ($/year)</Label>
                <Input
                  id="new-plan-annual"
                  type="number" step="0.01" min="0"
                  value={newPlan.annualPrice}
                  onChange={(e) => setNewPlan({ ...newPlan, annualPrice: e.target.value })}
                  disabled={newPlan.isEnterprise}
                />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="new-plan-seats">Included employees</Label>
                <Input
                  id="new-plan-seats"
                  type="number" step="1" min="0"
                  value={newPlan.includedSeats}
                  onChange={(e) => setNewPlan({ ...newPlan, includedSeats: e.target.value })}
                  disabled={newPlan.isEnterprise}
                />
              </div>
              <div>
                <Label htmlFor="new-plan-per-seat">Per extra employee ($/month)</Label>
                <Input
                  id="new-plan-per-seat"
                  type="number" step="0.01" min="0"
                  value={newPlan.pricePerSeat}
                  onChange={(e) => setNewPlan({ ...newPlan, pricePerSeat: e.target.value })}
                />
              </div>
            </div>
            {!newPlan.isEnterprise ? (
              <p className="text-xs text-muted-foreground">
                A plan with no included-employee count cannot be subscribed to — it shows in the
                tenant plan picker and then fails at checkout, so it is refused here instead. The
                annual per-employee price is not asked for: it is the monthly one carrying the same
                discount the annual base declares, which is how the live catalog is priced.
              </p>
            ) : null}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="new-plan-interval">Billing interval</Label>
                <select
                  id="new-plan-interval"
                  value={newPlan.interval}
                  onChange={(e) =>
                    setNewPlan({ ...newPlan, interval: e.target.value as "month" | "year" })
                  }
                  disabled={newPlan.isEnterprise}
                  className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm max-md:min-h-11 disabled:opacity-60"
                >
                  <option value="month">Monthly</option>
                  <option value="year">Annual</option>
                </select>
              </div>
              <div>
                <Label htmlFor="new-plan-sort">Sort order</Label>
                <Input
                  id="new-plan-sort"
                  type="number" step="1"
                  placeholder="after the last plan"
                  value={newPlan.sortOrder}
                  onChange={(e) => setNewPlan({ ...newPlan, sortOrder: e.target.value })}
                />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="new-plan-ai">Included AI actions / month</Label>
                <Input
                  id="new-plan-ai"
                  type="number" step="1" min="0"
                  value={newPlan.aiActionsIncluded}
                  onChange={(e) => setNewPlan({ ...newPlan, aiActionsIncluded: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="new-plan-ai-overage">AI overage (cents / action)</Label>
                <Input
                  id="new-plan-ai-overage"
                  type="number" step="1" min="0"
                  value={newPlan.aiOverageCents}
                  onChange={(e) => setNewPlan({ ...newPlan, aiOverageCents: e.target.value })}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Leaving both AI fields blank means AI use on this plan is metered and never billed.
            </p>
            {/* Currency is the one thing left that the form cannot show: platform
                MRR sums every plan's cents with no conversion. Entitlements used
                to be on this list — a slug missing from SLUG_TO_TIER resolved to
                the floor and this paragraph asked the reader to remember. It is
                a field now, and the server refuses a plan whose declaration the
                app cannot serve. */}
            <p className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
              Priced in {PLATFORM_CATALOG_CURRENCY.toUpperCase()} — the catalog is single-currency
              because platform MRR adds every plan together without converting. The plan is created{" "}
              <strong>off sale</strong>: nothing sees it and no tenant moves onto it until you use
              “Offer again”. What it unlocks is stored on the plan row (
              <span className="font-mono break-all">platform_plans.entitlement_tier</span>) and read
              from there by <span className="font-mono">plan_tier_for_org</span>.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreating(false)} disabled={create.isPending}>
              Cancel
            </Button>
            <Button
              onClick={submitCreate}
              disabled={create.isPending || !!newSlugProblem || !!newTierProblem}
            >
              {create.isPending ? "Creating…" : "Create plan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {editing?.name}</DialogTitle>
          </DialogHeader>
          {form && editing ? (
            <div className="space-y-3">
              <div>
                <Label>Name</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div>
                <Label>Description</Label>
                <Textarea
                  rows={3}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Base price ($/month)</Label>
                  <Input
                    type="number" step="0.01" min="0"
                    value={form.price}
                    onChange={(e) => setForm({ ...form, price: e.target.value })}
                    disabled={editing.is_enterprise}
                  />
                </div>
                <div>
                  <Label>Per extra employee ($/{form.interval})</Label>
                  <Input
                    type="number" step="0.01" min="0"
                    value={form.pricePerSeat}
                    onChange={(e) => setForm({ ...form, pricePerSeat: e.target.value })}
                    disabled={editing.is_enterprise}
                  />
                </div>
              </div>
              {form.interval === "year" && (
                <div>
                  <Label>Annual price ($/year)</Label>
                  <Input
                    type="number" step="0.01" min="0"
                    value={form.annualPrice}
                    onChange={(e) => setForm({ ...form, annualPrice: e.target.value })}
                    disabled={editing.is_enterprise}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    The yearly base billed to annual tenants. The monthly base price above is
                    never multiplied — MRR uses this value divided by 12.
                  </p>
                </div>
              )}
              <div>
                <Label htmlFor="plan-billing-interval">Billing interval</Label>
                <select
                  id="plan-billing-interval"
                  value={form.interval}
                  onChange={(e) =>
                    setForm({ ...form, interval: e.target.value as "month" | "year" })
                  }
                  disabled={editing.is_enterprise}
                  className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60"
                >
                  <option value="month">Monthly</option>
                  <option value="year">Annual</option>
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  Annual base prices are divided by 12 in platform MRR/ARR.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Included employees</Label>
                  <Input
                    type="number" step="1" min="0"
                    value={form.includedSeats}
                    onChange={(e) => setForm({ ...form, includedSeats: e.target.value })}
                    disabled={editing.is_enterprise}
                  />
                </div>
                <div>
                  <Label>Sort order</Label>
                  <Input
                    type="number" step="1"
                    value={form.sortOrder}
                    onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between rounded-md border px-3 py-2">
                <div>
                  <div className="text-sm font-medium">Active</div>
                  <div className="text-xs text-muted-foreground">
                    Inactive plans are hidden from signup and tenant billing.
                  </div>
                </div>
                <Switch
                  checked={form.isActive}
                  onCheckedChange={(v) => setForm({ ...form, isActive: v })}
                />
              </div>
              {/* The old wording ended by promising the price would hold "until
                  re" + "mirrored", which implied a re-pricing path. There isn't
                  one: mirroring fills EMPTY Stripe columns, it never changes a
                  price a tenant may already be subscribed to. */}
              <p className="text-xs text-muted-foreground">
                Price changes here update this catalog only. Nothing in Stripe changes — not this
                plan's prices, and not the subscriptions already on them. Re-pricing in Stripe is
                done in Stripe.
              </p>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)} disabled={save.isPending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
