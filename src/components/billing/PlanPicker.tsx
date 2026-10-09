// In-app plan selection + inline Stripe Payment Element (no redirect to
// checkout.stripe.com and no embedded Checkout iframe). Used by Settings →
// Plan & billing and the signup onboarding path.
import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MetaChip } from "@/components/client-detail/primitives";
import { toast } from "sonner";
import { stripeAppearance } from "@/lib/stripe-appearance";
import { saasPurchaseAllowed, BILLING_MANAGED_OUTSIDE_APP } from "@/lib/app-store-billing";
import { platform } from "@/lib/native";
import { ACTIVE_EMPLOYEE_DEFINITION } from "@/lib/seat-rule";
import {
  listPlatformPlans,
  createPlanSubscription,
  type PromoDropReason,
  refreshBillingStatus,
} from "@/lib/billing.functions";

export type BillingInterval = "month" | "year";

// Whole dollars for plan prices, which is what this was for — but NOT at the
// cost of printing a real price as $0. maximumFractionDigits: 0 rendered the
// 10c per-action price as "$0", directly above the Payment Element, under copy
// reading "actions past that are $0 each". 1,200 actions is $120.00.
// So: no decimals when the amount is whole dollars, two when it is not.
function money(cents: number | null | undefined) {
  if (cents == null) return "-";
  const dollars = cents / 100;
  const whole = Number.isInteger(dollars);
  return `$${dollars.toLocaleString(undefined, {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  })}`;
}

