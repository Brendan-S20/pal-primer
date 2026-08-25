import { appUrl } from "@/lib/app-origin";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { getInvoice, voidInvoice } from "@/lib/invoices.functions";
import { StaffInvoicePayForm } from "@/components/StaffInvoicePayForm";
import { getMyOrg } from "@/lib/org.functions";
import { syncInvoice } from "@/lib/accounting.functions";
import { sendInvoiceEmail, getEmailSendStatus } from "@/lib/notifications.functions";
import { formatDay, formatDateTime } from "@/lib/format";
import { formatLineItemDescription } from "@/lib/invoice-labels";
import { Button } from "@/components/ui/button";
import { StatusChip, SectionLabel } from "@/components/client-detail/primitives";
import { ConfirmButton } from "@/components/ConfirmButton";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/invoices/$invoiceId")({
  component: InvoiceDetail,
});

function fmtCents(c: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format((c ?? 0) / 100);
}

// StatusChip tone mapping for invoice statuses that aren't in the shared
// palette. paid/open/void map directly; draft renders inert gray and
// uncollectible borrows the destructive "overdue" tone.
const CHIP_STATUS: Record<string, string> = { draft: "inactive", uncollectible: "overdue" };
const CHIP_LABEL: Record<string, string> = { draft: "Draft", uncollectible: "Uncollectible" };
function InvoiceChip({
  status,
  label,
  className,
}: {
  status: string;
  label?: string;
  className?: string;
}) {
  return (
    <StatusChip
      status={CHIP_STATUS[status] ?? status}
      label={label ?? CHIP_LABEL[status]}
      className={className}
    />
  );
}

// Print stylesheet for "Download / print": only the invoice document
// (.invoice-print-area — header, bill-to, line items, totals) prints. The
// toolbar, payment form, and payment history live outside the print area and
// are never included. On paper the card flattens to a plain white sheet.
const PRINT_STYLES = `
@media print {
  body * { visibility: hidden; }
  .invoice-print-area, .invoice-print-area * { visibility: visible; }
  .invoice-print-area {
    position: absolute; left: 0; top: 0; width: 100%;
    margin: 0; padding: 24px;
    background: white; color: black;
    border: none; border-radius: 0; box-shadow: none;
  }
  .invoice-print-area * { box-shadow: none !important; }
}
`;

