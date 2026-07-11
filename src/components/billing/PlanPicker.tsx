// In-app plan selection + embedded Stripe checkout (no redirect to
// checkout.stripe.com). Used by Settings → Plan & billing and the signup
// onboarding path.
import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from "@stripe/react-stripe-js";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { listPlatformPlans, createEmbeddedBillingCheckout } from "@/lib/billing.functions";

function money(cents: number | null | undefined) {
  if (cents == null) return "—";
  return `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function PlanPicker({
  currentSlug,
  onSelect,
  selecting,
  chooseLabel = "Choose plan",
}: {
  currentSlug?: string | null;
  onSelect: (planId: string) => void;
  selecting?: boolean;
  chooseLabel?: string;
}) {
  const listFn = useServerFn(listPlatformPlans);
  const { data, isLoading } = useQuery({ queryKey: ["platform-plans"], queryFn: () => listFn() });
  const plans: any[] = ((data as any)?.plans ?? []).filter((p: any) => !p.is_free);

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading plans…</p>;
  if (!plans.length) return <p className="text-sm text-muted-foreground">No plans available yet.</p>;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {plans.map((p) => {
        const isCurrent = currentSlug && p.slug === currentSlug;
        const features: string[] = Array.isArray(p.features)
          ? p.features
          : typeof p.features === "object" && p.features
            ? Object.values(p.features as Record<string, string>)
            : [];
        return (
          <div
            key={p.id}
            className={`flex flex-col rounded-xl border bg-card p-5 ${isCurrent ? "ring-2 ring-primary" : ""}`}
          >
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">{p.name}</h3>
              {isCurrent && <Badge>Current</Badge>}
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
              disabled={!!isCurrent || selecting}
              onClick={() => onSelect(p.id)}
            >
              {isCurrent ? "Your plan" : chooseLabel}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

const stripeCache = new Map<string, Promise<StripeJs | null>>();
function getStripe(pk: string) {
  let p = stripeCache.get(pk);
  if (!p) {
    p = loadStripe(pk);
    stripeCache.set(pk, p);
  }
  return p;
}

/** Renders Stripe's embedded checkout for the chosen plan — the purchase
 *  happens right here, no redirect. */
export function EmbeddedPlanCheckout({
  planId,
  returnUrl,
  onCancel,
}: {
  planId: string;
  returnUrl: string;
  onCancel: () => void;
}) {
  const createFn = useServerFn(createEmbeddedBillingCheckout);
  const [session, setSession] = useState<{ clientSecret: string; publishableKey: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => createFn({ data: { returnUrl, planId } }),
    onSuccess: (r: any) => setSession({ clientSecret: r.clientSecret, publishableKey: r.publishableKey }),
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
  if (!session) return <p className="text-sm text-muted-foreground">Preparing secure checkout…</p>;

  return (
    <div className="space-y-2">
      <button className="text-xs text-muted-foreground underline" onClick={onCancel}>
        ← Back to plans
      </button>
      <div className="overflow-hidden rounded-lg border bg-white">
        <EmbeddedCheckoutProvider
          stripe={getStripe(session.publishableKey)}
          options={{ clientSecret: session.clientSecret }}
        >
          <EmbeddedCheckout />
        </EmbeddedCheckoutProvider>
      </div>
    </div>
  );
}
