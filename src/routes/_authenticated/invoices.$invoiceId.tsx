import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { getInvoice, createInvoicePaymentIntent, voidInvoice } from "@/lib/invoices.functions";
import { stripeAppearance } from "@/lib/stripe-appearance";
import { getMyOrg } from "@/lib/org.functions";
import { syncInvoice } from "@/lib/accounting.functions";
import { sendInvoiceEmail, getEmailSendStatus } from "@/lib/notifications.functions";
import { Button } from "@/components/ui/button";
import { InvoiceStatusBadge } from "@/components/InvoiceStatusBadge";
import { ConfirmButton } from "@/components/ConfirmButton";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/invoices/$invoiceId")({
  component: InvoiceDetail,
});

function fmtCents(c: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format((c ?? 0) / 100);
}

// Connect Payment Element: stripe.js must be initialized scoped to the org's
// connected account (the intent lives there). Cached per key+account.
const connectStripeCache = new Map<string, Promise<StripeJs | null>>();
function getConnectStripe(pk: string, stripeAccount: string) {
  const key = `${pk}|${stripeAccount}`;
  let p = connectStripeCache.get(key);
  if (!p) {
    p = loadStripe(pk, { stripeAccount });
    connectStripeCache.set(key, p);
  }
  return p;
}

// Print stylesheet for "Download / print": everything on the page is hidden
// except the invoice sheet, which is repositioned to the top-left of the page.
// Elements marked .print-only (org name, issued date, status line) only render
// on paper.
const PRINT_STYLES = `
.print-only { display: none; }
@media print {
  body * { visibility: hidden; }
  .invoice-print-area, .invoice-print-area * { visibility: visible; }
  .invoice-print-area { position: absolute; inset: 0; padding: 24px; background: white; color: black; }
  .print-only { display: block; }
}
`;