function InvoiceDetail() {
  const { invoiceId } = Route.useParams();
  const get = useServerFn(getInvoice);
  const voidFn = useServerFn(voidInvoice);
  const orgFn = useServerFn(getMyOrg);
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ["invoice", invoiceId],
    queryFn: () => get({ data: { id: invoiceId } }),
  });
  const orgQ = useQuery({ queryKey: ["my-org"], queryFn: () => orgFn(), staleTime: 60_000 });

  // In-app payment (B2/I8): the shared three-part payment panel — saved card
  // with exact instrument + amount, account credit, or new card entry via the
  // Payment Element. Same component the invoice drawer embeds.
  const [payOpen, setPayOpen] = useState(false);

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
          const at = new Date().toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          });
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

  const shortId = invoice.id.slice(0, 8);
  const subtotalCents = (invoice as any).subtotal_cents as number | null | undefined;
  const dueOn = (invoice as any).due_on as string | null | undefined;
  const overdue =
    invoice.status === "open" && !!dueOn && dueOn < new Date().toISOString().slice(0, 10);
  const period =
    invoice.period_start && invoice.period_end && invoice.period_start !== invoice.period_end
      ? `${formatDay(invoice.period_start)} to ${formatDay(invoice.period_end)}`
      : invoice.period_end
        ? formatDay(invoice.period_end)
        : null;

  return (
    <div className="space-y-6">
      <style>{PRINT_STYLES}</style>
      <Link to="/invoices" className="text-sm text-muted-foreground hover:underline">
        ← Invoices
      </Link>

      {/* The invoice document: the only thing that prints. */}
      <div className="invoice-print-area rounded-xl border bg-card p-6 shadow-sm sm:p-8">
        {/* Document header: issuer left, invoice meta right */}
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div>
            {orgName && <p className="text-lg font-semibold">{orgName}</p>}
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">Invoice</h1>
            <p className="mt-0.5 font-mono text-sm text-muted-foreground">#{shortId}</p>
          </div>
          <div className="flex flex-col items-start gap-2 text-sm sm:items-end">
            <InvoiceChip status={invoice.status} />
            <div className="space-y-0.5 sm:text-right">
              {invoice.issued_at && (
                <p>
                  <span className="text-muted-foreground">Issued</span>{" "}
                  {formatDay(String(invoice.issued_at))}
                </p>
              )}
              {dueOn && invoice.status !== "paid" && invoice.status !== "void" && (
                <p className={overdue ? "font-medium text-destructive" : ""}>
                  <span className={overdue ? "" : "text-muted-foreground"}>
                    {overdue ? "Overdue since" : "Due"}
                  </span>{" "}
                  {formatDay(dueOn)}
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

        {/* Billed to */}
        <div className="mt-8">
          <SectionLabel>Billed to</SectionLabel>
          <p className="mt-1.5 text-sm font-medium">{client?.display_name ?? "Client"}</p>
          <p className="text-sm text-muted-foreground">
            {client?.primary_email ?? "No email on file"}
          </p>
        </div>

        {/* Line items */}
        <div className="mt-8">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="pb-2 pr-4 font-semibold">Description</th>
                <th className="pb-2 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.length === 0 ? (
                <tr>
                  <td colSpan={2} className="py-6 text-center text-muted-foreground">
                    No line items on this invoice.
                  </td>
                </tr>
              ) : (
                items.map((it) => (
                  <tr key={it.id}>
                    <td className="py-2.5 pr-4">{formatLineItemDescription(it.description)}</td>
                    <td className="py-2.5 text-right tabular-nums">
                      {fmtCents(it.amount_cents, invoice.currency)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          {/* Totals, bottom-right */}
          <div className="mt-4 flex justify-end border-t pt-4">
            <div className="w-full max-w-xs space-y-2">
              {subtotalCents != null && (
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>Subtotal</span>
                  <span className="tabular-nums">{fmtCents(subtotalCents, invoice.currency)}</span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-sm font-medium">
                  Total
                  {invoice.status === "paid" && <InvoiceChip status="paid" label="PAID" />}
                </span>
                <span className="text-xl font-semibold tabular-nums">
                  {fmtCents(invoice.total_cents, invoice.currency)}
                </span>
              </div>
              {/* Credit applications live on the invoice (credit_applied_cents
                  + the credit ledger), not in the payments cash list. */}
              {((invoice as { credit_applied_cents?: number | null }).credit_applied_cents ?? 0) >
                0 && (
                <>
                  <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>Credit applied</span>
                    <span className="tabular-nums">
                      -
                      {fmtCents(
                        (invoice as { credit_applied_cents?: number | null })
                          .credit_applied_cents ?? 0,
                        invoice.currency,
                      )}
                    </span>
                  </div>
                  {invoice.status === "open" && (
                    <div className="flex items-center justify-between text-sm font-medium">
                      <span>Amount due</span>
                      <span className="tabular-nums">
                        {fmtCents(
                          Math.max(
                            (invoice.total_cents ?? 0) -
                              ((invoice as { credit_applied_cents?: number | null })
                                .credit_applied_cents ?? 0),
                            0,
                          ),
                          invoice.currency,
                        )}
                      </span>
                    </div>
                  )}
                </>
              )}
              {invoice.status === "paid" && invoice.paid_at && (
                <p className="text-right text-xs text-muted-foreground">
                  Paid {formatDay(String(invoice.paid_at))}
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

      {/* Actions toolbar (never prints) */}
      <div className="flex flex-wrap items-center gap-2">
        {invoice.status !== "paid" && invoice.status !== "void" && (
          <>
            <Button onClick={() => setPayOpen((v) => !v)}>
              {payOpen ? "Hide payment form" : "Take payment"}
            </Button>
            {client?.primary_email && (
              <Button variant="outline" onClick={() => emailM.mutate()} disabled={emailM.isPending}>
                {emailM.isPending ? "Sending…" : "Email invoice to client"}
              </Button>
            )}
            {(invoice as any).public_token && (
              <Button
                variant="outline"
                onClick={() => {
                  // appUrl(): staff copy this and send it to a customer. From
                  // the binary the page origin is `capacitor://localhost`.
                  const url = appUrl(`/pay/i/${(invoice as any).public_token}`);
                  navigator.clipboard.writeText(url).then(
                    () => toast.success("Pay link copied to clipboard"),
                    () => toast.error("Copy failed"),
                  );
                }}
              >
                Copy pay link
              </Button>
            )}
          </>
        )}
        {invoice.status === "paid" && !(invoice as any).accounting_remote_id && (
          <Button variant="outline" onClick={() => syncM.mutate()} disabled={syncM.isPending}>
            {syncM.isPending ? "Syncing…" : "Sync to accounting"}
          </Button>
        )}
        <Button variant="outline" onClick={() => window.print()}>
          Download / print
        </Button>
        {invoice.status !== "paid" && invoice.status !== "void" && (
          <ConfirmButton
            title="Void this invoice?"
            description="Voiding removes this invoice from the client's balance and can't be undone."
            confirmLabel="Void invoice"
            onConfirm={() => voidM.mutate()}
            disabled={voidM.isPending}
          >
            Void
          </ConfirmButton>
        )}
        {(invoice as any).accounting_remote_id && (
          <span className="self-center text-xs text-muted-foreground">
            Synced · {(invoice as any).accounting_remote_id}
          </span>
        )}
      </div>

      {/* Integrated payment card: the shared saved-card / credit / new-card
          panel (one implementation with the invoice drawer, I3). */}
      {payOpen && invoice.status !== "paid" && (
        <section className="rounded-xl border bg-card p-6 shadow-sm">
          <SectionLabel>Take payment</SectionLabel>
          <p className="mt-1 font-mono text-xs text-muted-foreground">Invoice #{shortId}</p>
          <div className="mt-4 max-w-lg">
            <StaffInvoicePayForm
              invoiceId={invoiceId}
              onPaid={() => {
                setPayOpen(false);
                qc.invalidateQueries({ queryKey: ["invoice", invoiceId] });
              }}
            />
          </div>
        </section>
      )}

      {/* Payment history (never prints) */}
      {payments.length > 0 && (
        <div>
          <SectionLabel className="mb-2">Payments</SectionLabel>
          <div className="relative overflow-x-auto rounded-xl border bg-card shadow-sm">
            <table className="w-full text-sm min-w-[480px]">
              <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-semibold">When</th>
                  <th className="px-4 py-2 font-semibold">Amount</th>
                  <th className="px-4 py-2 font-semibold">Status</th>
                  <th className="px-4 py-2 font-semibold">Payment reference</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td className="px-4 py-2">
                      {formatDateTime(p.paid_at ?? p.created_at) || (p.paid_at ?? p.created_at)}
                    </td>
                    <td className="px-4 py-2 tabular-nums">
                      {fmtCents(p.amount_cents, invoice.currency)}
                    </td>
                    <td className="px-4 py-2">
                      <StatusChip status={p.status} />
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">
                      {p.stripe_payment_intent_id ?? "-"}
                    </td>
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

// The inline Payment Element form moved to the shared StaffInvoicePayForm
// component (src/components/StaffInvoicePayForm.tsx) so the invoice drawer
// and this page share one payment implementation.
