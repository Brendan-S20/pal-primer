import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import {
  getBillingStatus,
  createBillingPortal,
  refreshBillingStatus,
  listPlatformInvoices,
  cancelBillingSubscription,
  resumeBillingSubscription,
  listSubscriptionItems,
  createPlanSubscription,
} from "@/lib/billing.functions";
import { PlanPicker, EmbeddedPlanCheckout } from "@/components/billing/PlanPicker";
import {
  listPlatformAddons,
  subscribePlatformAddon,
  cancelPlatformAddon,
} from "@/lib/platform-addons.functions";
import { Button } from "@/components/ui/button";
import { StatusChip, MetaChip, SectionLabel } from "@/components/client-detail/primitives";
import { formatDay } from "@/lib/format";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { toast } from "sonner";

// Moved into Settings (punch list #9): this is HoundStack's own subscription
// (the CRM plan), which is configuration - the tenant-facing Stripe money view
// now lives at /payments in the main sidebar.
export const Route = createFileRoute("/_authenticated/settings/billing")({
  component: BillingPage,
});

function formatUsd(cents: number | null | undefined) {
  if (cents == null) return "-";
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

// Map billing statuses onto the shared StatusChip tones.
const STATUS_CHIP: Record<string, { status: string; label: string }> = {
  free: { status: "inactive", label: "Free" },
  trialing: { status: "open", label: "Free trial" },
  active: { status: "active", label: "Active" },
  past_due: { status: "overdue", label: "Past due" },
  grace: { status: "warning", label: "Grace period" },
  canceled: { status: "canceled", label: "Canceled" },
  suspended: { status: "failed", label: "Suspended" },
};

function BillingPage() {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const statusFn = useServerFn(getBillingStatus);
  const portalFn = useServerFn(createBillingPortal);
  const refreshFn = useServerFn(refreshBillingStatus);
  const itemsFn = useServerFn(listSubscriptionItems);
  const createSubFn = useServerFn(createPlanSubscription);

  const { data, isLoading } = useQuery({
    queryKey: ["billing-status"],
    queryFn: () => statusFn(),
  });
  const { data: subInfo, isLoading: subInfoLoading } = useQuery({
    queryKey: ["billing-subscription-items"],
    queryFn: () => itemsFn(),
    enabled: !!data?.isPaidTier,
  });

  const invalidateBilling = () => {
    qc.invalidateQueries({ queryKey: ["billing-status"] });
    qc.invalidateQueries({ queryKey: ["billing-subscription-items"] });
    qc.invalidateQueries({ queryKey: ["platform-addons"] });
    qc.invalidateQueries({ queryKey: ["platform-invoices"] });
  };

  // Self-heal quietly on mount: pull the real subscription state (status,
  // period end, plan identity from the sub's metadata) from Stripe once, then
  // refetch. No spinner takeover - the cached page renders immediately.
  const didAutoRefresh = useRef(false);
  useEffect(() => {
    if (didAutoRefresh.current) return;
    didAutoRefresh.current = true;
    refreshFn()
      .then(() => invalidateBilling())
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [checkoutPlanId, setCheckoutPlanId] = useState<string | null>(null);
  const cancelFn = useServerFn(cancelBillingSubscription);
  const resumeFn = useServerFn(resumeBillingSubscription);
  const cancelSub = useMutation({
    mutationFn: () => cancelFn(),
    onSuccess: (r: any) => {
      toast.success(
        r.endsAt
          ? `Subscription will end ${formatDay(r.endsAt)}. Access continues until then`
          : "Subscription set to cancel at period end",
      );
      invalidateBilling();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const resumeSub = useMutation({
    mutationFn: () => resumeFn(),
    onSuccess: () => {
      toast.success("Subscription resumed");
      invalidateBilling();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const portal = useMutation({
    mutationFn: () => portalFn({ data: { returnUrl: window.location.href } }),
    onSuccess: (r) => {
      if (r.url) window.location.href = r.url;
      else toast.error("No portal URL returned");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const refresh = useMutation({
    mutationFn: () => refreshFn(),
    onSuccess: () => {
      invalidateBilling();
      toast.success("Billing status refreshed");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // In-place plan switch for orgs that already pay: no payment form, the
  // existing subscription is updated with proration. The selected card shows
  // "Switching…" immediately and the Current plan marker moves on success.
  const switchPlan = useMutation({
    mutationFn: (vars: { planId: string; planName: string }) =>
      createSubFn({ data: { planId: vars.planId } }),
    onSuccess: (r: any, vars) => {
      if (r.switched) {
        toast.success(`Plan switched to ${r.planName}`);
        invalidateBilling();
      } else {
        // No live subscription after all (e.g. it lapsed on Stripe's side):
        // fall into the normal payment form for the chosen plan.
        setCheckoutPlanId(vars.planId);
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const onPickPlan = async (planId: string, planName: string) => {
    if (data?.isPaidTier) {
      const ok = await confirm({
        title: `Switch to ${planName}?`,
        description:
          "The change applies right away. The price difference is prorated on your next invoice, and no new payment details are needed.",
        confirmLabel: "Switch plan",
      });
      if (ok) switchPlan.mutate({ planId, planName });
    } else {
      setCheckoutPlanId(planId);
    }
  };

  if (isLoading || !data) return <p className="text-muted-foreground">Loading…</p>;

  const chip = STATUS_CHIP[data.billingStatus] ?? { status: "inactive", label: data.billingStatus };
  const cancelPending = !!(subInfo as any)?.cancelAtPeriodEnd;
  const periodEnd = (subInfo as any)?.currentPeriodEnd ?? data.currentPeriodEnd;

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      {dialog}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Billing</h1>
          <p className="text-sm text-muted-foreground">
            Your HoundStack subscription: plan, add-ons, and invoices.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
        >
          {refresh.isPending ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {/* ── Current plan ─────────────────────────────────────────────────── */}
      <section className="rounded-xl border bg-card p-6 shadow-sm">
        <SectionLabel>Current plan</SectionLabel>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-2xl font-semibold">{data.planName}</p>
              <StatusChip status={chip.status} label={chip.label} />
              {cancelPending && <MetaChip>Cancels at period end</MetaChip>}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {data.monthlyEstimateCents != null
                ? `${formatUsd(data.monthlyEstimateCents)}/month`
                : "No charge"}
              {data.includedSeats != null && ` · Includes ${data.includedSeats} employee${data.includedSeats === 1 ? "" : "s"}`}
            </p>
            {data.isPaidTier && periodEnd && (
              <p className="mt-1 text-sm text-muted-foreground">
                {cancelPending
                  ? `Cancels ${formatDay(periodEnd)}. You keep access until then.`
                  : `Renews ${formatDay(periodEnd)}`}
              </p>
            )}
            {data.billingStatus === "trialing" && (
              <p className="mt-2 text-sm text-amber-700">
                You're on a free trial. Pick a plan below before it ends to keep full access.
              </p>
            )}
            {data.billingStatus === "past_due" && (
              <p className="mt-2 text-sm text-destructive">
                Your last payment failed. Update your payment method to keep your plan.
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-3">
            <div className="text-right">
              <p className="text-sm text-muted-foreground">Active clients</p>
              <p className="text-xl font-semibold">{data.activeClientCount}</p>
            </div>
            {data.isPaidTier && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => portal.mutate()}
                disabled={portal.isPending}
              >
                {portal.isPending ? "Opening…" : "Update payment method"}
              </Button>
            )}
          </div>
        </div>
      </section>

      {/* ── Plans ────────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">
            {data.isPaidTier ? "Plans" : "Choose a plan"}
          </h2>
          <p className="text-sm text-muted-foreground">
            Unlimited customers, dogs, jobs, routes, and zones on every tier. You're billed per
            employee.
            {data.isPaidTier && " Switching is instant and prorated. No new card details needed."}
          </p>
        </div>
        {checkoutPlanId ? (
          <EmbeddedPlanCheckout
            planId={checkoutPlanId}
            returnUrl={
              typeof window !== "undefined"
                ? window.location.href.split("?")[0]
                : "https://app.houndstack.com/settings/billing"
            }
            onCancel={() => setCheckoutPlanId(null)}
            onSwitched={() => {
              setCheckoutPlanId(null);
              invalidateBilling();
            }}
          />
        ) : (
          <PlanPicker
            currentSlug={data.planSlug}
            onSelect={onPickPlan}
            switchingPlanId={switchPlan.isPending ? switchPlan.variables?.planId : null}
            chooseLabel={data.isPaidTier ? "Switch to this plan" : "Choose plan"}
          />
        )}
      </section>

      <PlatformAddonsSection />

      {data.isPaidTier && (
        <NextInvoice subInfo={subInfo as any} isLoading={subInfoLoading} />
      )}

      <InvoiceHistory />

      {/* ── Manage ───────────────────────────────────────────────────────── */}
      {data.isPaidTier && (
        <section className="rounded-xl border bg-card p-6 shadow-sm">
          <h2 className="text-lg font-semibold">Manage subscription</h2>
          {cancelPending ? (
            <>
              <p className="mt-1 text-sm text-muted-foreground">
                Your subscription is set to cancel
                {periodEnd ? ` on ${formatDay(periodEnd)}` : " at the end of the paid period"}.
                Resume it to keep your plan.
              </p>
              <Button
                className="mt-3"
                variant="outline"
                onClick={() => resumeSub.mutate()}
                disabled={resumeSub.isPending}
              >
                {resumeSub.isPending ? "Resuming…" : "Resume subscription"}
              </Button>
            </>
          ) : (
            <>
              <p className="mt-1 text-sm text-muted-foreground">
                Canceling stops future charges. You keep access until the end of the paid period.
              </p>
              <Button
                className="mt-3"
                variant="outline"
                onClick={async () => {
                  if (
                    await confirm({
                      title: "Cancel your subscription?",
                      description: "You keep access until the end of the paid period.",
                      destructive: true,
                      confirmLabel: "Cancel subscription",
                    })
                  ) {
                    cancelSub.mutate();
                  }
                }}
                disabled={cancelSub.isPending}
              >
                {cancelSub.isPending ? "Canceling…" : "Cancel subscription"}
              </Button>
            </>
          )}
        </section>
      )}
    </div>
  );
}

// Platform -> tenant software add-ons (the upsell shelf): bolt-ons like the
// AI Receptionist that attach to the org's existing plan subscription as a
// Stripe subscription item and flip the matching feature on.
function PlatformAddonsSection() {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const listFn = useServerFn(listPlatformAddons);
  const subFn = useServerFn(subscribePlatformAddon);
  const cancelFn = useServerFn(cancelPlatformAddon);
  const { data, isLoading } = useQuery({
    queryKey: ["platform-addons"],
    queryFn: () => listFn(),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["platform-addons"] });
    qc.invalidateQueries({ queryKey: ["billing-subscription-items"] });
  };
  const subscribe = useMutation({
    mutationFn: (addonId: string) => subFn({ data: { addonId } }),
    onSuccess: () => {
      toast.success("Add-on added to your subscription");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const cancel = useMutation({
    mutationFn: (addonId: string) => cancelFn({ data: { addonId } }),
    onSuccess: () => {
      toast.success("Add-on removed");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const addingId = subscribe.isPending ? (subscribe.variables as string) : null;
  const removingId = cancel.isPending ? (cancel.variables as string) : null;

  const addons = data?.addons ?? [];
  if (!isLoading && !addons.length) return null;

  return (
    <section className="space-y-3">
      {dialog}
      <div>
        <h2 className="text-lg font-semibold">Add-ons</h2>
        <p className="text-sm text-muted-foreground">
          Optional extras that bolt onto your plan and show up on the same invoice.
        </p>
      </div>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {addons.map((a) => (
            <div
              key={a.id}
              className={`flex flex-col rounded-xl border bg-card p-4 shadow-sm ${
                a.subscribed ? "border-primary/50 bg-primary/5" : ""
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{a.name}</p>
                  {a.subscribed && (
                    <StatusChip
                      status={a.billing_interval === "one_time" ? "paid" : "active"}
                      label={a.billing_interval === "one_time" ? "Purchased" : "Active"}
                    />
                  )}
                </div>
                <p className="whitespace-nowrap text-sm font-semibold">
                  {formatUsd(a.price_cents)}
                  <span className="font-normal text-muted-foreground">
                    {a.billing_interval === "one_time" ? " one time" : `/${a.billing_interval}`}
                  </span>
                </p>
              </div>
              {a.description && (
                <p className="mt-1 flex-1 text-sm text-muted-foreground">{a.description}</p>
              )}
              <div className="mt-3">
                {a.subscribed && a.billing_interval === "one_time" ? null : a.subscribed ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={removingId === a.id}
                    onClick={async () => {
                      if (
                        await confirm({
                          title: `Remove ${a.name} from your subscription?`,
                          destructive: true,
                          confirmLabel: "Remove add-on",
                        })
                      )
                        cancel.mutate(a.id);
                    }}
                  >
                    {removingId === a.id ? "Removing…" : "Remove from plan"}
                  </Button>
                ) : data?.canSubscribe ? (
                  <Button
                    size="sm"
                    disabled={addingId === a.id}
                    onClick={async () => {
                      if (
                        a.billing_interval !== "one_time" ||
                        (await confirm({
                          title: `Purchase ${a.name}?`,
                          description: `${a.name} is a one-time ${formatUsd(a.price_cents)} charge on your next invoice.`,
                          confirmLabel: "Purchase",
                        }))
                      ) {
                        subscribe.mutate(a.id);
                      }
                    }}
                  >
                    {addingId === a.id
                      ? "Adding…"
                      : a.billing_interval === "one_time"
                        ? "Purchase"
                        : "Add to my plan"}
                  </Button>
                ) : (
                  <Button size="sm" disabled title="Add-ons attach to an active paid subscription">
                    Requires an active plan
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// Upcoming-invoice style breakdown of the Stripe subscription: the plan line,
// seat overage as "Extra employees", and any bolt-on add-ons, with a monthly
// total. No portal trip needed to see the full bill.
function NextInvoice({
  subInfo,
  isLoading,
}: {
  subInfo:
    | {
        items: Array<{
          id: string;
          kind: "base" | "seat" | "addon";
          name: string;
          description: string | null;
          quantity: number;
          unitAmountCents: number | null;
          currency: string;
          interval: string | null;
          intervalCount: number;
        }>;
        currentPeriodEnd: string | null;
      }
    | undefined;
  isLoading: boolean;
}) {
  const items = subInfo?.items ?? [];
  const ordered = [
    ...items.filter((i) => i.kind === "base"),
    ...items.filter((i) => i.kind === "seat"),
    ...items.filter((i) => i.kind === "addon"),
  ];
  const monthlyTotal = items.reduce(
    (sum, i) =>
      i.unitAmountCents != null && i.interval === "month" && i.intervalCount === 1
        ? sum + i.unitAmountCents * (i.quantity ?? 1)
        : sum,
    0,
  );
  const allMonthly = items.every((i) => i.interval === "month" && i.intervalCount === 1);

  const lineLabel = (i: (typeof items)[number]) => {
    if (i.kind === "seat") {
      return `Extra employees (${i.quantity} × ${formatUsd(i.unitAmountCents)})`;
    }
    return i.name;
  };
  const lineAmount = (i: (typeof items)[number]) => {
    if (i.unitAmountCents == null) return "-";
    const total = formatUsd(i.unitAmountCents * (i.quantity ?? 1));
    const interval = i.interval
      ? `/${i.intervalCount > 1 ? `${i.intervalCount} ` : ""}${i.interval === "month" ? "mo" : i.interval}`
      : "";
    return `${total}${interval}`;
  };

  return (
    <section className="rounded-xl border bg-card p-6 shadow-sm">
      <h2 className="text-lg font-semibold">Your next invoice</h2>
      {subInfo?.currentPeriodEnd && (
        <p className="text-sm text-muted-foreground">Bills {formatDay(subInfo.currentPeriodEnd)}</p>
      )}
      {isLoading ? (
        <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
      ) : ordered.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">No subscription line items to show.</p>
      ) : (
        <>
          <ul className="mt-3 divide-y">
            {ordered.map((i) => (
              <li key={i.id} className="flex flex-wrap items-start justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{lineLabel(i)}</p>
                    {i.kind === "base" && <MetaChip>Plan</MetaChip>}
                    {i.kind === "addon" && <MetaChip>Add-on</MetaChip>}
                  </div>
                  {i.kind !== "seat" && i.description && (
                    <p className="text-xs text-muted-foreground">{i.description}</p>
                  )}
                </div>
                <p className="whitespace-nowrap text-right text-sm">{lineAmount(i)}</p>
              </li>
            ))}
          </ul>
          <div className="mt-1 flex items-center justify-between border-t pt-3">
            <p className="text-sm font-semibold">{allMonthly ? "Monthly total" : "Monthly total (excludes yearly items)"}</p>
            <p className="text-sm font-semibold">{formatUsd(monthlyTotal)}/mo</p>
          </div>
        </>
      )}
    </section>
  );
}

// In-app billing history (punch list #10) - no portal round-trip needed just
// to see or download an invoice.
function InvoiceHistory() {
  const listFn = useServerFn(listPlatformInvoices);
  const { data, isLoading } = useQuery({
    queryKey: ["platform-invoices"],
    queryFn: () => listFn(),
  });
  const invoices: any[] = (data as any)?.invoices ?? [];

  return (
    <section className="rounded-xl border bg-card p-6 shadow-sm">
      <h2 className="text-lg font-semibold">Billing history</h2>
      {isLoading ? (
        <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
      ) : invoices.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No invoices yet. Your subscription invoices will appear here once you're billed.
        </p>
      ) : (
        <table className="mt-3 w-full text-sm">
          <thead className="text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="py-1.5">Invoice</th>
              <th className="py-1.5">Period</th>
              <th className="py-1.5">Amount</th>
              <th className="py-1.5">Status</th>
              <th className="py-1.5 text-right">Links</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {invoices.map((inv) => (
              <tr key={inv.stripe_invoice_id}>
                <td className="py-2 font-medium">{inv.number ?? inv.stripe_invoice_id.slice(0, 12)}</td>
                <td className="py-2 text-muted-foreground">
                  {inv.period_start ? formatDay(inv.period_start) : "-"}
                  {inv.period_end ? ` to ${formatDay(inv.period_end)}` : ""}
                </td>
                <td className="py-2">{formatUsd(inv.amount_due_cents)}</td>
                <td className="py-2">
                  <StatusChip status={inv.status === "open" ? "open" : inv.status} />
                </td>
                <td className="py-2 text-right">
                  {inv.hosted_invoice_url && (
                    <a href={inv.hosted_invoice_url} target="_blank" rel="noreferrer" className="text-primary underline">View</a>
                  )}
                  {inv.invoice_pdf && (
                    <a href={inv.invoice_pdf} target="_blank" rel="noreferrer" className="ml-3 text-primary underline">PDF</a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
