import { appUrl } from "@/lib/app-origin";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
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
  const navigate = useNavigate();

  // Returning from a redirect flow (e.g. ACH bank auth): the payment is done
  // or in flight, so go straight to billing WITHOUT minting a new intent —
  // the mount-time query would otherwise reconcile-and-throw ("already
  // paid") at the customer who just paid, or replace a processing intent.
  const redirectStatus =
    typeof window !== "undefined"
      ? new URL(window.location.href).searchParams.get("redirect_status")
      : null;
  const returningFromRedirect = redirectStatus === "succeeded" || redirectStatus === "processing";
  useEffect(() => {
    if (returningFromRedirect) {
      navigate({
        to: "/portal/$slug/$token/billing",
        params: { slug, token },
        search: { paid: redirectStatus } as never,
      });
    }
  }, [returningFromRedirect, redirectStatus, navigate, slug, token]);

  const intentQ = useQuery({
    queryKey: ["portal-pi", token, invoiceId],
    queryFn: () => createIntent({ data: { token, invoiceId } }),
    staleTime: 5 * 60 * 1000,
    retry: false,
    enabled: !returningFromRedirect,
  });

  const stripePromise = useMemo(
    () =>
      intentQ.data
        ? getStripe(intentQ.data.publishableKey, (intentQ.data as any).stripeAccount)
        : null,
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
            <span className="font-medium text-foreground">{money(intentQ.data.amountCents)}</span>
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
          <PayForm
            slug={slug}
            token={token}
            invoiceId={invoiceId}
            amountCents={intentQ.data.amountCents}
          />
        </Elements>
      )}

      <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5" />
        Payments are processed securely. Cards and ACH accepted.
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
  const qc = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  // Redirect returns are handled by the page before this form mounts.

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

    // appUrl(): Stripe redirects the CUSTOMER here after payment. A
    // `capacitor://localhost` return_url is not a destination any browser can
    // reach, so a payment could complete and strand the payer.
    const returnUrl = appUrl(`/portal/${slug}/${token}/pay/${invoiceId}`);
    const { error: confirmError, paymentIntent } = await stripe.confirmPayment({
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
    // Drop every cached portal query for this token BEFORE navigating, so the
    // billing page refetches and actually shows the invoice as paid instead
    // of the stale open state.
    await qc.invalidateQueries({ queryKey: ["portal", token] });
    // Carry the REAL status, not a flat "paid=1". An ACH debit lands here as
    // `processing` and will not settle for days; telling that customer
    // "payment received" is the kind of reassurance they act on and we can't
    // honour.
    navigate({
      to: "/portal/$slug/$token/billing",
      params: { slug, token },
      search: {
        paid: paymentIntent?.status === "processing" ? "processing" : "succeeded",
      } as never,
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