function InvoiceDetail() {
  const { invoiceId } = Route.useParams();
  const get = useServerFn(getInvoice);
  const voidFn = useServerFn(voidInvoice);
  const orgFn = useServerFn(getMyOrg);
  const qc = useQueryClient();

  const q = useQuery({ queryKey: ["invoice", invoiceId], queryFn: () => get({ data: { id: invoiceId } }) });
  const orgQ = useQuery({ queryKey: ["my-org"], queryFn: () => orgFn(), staleTime: 60_000 });

  // In-app payment: Payment Element right on the invoice, for taking a card
  // or ACH payment over the phone or in person — no checkout.stripe.com tab.
  const intentFn = useServerFn(createInvoicePaymentIntent);
  const [intent, setIntent] = useState<{
    clientSecret: string;
    publishableKey: string;
    stripeAccount: string;
    amountCents: number;
    currency: string;
  } | null>(null);
  const intentM = useMutation({
    mutationFn: async () => intentFn({ data: { id: invoiceId } }),
    onSuccess: (r) => setIntent(r),
    onError: (e: Error) => toast.error(e.message),
  });

  const voidM = useMutation({
    mutationFn: async () => voidFn({ data: { id: invoiceId } }),
    onSuccess: () => {
      toast.success("Invoice voided");
      qc.invalidateQueries({ queryKey: ["invoice", invoiceId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const emailFn = useServerFn(sendInvoiceEmail);
  const statusFn = useServerFn(getEmailSendStatus);
  const emailM = useMutation({
    mutationFn: async () => emailFn({ data: { invoiceId } }),
    onSuccess: async (r) => {
      // The send is queued; poll email_send_log for the real outcome so we
      // confirm "Emailed to X" (or surface a failure) rather than claiming
      // success on enqueue (finding #32).
      const to = r.recipient ?? "the client";
      if (!r.messageId) {
        toast.success(`Invoice queued for ${to}`);
        return;
      }
      const id = toast.loading(`Sending invoice to ${to}…`);
      for (let i = 0; i < 20; i++) {
        await new Promise((res) => setTimeout(res, 3000));
        let s: { status: string; recipient: string | null; error: string | null };
        try {
          s = await statusFn({ data: { messageId: r.messageId } });
        } catch {
          continue;
        }
        if (s.status === "sent") {
          const at = new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
          toast.success(`Emailed to ${s.recipient ?? to} · ${at}`, { id });
          return;
        }
        if (s.status === "failed" || s.status === "bounced" || s.status === "dlq") {
          toast.error(`Couldn't email the invoice${s.error ? `: ${s.error}` : ""}`, { id });
          return;
        }
      }
      toast.message(`Invoice queued for ${to}. Check back shortly`, { id });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const syncFn = useServerFn(syncInvoice);
  const syncM = useMutation({
    mutationFn: async () => syncFn({ data: { invoice_id: invoiceId } }),
    onSuccess: (r) => {
      toast.success(`Synced to accounting (id ${r.remote_id})`);
      qc.invalidateQueries({ queryKey: ["invoice", invoiceId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (q.isLoading) return <p className="text-muted-foreground">Loading…</p>;
  if (!q.data) return <p>Not found.</p>;
  const { invoice, items, payments } = q.data;
  const client = Array.isArray(invoice.clients) ? invoice.clients[0] : invoice.clients;
  const orgName = orgQ.data?.organization?.name;

  return (
    <div className="space-y-6">
      <style>{PRINT_STYLES}</style>
      <Link to="/invoices" className="text-sm text-muted-foreground hover:underline">← Invoices</Link>

      <div className="invoice-print-area space-y-6">
        <div>
          {orgName && <p className="print-only text-lg font-semibold">{orgName}</p>}
          <div className="mt-2 flex items-center gap-3">
            <h1 className="text-2xl font-semibold">Invoice {invoice.id.slice(0, 8)}</h1>
            <InvoiceStatusBadge status={invoice.status} />
          </div>
          <p className="text-sm text-muted-foreground">{client?.display_name} · {client?.primary_email ?? "no email"}</p>
          <p className="print-only text-sm">
            Status: {invoice.status}
            {invoice.issued_at ? ` · Issued ${String(invoice.issued_at).slice(0, 10)}` : ""}
          </p>
        </div>

        <div className="rounded-lg border bg-card">
          <div className="border-b p-4 text-sm text-muted-foreground">
            {invoice.period_start ? `${invoice.period_start} → ` : ""}{invoice.period_end}
          </div>
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Description</th>
                <th className="px-4 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className="border-b last:border-0">
                  <td className="px-4 py-2">{it.description}</td>
                  <td className="px-4 py-2 text-right">{fmtCents(it.amount_cents, invoice.currency)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-medium">
                <td className="px-4 py-3">Total</td>
                <td className="px-4 py-3 text-right">{fmtCents(invoice.total_cents, invoice.currency)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="flex gap-2">
        {invoice.status !== "paid" && invoice.status !== "void" && (
          <>
            <Button onClick={() => (intent ? setIntent(null) : intentM.mutate())} disabled={intentM.isPending}>
              {intentM.isPending ? "Preparing…" : intent ? "Hide payment form" : "Take payment here"}
            </Button>
            {client?.primary_email && (
              <Button variant="outline" onClick={() => emailM.mutate()} disabled={emailM.isPending}>
                {emailM.isPending ? "Sending…" : "Email invoice to client"}
              </Button>
            )}
            <ConfirmButton
              title="Void this invoice?"
              description="Voiding removes this invoice from the client's balance and can't be undone."
              confirmLabel="Void invoice"
              onConfirm={() => voidM.mutate()}
              disabled={voidM.isPending}
            >
              Void
            </ConfirmButton>
          </>
        )}
        {invoice.status === "paid" && !(invoice as any).accounting_remote_id && (
          <Button variant="outline" onClick={() => syncM.mutate()} disabled={syncM.isPending}>
            {syncM.isPending ? "Syncing…" : "Sync to accounting"}
          </Button>
        )}
        {(invoice as any).accounting_remote_id && (
          <span className="self-center text-xs text-muted-foreground">
            Synced · {(invoice as any).accounting_remote_id}
          </span>
        )}
        <Button variant="outline" onClick={() => window.print()}>
          Download / print
        </Button>
      </div>

      {intent && invoice.status !== "paid" && (
        <Elements
          stripe={getConnectStripe(intent.publishableKey, intent.stripeAccount)}
          options={{ clientSecret: intent.clientSecret, appearance: stripeAppearance() }}
        >
          <StaffPayForm
            amountCents={intent.amountCents}
            currency={intent.currency}
            onPaid={() => {
              setIntent(null);
              toast.success("Payment received. The invoice will update shortly.");
              qc.invalidateQueries({ queryKey: ["invoice", invoiceId] });
            }}
          />
        </Elements>
      )}

      {payments.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-medium">Payments</h2>
          <div className="rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">When</th>
                  <th className="px-4 py-2">Amount</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Stripe PI</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="px-4 py-2">{p.paid_at ?? p.created_at}</td>
                    <td className="px-4 py-2">{fmtCents(p.amount_cents, invoice.currency)}</td>
                    <td className="px-4 py-2">{p.status}</td>
                    <td className="px-4 py-2 font-mono text-xs">{p.stripe_payment_intent_id ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// Inline Payment Element form: confirm on this page, no redirect for cards.
// Bank-debit methods that need a redirect come back to this URL with ?paid=1,
// where getInvoice reconciles against Stripe on load.
function StaffPayForm({
  amountCents,
  currency,
  onPaid,
}: {
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
      setError(submitError.message ?? "Please check the payment details.");
      setSubmitting(false);
      return;
    }

    const base = window.location.href.split("?")[0];
    const { error: confirmError } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: `${base}?paid=1` },
      redirect: "if_required",
    });

    if (confirmError) {
      setError(confirmError.message ?? "Payment failed. Please try another method.");
      setSubmitting(false);
      return;
    }

    // No redirect needed → charge succeeded (or is processing, e.g. ACH).
    onPaid();
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-lg space-y-4 rounded-lg border bg-card p-4">
      <PaymentElement onReady={() => setReady(true)} />
      {error && (
        <div className="rounded border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <Button type="submit" className="w-full" disabled={!stripe || !elements || !ready || submitting}>
        {submitting ? "Processing…" : `Pay ${fmtCents(amountCents, currency)}`}
      </Button>
    </form>
  );
}
