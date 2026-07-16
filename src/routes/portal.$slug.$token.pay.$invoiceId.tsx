import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from "@stripe/react-stripe-js";
import { Loader2, ArrowLeft, ShieldCheck } from "lucide-react";
import { portalCreateEmbeddedCheckout } from "@/lib/portal.functions";
import { money } from "@/lib/portal-ui";

export const Route = createFileRoute("/portal/$slug/$token/pay/$invoiceId")({
  head: () => ({ meta: [{ title: "Pay invoice" }] }),
  component: PayInvoice,
});

// Cache the Stripe.js instance per (publishable key + connected account),
// module-scoped, not per render. Connect direct charges require embedded
// Checkout to be initialized scoped to the org's connected account.
const stripePromiseCache = new Map<string, Promise<StripeJs | null>>();
function getStripe(pk: string, stripeAccount?: string) {
  const cacheKey = `${pk}|${stripeAccount ?? ""}`;
  let p = stripePromiseCache.get(cacheKey);
  if (!p) {
    p = loadStripe(pk, stripeAccount ? { stripeAccount } : undefined);
    stripePromiseCache.set(cacheKey, p);
  }
  return p;
}

function PayInvoice() {
  const { slug, token, invoiceId } = Route.useParams();
  const createSession = useServerFn(portalCreateEmbeddedCheckout);

  // In-app payment: embedded Stripe Checkout rendered right on this page.
  // On completion Stripe sends the client back to the billing tab (?paid=1),
  // where the invoice list reconciles against Stripe.
  const sessionQ = useQuery({
    queryKey: ["portal-embedded-checkout", token, invoiceId],
    queryFn: () =>
      createSession({
        data: {
          token,
          invoiceId,
          returnUrl: `${window.location.origin}/portal/${slug}/${token}/billing`,
        },
      }),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const stripePromise = useMemo(
    () => (sessionQ.data ? getStripe(sessionQ.data.publishableKey, sessionQ.data.stripeAccount) : null),
    [sessionQ.data?.publishableKey, sessionQ.data?.stripeAccount],
  );

  return (
    <div className="mx-auto max-w-lg space-y-4 p-4">
      <Link
        to="/portal/$slug/$token/billing"
        params={{ slug, token }}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back to billing
      </Link>

      <div className="rounded-md border bg-card p-4">
        <h1 className="text-lg font-semibold">Pay your invoice</h1>
        {sessionQ.data && (
          <p className="mt-1 text-sm text-muted-foreground">
            {sessionQ.data.businessName}: total{" "}
            <span className="font-medium text-foreground">
              {money(sessionQ.data.amountCents)}
            </span>
          </p>
        )}
      </div>

      {sessionQ.isPending && (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Preparing secure checkout…
        </div>
      )}

      {sessionQ.isError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {(sessionQ.error as Error).message ?? "Could not start payment."}
        </div>
      )}

      {sessionQ.data && stripePromise && (
        <div className="overflow-hidden rounded-md border bg-white">
          <EmbeddedCheckoutProvider
            stripe={stripePromise}
            options={{ clientSecret: sessionQ.data.clientSecret }}
          >
            <EmbeddedCheckout />
          </EmbeddedCheckoutProvider>
        </div>
      )}

      <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5" />
        Payments processed securely by Stripe. Cards + ACH accepted.
      </p>
    </div>
  );
}