// Up to two decimals, for effective per-month amounts like $82.50.
function moneyExact(cents: number) {
  return `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/**
 * The gate, at the COMPONENT rather than at each route.
 *
 * ── WHY IT MOVED HERE ─────────────────────────────────────────────────────
 *
 * It used to live on /settings/billing only, as `canBuySaas &&` around each
 * purchase surface. That is correct for the route it is written on and it
 * protects nothing else — and on 2026-08-23 a scan for other importers found
 * `/onboarding` rendering a full PlanPicker under the heading "Pick the plan
 * that fits your crew" and the line "Payment happens right here. You won't
 * leave the app." No gate anywhere in that file. A new org lands on it.
 *
 * A per-route gate is a promise every future route has to remember to keep.
 * A component that refuses to render a purchase inside a store build keeps it
 * for them. The route-level guards stay as well: they also remove the
 * surrounding headings and cards, which this cannot see.
 */
function StoreBuildNote() {
  return (
    <div className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
      {BILLING_MANAGED_OUTSIDE_APP}
    </div>
  );
}

export function PlanPicker({
  currentSlug,
  currentInterval,
  onSelect,
  selecting,
  switchingPlanId,
  chooseLabel = "Choose plan",
}: {
  currentSlug?: string | null;
  /** The org's live billing interval (from the subscription's plan item);
   *  the Monthly | Annual toggle defaults to it. */
  currentInterval?: BillingInterval | null;
  onSelect: (planId: string, planName: string, interval: BillingInterval) => void;
  selecting?: boolean;
  /** Plan currently being switched to (in-place switch in flight): its card
   *  highlights and its button reads "Switching…" so the click visibly lands. */
  switchingPlanId?: string | null;
  chooseLabel?: string;
}) {

  // Whether a store build may purchase never changes while the app runs,
  // which is the only reason the early return that used to sit ABOVE these
  // hooks never crashed: the hook order was conditional in the code and
  // constant at runtime. That is still the exact shape rules-of-hooks
  // exists to forbid — the same placement with a condition that CAN flip
  // took down /clients/:id on 2026-09-26 — so the guard now waits its turn
  // below the hooks, and the query is gated instead of skipped-by-crash.
  const purchaseAllowed = saasPurchaseAllowed(platform());

  const listFn = useServerFn(listPlatformPlans);
  const { data, isLoading } = useQuery({
    queryKey: ["platform-plans"],
    queryFn: () => listFn(),
    // A store build renders the note, never a purchase — and fetches nothing.
    enabled: purchaseAllowed,
  });
  const plans: any[] = ((data as any)?.plans ?? []).filter((p: any) => !p.is_free);

  const [billingInterval, setBillingInterval] = useState<BillingInterval>(
    currentInterval ?? "month",
  );
  // The current interval loads async (it comes off the live subscription):
  // snap the toggle to it once known, unless the user already toggled.
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (currentInterval && !touched) setBillingInterval(currentInterval);
  }, [currentInterval, touched]);

  // A store build renders the note, never a purchase. See StoreBuildNote.
  if (!purchaseAllowed) return <StoreBuildNote />;

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading plans…</p>;
  if (!plans.length)
    return <p className="text-sm text-muted-foreground">No plans available yet.</p>;

  const busy = !!selecting || !!switchingPlanId;
  const anyAnnual = plans.some((p) => p.annual_price_cents != null);

  const toggleButton = (value: BillingInterval, label: string) => (
    <button
      type="button"
      aria-pressed={billingInterval === value}
      onClick={() => {
        setTouched(true);
        setBillingInterval(value);
      }}
      // 44px on touch, unchanged density on desktop. This measured 32px tall,
      // on the billing page, on a phone — the control that chooses whether the
      // customer is billed monthly or yearly. Found the first time
      // /settings/billing was put through the viewport sweep, which is the
      // point: the page had never been measured at 360px.
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors max-md:flex touch:min-h-11 max-md:flex-1 max-md:items-center max-md:justify-center ${
        billingInterval === value
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-4">
      {anyAnnual && (
        <div className="flex items-center gap-3 max-md:flex-col max-md:items-stretch max-md:gap-2">
          <div
            role="group"
            aria-label="Billing interval"
            className="inline-flex items-center rounded-lg border bg-muted p-0.5 max-md:flex max-md:w-full"
          >
            {toggleButton("month", "Monthly")}
            {toggleButton("year", "Annual")}
          </div>
          {billingInterval === "year" && (
            <span className="text-xs text-muted-foreground">Pay for 10 months, get 12.</span>
          )}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {plans.map((p) => {
          // A plan without an annual price stays monthly even in annual view.
          const cardInterval: BillingInterval =
            billingInterval === "year" && p.annual_price_cents != null ? "year" : "month";
          const isAnnualCard = cardInterval === "year";
          const isCurrent =
            !!currentSlug &&
            p.slug === currentSlug &&
            (currentInterval ?? "month") === cardInterval;
          const isSamePlanOtherInterval =
            !!currentSlug && p.slug === currentSlug && !isCurrent && !!currentInterval;
          const isSwitching = switchingPlanId === p.id;
          const features: string[] = Array.isArray(p.features)
            ? p.features
            : typeof p.features === "object" && p.features
              ? Object.values(p.features as Record<string, string>)
              : [];
          const priceCents = isAnnualCard ? p.annual_price_cents : p.price_cents;
          return (
            <div
              key={p.id}
              className={`relative flex flex-col rounded-xl border bg-card p-5 shadow-sm transition-shadow ${
                isCurrent
                  ? "border-primary/50 bg-primary/5"
                  : isSwitching
                    ? "border-primary ring-2 ring-primary"
                    : ""
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold">{p.name}</h3>
                {isCurrent && <Badge>Current plan</Badge>}
              </div>
              <div className="mt-2 flex flex-wrap items-baseline gap-2">
                <span>
                  <span className="text-3xl font-bold">{money(priceCents)}</span>
                  <span className="text-sm text-muted-foreground">
                    /{isAnnualCard ? "year" : "month"}
                  </span>
                </span>
                {isAnnualCard && <MetaChip>2 months free</MetaChip>}
              </div>
              {isAnnualCard && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {moneyExact(Math.round(p.annual_price_cents / 12))}/mo billed annually
                </p>
              )}
              {/* The AI allowance used to sit here too, beside the employee one,
                  as a reason to buy up. Removed 2026-10-03: churn, pricing, the
                  digests and review replies stopped using AI, marketing posts
                  are not live, and the receptionist is its own add-on, so the
                  card was selling an allowance a new plan had almost nothing to
                  spend on. The charge itself is still disclosed where the money
                  is decided, in the paragraph above the card field below. */}
              <p className="mt-1 text-xs text-muted-foreground">
                Includes {p.included_seats} active employee{p.included_seats === 1 ? "" : "s"}
                {p.price_per_seat_cents
                  ? isAnnualCard
                    ? ` · ${money(p.price_per_seat_cents * 10)}/yr per extra`
                    : ` · ${money(p.price_per_seat_cents)}/extra`
                  : ""}
              </p>
              {p.description && (
                <p className="mt-2 text-sm text-muted-foreground">{p.description}</p>
              )}
              {features.length > 0 && (
                <ul className="mt-3 space-y-1.5 text-sm">
                  {features.slice(0, 6).map((f, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                      <span>{String(f)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex-1" />
              <Button
                className="mt-4"
                variant={isCurrent ? "outline" : "default"}
                disabled={isCurrent || busy}
                onClick={() => onSelect(p.id, p.name, cardInterval)}
              >
                {isCurrent
                  ? "Current plan"
                  : isSwitching
                    ? "Switching…"
                    : isSamePlanOtherInterval
                      ? `Switch to ${isAnnualCard ? "annual" : "monthly"} billing`
                      : chooseLabel}
              </Button>
            </div>
          );
        })}
      </div>
      {/* What "active employee" means on the cards above. The owner's rule
          (2026-10-09), in the one sentence seat-rule.ts keeps for every
          screen that talks about seats. */}
      <p className="text-xs text-muted-foreground">
        {ACTIVE_EMPLOYEE_DEFINITION} Anyone on your team who didn&apos;t use it costs nothing.
      </p>
    </div>
  );
}

// Platform-account Stripe.js, cached at module scope (no stripeAccount —
// the org's SaaS plan bills on the platform account, not a Connect account).
// Exported so the Billing settings page's payment-methods panel reuses the
// same cached instance.
const stripeCache = new Map<string, Promise<StripeJs | null>>();
export function getPlatformStripe(pk: string) {
  let p = stripeCache.get(pk);
  if (!p) {
    p = loadStripe(pk);
    stripeCache.set(pk, p);
  }
  return p;
}

function withUpgradedFlag(url: string) {
  return `${url}${url.includes("?") ? "&" : "?"}upgraded=1`;
}

/** Inline plan purchase via the Payment Element — the subscription is created
 *  server-side (default_incomplete) and paid for right here, no Checkout. */
/**
 * What to tell somebody whose signup promo code produced no discount.
 *
 * Split by reason because the right next step differs, and a single "your code
 * did not apply" would send all four to support including the one they can fix
 * themselves. `invalid` carries the server's own sentence, which is already
 * written for a person and says which of expired / deactivated / fully
 * redeemed it was.
 */
function promoDropMessage(d: { code: string; reason: PromoDropReason; detail?: string }): string {
  const named = d.code ? `Promo code ${d.code}` : "Your promo code";
  switch (d.reason) {
    case "wrong_plan":
      return `${named} does not apply to this plan, so this price has no discount in it. It may apply to a different plan.`;
    case "invalid":
      return `${named} was not applied. ${d.detail ?? "That code is no longer valid."} Contact us before paying if you were promised a discount.`;
    case "not_in_stripe":
      return `${named} could not be applied, which is a problem on our side. Contact us before paying rather than re-entering it.`;
    case "lookup_failed":
      return `${named} could not be checked just now, so this price has no discount in it. Contact us before paying if you were expecting one.`;
  }
}

export function EmbeddedPlanCheckout({
  planId,
  interval = "month",
  returnUrl,
  onCancel,
  onSwitched,
}: {
  planId: string;
  interval?: BillingInterval;
  returnUrl: string;
  onCancel: () => void;
  /** Called when the server switched an EXISTING subscription in place —
   *  no payment form is needed (the sub already has a card on file). */
  onSwitched?: (planName: string) => void;
}) {
  // Same restructure as PlanPicker above: the store-build guard used to
  // early-return ahead of every hook here, which rules-of-hooks forbids.
  // Constant at runtime, so it never fired — but the kickoff effect below
  // auto-creates a checkout session on mount, so the flag must gate that
  // effect as well as the render, or moving the guard would have a store
  // build minting Stripe sessions it can never use.
  const purchaseAllowed = saasPurchaseAllowed(platform());
  const createFn = useServerFn(createPlanSubscription);
  const refreshFn = useServerFn(refreshBillingStatus);
  const [session, setSession] = useState<{
    clientSecret: string;
    publishableKey: string;
    planName: string;
    // The metered charges, so the paragraph above the card can name them.
    // Nullable throughout: Enterprise negotiates its allowance and carries
    // null in the catalog, and a clause is dropped rather than guessed.
    includedSeats: number | null;
    aiActionsIncluded: number | null;
    aiOverageCentsPerAction: number | null;
    seatOverageCents: number | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => createFn({ data: { planId, interval } }),
    onSuccess: async (r: any) => {
      if (r.switched) {
        // In-place plan switch: already billed via proration, nothing to pay
        // here. Sync status and hand control back to the caller.
        await refreshFn().catch(() => {});
        if (r.chargeFailed) {
          toast.warning(
            "Plan switched. We couldn't charge the difference automatically; it will be retried.",
          );
        } else {
          toast.success(`Plan switched to ${r.planName}`);
        }
        if (onSwitched) onSwitched(r.planName);
        else onCancel();
        return;
      }
      // BEFORE THE CARD FORM, NOT AFTER THE CHARGE.
      //
      // An owner typed a code on Get-started and is about to be billed full
      // price. The whole value of saying so is that it arrives while they can
      // still stop, so this runs ahead of setSession and holds for 15s rather
      // than the default toast life. Nothing is blocked: a dead code must not
      // stand between somebody and paying us, which is why the server applies
      // no discount instead of refusing.
      if (r.promoDropped) {
        toast.warning(promoDropMessage(r.promoDropped), { duration: 15000 });
      }
      setSession({
        clientSecret: r.clientSecret,
        publishableKey: r.publishableKey,
        planName: r.planName,
        includedSeats: r.includedSeats ?? null,
        aiActionsIncluded: r.aiActionsIncluded ?? null,
        aiOverageCentsPerAction: r.aiOverageCentsPerAction ?? null,
        seatOverageCents: r.seatOverageCents ?? null,
      });
    },
    onError: (e: Error) => {
      setError(e.message);
      toast.error(e.message);
    },
  });

  // Kick off once per chosen plan + interval.
  useEffect(() => {
    if (!purchaseAllowed) return;
    setSession(null);
    setError(null);
    create.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId, interval]);

  // A store build renders the note, never a purchase. See StoreBuildNote.
  if (!purchaseAllowed) return <StoreBuildNote />;

  if (error) {
    return (
      <div className="space-y-3 rounded-lg border bg-card p-4">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={onCancel}>
          Back to plans
        </Button>
      </div>
    );
  }
  if (!session) return <p className="text-sm text-muted-foreground">Preparing secure payment…</p>;

  return (
    <div className="space-y-2">
      <button className="text-xs text-muted-foreground underline" onClick={onCancel}>
        ← Back to plans
      </button>
      <div className="rounded-lg border bg-card p-5">
        <h3 className="font-semibold">Subscribe to {session.planName}</h3>
        {/* The metered charges are named HERE, at the card, and not only on the
            pricing page. There is no Stripe-hosted checkout in this flow — the
            card is taken inline through a Payment Element — so this paragraph is
            the last thing a buyer reads before being charged, and it used to
            mention neither the AI overage nor the per-employee one. Both arrive
            on a later invoice, so nothing else in the flow would reveal them.
            Each clause is suppressed when the plan does not carry that charge,
            so Enterprise (negotiated allowances, null in the catalog) says
            nothing rather than "null AI actions". */}
        <p className="mt-1 text-xs text-muted-foreground">
          You'll be charged now and then {interval === "year" ? "yearly" : "monthly"}.
          {session.aiActionsIncluded != null && session.aiOverageCentsPerAction != null ? (
            <>
              {" "}
              Once the AI receptionist launches, its use is metered: this plan includes{" "}
              {session.aiActionsIncluded.toLocaleString()} actions a month, and actions past that
              are {money(session.aiOverageCentsPerAction)} each.
            </>
          ) : null}
          {session.includedSeats != null && session.seatOverageCents ? (
            <>
              {" "}
              {session.aiActionsIncluded != null ? "Active employees past " : "This plan includes "}
              {session.aiActionsIncluded != null
                ? `the first ${session.includedSeats}`
                : `${session.includedSeats} active employees; each extra`}{" "}
              {session.aiActionsIncluded != null ? "are" : "is"} {money(session.seatOverageCents)}{" "}
              each a month. {ACTIVE_EMPLOYEE_DEFINITION}
            </>
          ) : null}{" "}
          Both are billed on your next invoice. Cancel anytime in Settings → Plan &amp; billing.
          Payments are processed securely.
        </p>
        <div className="mt-4">
          <Elements
            stripe={getPlatformStripe(session.publishableKey)}
            options={{ clientSecret: session.clientSecret, appearance: stripeAppearance() }}
          >
            <PlanPaymentForm planName={session.planName} returnUrl={returnUrl} />
          </Elements>
        </div>
      </div>
    </div>
  );
}

function PlanPaymentForm({ planName, returnUrl }: { planName: string; returnUrl: string }) {
  const stripe = useStripe();
  const elements = useElements();
  const refreshFn = useServerFn(refreshBillingStatus);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true);
    try {
      const { error: submitError } = await elements.submit();
      if (submitError) {
        toast.error(submitError.message ?? "Please check your payment details");
        return;
      }
      const { error } = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: withUpgradedFlag(returnUrl) },
        redirect: "if_required",
      });
      if (error) {
        toast.error(error.message ?? "Payment didn't go through");
        return;
      }
      // Paid without a redirect: pull the fresh status so the org flips
      // active immediately (no webhook race), then run the same return
      // path a redirect would have used.
      await refreshFn().catch(() => {});
      toast.success(`You're on ${planName}`);
      window.location.assign(withUpgradedFlag(returnUrl));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <PaymentElement />
      <Button type="submit" className="w-full" disabled={busy || !stripe}>
        {busy ? "Processing…" : "Subscribe"}
      </Button>
    </form>
  );
}
