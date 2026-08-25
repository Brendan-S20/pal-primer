// Public invoice pay page (QA round 8): /pay/i/{token}. No auth — the
// unguessable invoices.public_token is the capability. A client who gets the
// link by text or email sees a clean invoice document and pays right here
// with the same in-app Payment Element the portal uses.
import { appUrl } from "@/lib/app-origin";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { Loader2, ShieldCheck, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InvoiceStatusBadge } from "@/components/InvoiceStatusBadge";
import { getPublicInvoice, createPublicInvoicePaymentIntent } from "@/lib/invoices.functions";
import { stripeAppearance } from "@/lib/stripe-appearance";
import { formatDay } from "@/lib/format";
import { formatLineItemDescription } from "@/lib/invoice-labels";

export const Route = createFileRoute("/pay/i/$token")({
  head: () => ({ meta: [{ title: "Pay invoice" }] }),
  component: PublicPayPage,
});

function fmtCents(c: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format((c ?? 0) / 100);
}

// Cache Stripe.js per (publishable key + connected account): Connect direct
// charges require the Payment Element scoped to the org's connected account.
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

function isOverdue(status: string, dueOn: string | null) {
  return status === "open" && !!dueOn && dueOn < new Date().toISOString().slice(0, 10);
}

function PublicPayPage() {
  const { token } = Route.useParams();
  const qc = useQueryClient();
  const getFn = useServerFn(getPublicInvoice);
  const intentFn = useServerFn(createPublicInvoicePaymentIntent);
  const [justPaid, setJustPaid] = useState(false);

  // Returning from a redirect flow (e.g. ACH bank auth): the payment is done
  // or in flight, so do NOT mint a new intent — the mount-time query would
  // otherwise reconcile-and-throw ("already paid") at the customer who just
  // paid, or replace a processing intent.
  const redirectStatus =
    typeof window !== "undefined"
      ? new URL(window.location.href).searchParams.get("redirect_status")
      : null;
  const returningFromRedirect = redirectStatus === "succeeded" || redirectStatus === "processing";

  const invoiceQ = useQuery({
    queryKey: ["public-invoice", token],
    queryFn: () => getFn({ data: { token } }),
  });

  const data = invoiceQ.data;
  const invoice = data?.found ? data.invoice : null;
  const payable =
    !!invoice &&
    invoice.status === "open" &&
    invoice.totalCents > 0 &&
    !returningFromRedirect &&
    !justPaid;

  const intentQ = useQuery({
    queryKey: ["public-invoice-pi", token],
    queryFn: () => intentFn({ data: { token } }),
    enabled: payable,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const stripePromise = useMemo(
    () =>
      intentQ.data ? getStripe(intentQ.data.publishableKey, intentQ.data.stripeAccount) : null,
    [intentQ.data?.publishableKey, intentQ.data?.stripeAccount],
  );

  if (invoiceQ.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading invoice…
      </div>
    );
  }

  if (!data || !data.found || !invoice) {
    return (
      <div className="mx-auto max-w-lg space-y-2 p-8 text-center">
        <h1 className="text-lg font-semibold">This payment link isn't valid</h1>
        <p className="text-sm text-muted-foreground">
          The link may have been mistyped or the invoice removed. Please contact your service
          provider for a new link.
        </p>
      </div>
    );
  }

  const overdue = isOverdue(invoice.status, invoice.dueOn);
  const period =
    invoice.periodStart && invoice.periodEnd && invoice.periodStart !== invoice.periodEnd
      ? `${formatDay(invoice.periodStart)} to ${formatDay(invoice.periodEnd)}`
      : invoice.periodEnd
        ? formatDay(invoice.periodEnd)
        : null;
  const settled = invoice.status === "paid" || justPaid || returningFromRedirect;

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 sm:p-6">
      {/* Post-payment banner */}
      {(justPaid || returningFromRedirect) && invoice.status !== "paid" && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          {redirectStatus === "processing"
            ? "Your bank payment is processing. It can take a few days to clear."
            : "Payment received. Thank you!"}
        </div>
      )}

      {/* The invoice document */}
      <div className="rounded-xl border bg-card p-6 shadow-sm sm:p-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-lg font-semibold">{data.orgName}</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">Invoice</h1>
            <p className="mt-0.5 font-mono text-sm text-muted-foreground">#{invoice.shortId}</p>
          </div>
          <div className="flex flex-col items-start gap-2 text-sm sm:items-end">
            <span className="flex items-center gap-2">
              <InvoiceStatusBadge status={invoice.status} />
              {overdue && !settled && (
                <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive">
                  Overdue
                </span>
              )}
            </span>
            <div className="space-y-0.5 sm:text-right">
              {invoice.issuedAt && (
                <p>
                  <span className="text-muted-foreground">Issued</span>{" "}
                  {formatDay(invoice.issuedAt)}
                </p>
              )}
              {invoice.dueOn && invoice.status !== "paid" && invoice.status !== "void" && (
                <p className={overdue && !settled ? "font-medium text-destructive" : ""}>
                  <span className={overdue && !settled ? "" : "text-muted-foreground"}>Due</span>{" "}
                  {formatDay(invoice.dueOn)}
                </p>
              )}
              {period && (
                <p>
                  <span className="text-muted-foreground">Period</span> {period}
                </p>
              )}
            </div>
          </div>
        </div>

        {data.clientName && (
          <div className="mt-6">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Billed to
            </p>
            <p className="mt-1 text-sm font-medium">{data.clientName}</p>
          </div>
        )}

        <div className="mt-6">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="pb-2 pr-4 font-semibold">Description</th>
                <th className="pb-2 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.items.length === 0 ? (
                <tr>
                  <td colSpan={2} className="py-6 text-center text-muted-foreground">
                    No line items on this invoice.
                  </td>
                </tr>
              ) : (
                data.items.map((it) => (
                  <tr key={it.id}>
                    <td className="py-2.5 pr-4">{formatLineItemDescription(it.description)}</td>
                    <td className="py-2.5 text-right tabular-nums">
                      {fmtCents(it.amountCents, invoice.currency)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <div className="mt-4 flex justify-end border-t pt-4">
            <div className="w-full max-w-xs space-y-2">
              {invoice.subtotalCents != null && (
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>Subtotal</span>
                  <span className="tabular-nums">
                    {fmtCents(invoice.subtotalCents, invoice.currency)}
                  </span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-sm font-medium">
                  Total
                  {invoice.status === "paid" && <InvoiceStatusBadge status="paid" />}
                </span>
                <span className="text-xl font-semibold tabular-nums">
                  {fmtCents(invoice.totalCents, invoice.currency)}
                </span>
              </div>
              {/* CREDIT AND AMOUNT DUE. getPublicInvoice has always returned
                  both and this page rendered neither, so an invoice with credit
                  applied showed "Total $340.00" here while the Pay button below
                  read "Pay $190.00" — two numbers on the one document an
                  anonymous payer ever sees, with nothing explaining the gap.
                  Both staff-facing surfaces already show this split; the
                  customer-facing one was the only one missing it. */}
              {(invoice.creditAppliedCents ?? 0) > 0 && (
                <>
                  <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>Account credit applied</span>
                    <span className="tabular-nums">
                      −{fmtCents(invoice.creditAppliedCents ?? 0, invoice.currency)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between border-t pt-2">
                    <span className="text-sm font-medium">Amount due</span>
                    <span className="text-xl font-semibold tabular-nums">
                      {fmtCents(invoice.amountDueCents ?? 0, invoice.currency)}
                    </span>
                  </div>
                </>
              )}
              {invoice.status === "paid" && invoice.paidAt && (
                <p className="text-right text-xs text-muted-foreground">
                  Paid {formatDay(invoice.paidAt)}
                </p>
              )}
              {invoice.status === "void" && (
                <p className="text-right text-xs text-muted-foreground">
                  This invoice was voided and is no longer payable.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Payment form */}
      {payable && (
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <h2 className="text-sm font-medium">Pay this invoice</h2>
          {intentQ.isPending && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Preparing secure payment…
            </div>
          )}
          {intentQ.isError && (
            <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {(intentQ.error as Error).message ?? "Could not start payment."}
            </div>
          )}
          {intentQ.data && stripePromise && (
            <div className="mt-4">
              <Elements
                stripe={stripePromise}
                options={{
                  clientSecret: intentQ.data.clientSecret,
                  appearance: stripeAppearance(),
                }}
              >
                <PublicPayForm
                  token={token}
                  amountCents={intentQ.data.amountCents}
                  currency={intentQ.data.currency}
                  onPaid={() => {
                    setJustPaid(true);
                    qc.invalidateQueries({ queryKey: ["public-invoice", token] });
                  }}
                />
              </Elements>
            </div>
          )}
        </div>
      )}

      <p className="flex items-center justify-center gap-1.5 pb-6 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5" />
        Payments are processed securely by Stripe. Your card details are never stored here.
      </p>
    </div>
  );
}

function PublicPayForm({
  token,
  amountCents,
  currency,
  onPaid,
}: {
  token: string;
  amountCents: number;
  currency: string;
  onPaid: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

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

    // Bank-debit methods that need a redirect come back to this same URL with
    // ?redirect_status=…, handled by the page before the form mounts.
    // appUrl(): Stripe sends the payer back here. Correct on the web either
    // way, and the one spelling that cannot become capacitor://localhost.
    const returnUrl = appUrl(`/pay/i/${token}`);
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

    // No redirect needed: the charge succeeded (or is processing, e.g. ACH).
    onPaid();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
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
          <>Pay {fmtCents(amountCents, currency)}</>
        )}
      </Button>
    </form>
  );
}
