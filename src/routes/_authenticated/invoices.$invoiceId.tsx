import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getInvoice, createCheckoutForInvoice, voidInvoice } from "@/lib/invoices.functions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
            <Button variant="destructive" onClick={() => voidM.mutate()} disabled={voidM.isPending}>Void</Button>
          </>
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
