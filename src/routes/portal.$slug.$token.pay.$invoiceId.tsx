import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { Button } from "@/components/ui/button";
import { Loader2, ArrowLeft, ShieldCheck } from "lucide-react";
import { portalCreateInvoicePaymentIntent } from "@/lib/portal.functions";
import { stripeAppearance } from "@/lib/stripe-appearance";
import { money } from "@/lib/portal-ui";

export const Route = createFileRoute("/portal/$slug/$token/pay/$invoiceId")({
  head: () => ({ meta: [{ title: "Pay invoice" }] }),
  component: PayInvoice,
});

// Cache the Stripe.js instance per (publishable key + connected account),
// module-scoped, not per render. Connect direct charges require the Payment
// Element to be initialized scoped to the org's connected account.
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
  const createIntent = useServerFn(portalCreateInvoicePaymentIntent);

  const intentQ = useQuery({
    queryKey: ["portal-pi", token, invoiceId],
    queryFn: () => createIntent({ data: { token, invoiceId } }),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const stripePromise = useMemo(
    () => (intentQ.data ? getStripe(intentQ.data.publishableKey, (intentQ.data as any).stripeAccount) : null),
    [intentQ.data?.publishableKey, (intentQ.data as any)?.stripeAccount],
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
        {intentQ.data && (
          <p className="mt-1 text-sm text-muted-foreground">
            {intentQ.data.businessName}: total{" "}
            <span className="font-medium text-foreground">
              {money(intentQ.data.amountCents)}
            </span>
          </p>
        )}
      </div>

      {intentQ.isPending && (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Preparing secure checkout…
        </div>
      )}

      {intentQ.isError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {(intentQ.error as Error).message ?? "Could not start payment."}
        </div>
      )}

      {intentQ.data && stripePromise && (
        <Elements
          stripe={stripePromise}
          options={{
            clientSecret: intentQ.data.clientSecret,
            appearance: stripeAppearance(),
          }}
        >
          <PayForm slug={slug} token={token} invoiceId={invoiceId} amountCents={intentQ.data.amountCents} />
        </Elements>
      )}

      <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5" />
        Payments processed securely by Stripe. Cards + ACH accepted.
      </p>
    </div>
  );
}

function PayForm({
  slug,
  token,
  invoiceId,
  amountCents,
}: {
  slug: string;
  token: string;
  invoiceId: string;
  amountCents: number;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // If the user returns from a redirect flow (e.g. ACH bank auth) with the
  // payment_intent params in the URL, jump straight to the success page.
  useEffect(() => {
    const url = new URL(window.location.href);
    const redirectStatus = url.searchParams.get("redirect_status");
    if (redirectStatus === "succeeded" || redirectStatus === "processing") {
      navigate({
        to: "/portal/$slug/$token/billing",
        params: { slug, token },
        search: { paid: "1" } as never,
      });
    }
  }, [navigate, token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);

    const { error: submitError } = await elements.submit();
    if (submitError) {
      setError(submitError.message ?? "Please check your details.");
      setSubmitting(false);
      return;
    }

    const returnUrl = `${window.location.origin}/portal/${slug}/${token}/pay/${invoiceId}`;
    const { error: confirmError } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: returnUrl },
      redirect: "if_required",
    });

    if (confirmError) {
      setError(confirmError.message ?? "Payment failed. Please try another method.");
      setSubmitting(false);
      return;
    }

    // No redirect needed → charge succeeded (or is processing, e.g. ACH).
    navigate({
      to: "/portal/$slug/$token/billing",
      params: { slug, token },
      search: { paid: "1" } as never,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-md border bg-card p-4">
      <PaymentElement onReady={() => setReady(true)} />
      {error && (
        <div className="rounded border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <Button
        type="submit"
        className="w-full"
        disabled={!stripe || !elements || !ready || submitting}
      >
        {submitting ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Processing…
          </>
        ) : (
          <>Pay {money(amountCents)}</>
        )}
      </Button>
    </form>
  );
}
