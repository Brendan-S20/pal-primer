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
import { toast } from "sonner";
import { stripeAppearance } from "@/lib/stripe-appearance";
import {
  listPlatformPlans,
  createPlanSubscription,
  refreshBillingStatus,
} from "@/lib/billing.functions";

function money(cents: number | null | undefined) {
  if (cents == null) return "-";
  return `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function PlanPicker({
  currentSlug,
  onSelect,
  selecting,
  switchingPlanId,
  chooseLabel = "Choose plan",
}: {
  currentSlug?: string | null;
  onSelect: (planId: string, planName: string) => void;
  selecting?: boolean;
  /** Plan currently being switched to (in-place switch in flight): its card
   *  highlights and its button reads "Switching…" so the click visibly lands. */
  switchingPlanId?: string | null;
  chooseLabel?: string;
}) {
  const listFn = useServerFn(listPlatformPlans);
  const { data, isLoading } = useQuery({ queryKey: ["platform-plans"], queryFn: () => listFn() });
  const plans: any[] = ((data as any)?.plans ?? []).filter((p: any) => !p.is_free);

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading plans…</p>;
  if (!plans.length) return <p className="text-sm text-muted-foreground">No plans available yet.</p>;

  const busy = !!selecting || !!switchingPlanId;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {plans.map((p) => {
        const isCurrent = !!currentSlug && p.slug === currentSlug;
        const isSwitching = switchingPlanId === p.id;
        const features: string[] = Array.isArray(p.features)
          ? p.features
          : typeof p.features === "object" && p.features
            ? Object.values(p.features as Record<string, string>)
            : [];
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
            <div className="mt-2">
              <span className="text-3xl font-bold">{money(p.price_cents)}</span>
              <span className="text-sm text-muted-foreground">/{p.interval ?? "month"}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Includes {p.included_seats} employee{p.included_seats === 1 ? "" : "s"}
              {p.price_per_seat_cents ? ` · ${money(p.price_per_seat_cents)}/extra` : ""}
            </p>
            {p.description && <p className="mt-2 text-sm text-muted-foreground">{p.description}</p>}
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
              onClick={() => onSelect(p.id, p.name)}
            >
              {isCurrent ? "Current plan" : isSwitching ? "Switching…" : chooseLabel}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

// Platform-account Stripe.js, cached at module scope (no stripeAccount —
// the org's SaaS plan bills on the platform account, not a Connect account).
const stripeCache = new Map<string, Promise<StripeJs | null>>();
function getStripe(pk: string) {
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
export function EmbeddedPlanCheckout({
  planId,
  returnUrl,
  onCancel,
  onSwitched,
}: {
  planId: string;
  returnUrl: string;
  onCancel: () => void;
  /** Called when the server switched an EXISTING subscription in place —
   *  no payment form is needed (the sub already has a card on file). */
  onSwitched?: (planName: string) => void;
}) {
  const createFn = useServerFn(createPlanSubscription);
  const refreshFn = useServerFn(refreshBillingStatus);
  const [session, setSession] = useState<{
    clientSecret: string;
    publishableKey: string;
    planName: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => createFn({ data: { planId } }),
    onSuccess: async (r: any) => {
      if (r.switched) {
        // In-place plan switch: already billed via proration, nothing to pay
        // here. Sync status and hand control back to the caller.
        await refreshFn().catch(() => {});
        toast.success(`Plan switched to ${r.planName}`);
        if (onSwitched) onSwitched(r.planName);
        else onCancel();
        return;
      }
      setSession({ clientSecret: r.clientSecret, publishableKey: r.publishableKey, planName: r.planName });
    },
    onError: (e: Error) => { setError(e.message); toast.error(e.message); },
  });

  // Kick off once per chosen plan.
  useEffect(() => {
    setSession(null);
    setError(null);
    create.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId]);

  if (error) {
    return (
      <div className="space-y-3 rounded-lg border bg-card p-4">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={onCancel}>Back to plans</Button>
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
        <p className="mt-1 text-xs text-muted-foreground">
          You'll be charged now and then monthly. Cancel anytime in Settings → Plan &amp; billing.
        </p>
        <div className="mt-4">
          <Elements
            stripe={getStripe(session.publishableKey)}
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
      // Paid without a redirect: pull the fresh status from Stripe so the org
      // flips active immediately (no webhook race), then run the same return
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
