import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getInvoice, createCheckoutForInvoice, voidInvoice } from "@/lib/invoices.functions";
import { syncInvoice } from "@/lib/accounting.functions";
import { sendInvoiceEmail, getEmailSendStatus } from "@/lib/notifications.functions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ConfirmButton";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/invoices/$invoiceId")({
  component: InvoiceDetail,
});

function fmtCents(c: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format((c ?? 0) / 100);
}

function InvoiceDetail() {
  const { invoiceId } = Route.useParams();
  const get = useServerFn(getInvoice);
  const checkout = useServerFn(createCheckoutForInvoice);
  const voidFn = useServerFn(voidInvoice);
  const qc = useQueryClient();

  const q = useQuery({ queryKey: ["invoice", invoiceId], queryFn: () => get({ data: { id: invoiceId } }) });

  const checkoutM = useMutation({
    mutationFn: async () => checkout({ data: { id: invoiceId, returnUrl: window.location.href } }),
    onSuccess: (r) => {
      if (r.url) window.open(r.url, "_blank");
      qc.invalidateQueries({ queryKey: ["invoice", invoiceId] });
    },
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
      toast.message(`Invoice queued for ${to} — check back shortly`, { id });
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

  return (
    <div className="space-y-6">
      <div>
        <Link to="/invoices" className="text-sm text-muted-foreground hover:underline">← Invoices</Link>
        <div className="mt-2 flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Invoice {invoice.id.slice(0, 8)}</h1>
          <Badge>{invoice.status}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">{client?.display_name} · {client?.primary_email ?? "no email"}</p>
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

      <div className="flex gap-2">
        {invoice.status !== "paid" && invoice.status !== "void" && (
          <>
            <Button onClick={() => checkoutM.mutate()} disabled={checkoutM.isPending}>
              {checkoutM.isPending ? "Opening Stripe…" : invoice.checkout_url ? "Reopen checkout" : "Send / Pay via Stripe"}
            </Button>
            {invoice.checkout_url && (
              <a href={invoice.checkout_url} target="_blank" rel="noreferrer" className="text-sm text-primary underline self-center">
                Open existing checkout link
              </a>
            )}
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
      </div>

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
                    <td className="px-4 py-2 font-mono text-xs">{p.stripe_payment_intent_id ?? "—"}</td>
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
