// Shared invoice drawer (QA round 8): ONE rich invoice surface used by both
// the invoices index and the client Billing tab, replacing the two divergent
// click behaviors (navigate vs. a thin read-only drawer). Full line items,
// totals, due date, payments history, and every invoice action: charge the
// saved card, send/remind by email, take payment, copy the public pay link,
// void, open the full page.
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  ArrowLeft,
  CreditCard,
  Link2,
  Mail,
  BellRing,
  ExternalLink,
  Ban,
  Banknote,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EditDrawer, DrawerFooter } from "@/components/client-detail/EditDrawer";
import { InvoiceStatusBadge } from "@/components/InvoiceStatusBadge";
import { MetaChip, SectionLabel, StatusChip } from "@/components/client-detail/primitives";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { StaffInvoicePayForm } from "@/components/StaffInvoicePayForm";
import { formatDateTime, formatDay, surchargeSplit } from "@/lib/format";
import { formatLineItemDescription, invoiceKindLabel } from "@/lib/invoice-labels";
import { bulkMarkInvoicesPaid, getInvoiceDetail, voidInvoice } from "@/lib/invoices.functions";
import { useRecordPaymentDialog, type RecordPaymentAnswer } from "@/components/RecordPaymentDialog";
import { describeManualPayment } from "@/lib/manual-payments";
import { sendInvoiceEmail } from "@/lib/notifications.functions";

// Re-exported so existing imports (invoices index, client billing tab) keep
// working; the implementation now lives in the shared domain lib (I3).
export { isInvoiceOverdue } from "@/lib/overdue";
import { isInvoiceOverdue } from "@/lib/overdue";
import { useOrgToday } from "@/hooks/useOrgToday";
import { appUrl } from "@/lib/app-origin";

function fmtCents(c: number | null | undefined, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: (currency || "usd").toUpperCase(),
  }).format((c ?? 0) / 100);
}

export function InvoiceDrawer({
  invoiceId,
  onClose,
  onChanged,
}: {
  invoiceId: string | null;
  onClose: () => void;
  /** Called after a mutation (void, charge) so callers can refresh their lists. */
  onChanged?: () => void;
}) {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const { ask: askPayment, dialog: paymentDialog } = useRecordPaymentDialog();
  const detailFn = useServerFn(getInvoiceDetail);
  const voidFn = useServerFn(voidInvoice);
  const paidFn = useServerFn(bulkMarkInvoicesPaid);
  const emailFn = useServerFn(sendInvoiceEmail);
  const [copied, setCopied] = useState(false);
  // B2: "Take payment" swaps the drawer body to the embedded payment view
  // instead of navigating to the full invoice page.
  const [view, setView] = useState<"detail" | "pay">("detail");
  useEffect(() => setView("detail"), [invoiceId]);

  const { data, isLoading } = useQuery({
    queryKey: ["invoice-detail", invoiceId],
    queryFn: () => detailFn({ data: { invoiceId: invoiceId! } }),
    enabled: !!invoiceId,
  });

  const inv = data?.invoice;
  const client = data?.client;
  const lines = data?.lineItems ?? [];
  const pays = data?.payments ?? [];

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["invoice-detail", invoiceId] });
    onChanged?.();
  };

  const voidMut = useMutation({
    mutationFn: () => voidFn({ data: { id: invoiceId! } }),
    onSuccess: () => {
      toast.success("Invoice voided");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const recordMut = useMutation({
    mutationFn: (how: RecordPaymentAnswer) => paidFn({ data: { ids: [invoiceId!], ...how } }),
    onSuccess: (r) => {
      if (!r.ok) {
        toast.error("The payment could not be recorded. The invoice may already be paid or void.");
      } else {
        toast.success("Payment recorded. Invoice paid");
      }
      if (r.intentStillLive?.length) {
        toast.warning(
          "The payment link for this invoice is still live. Cancel it in Stripe, or the client can still be charged.",
          { duration: 15000 },
        );
      }
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["dashboard-summary"] });
      qc.invalidateQueries({ queryKey: ["billing-summary"] });
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const recordPayment = async () => {
    if (!inv) return;
    const due = Math.max(
      (inv.total_cents ?? 0) -
        ((inv as { credit_applied_cents?: number | null }).credit_applied_cents ?? 0),
      0,
    );
    const how = await askPayment({
      amountLine: `${fmtCents(due, inv.currency ?? "usd")}, the open balance${client?.display_name ? ` for ${client.display_name}` : ""}. This marks the invoice paid and can't be undone here.`,
    });
    if (how) recordMut.mutate(how);
  };

  const emailMut = useMutation({
    mutationFn: (reminder: boolean) => emailFn({ data: { invoiceId: invoiceId!, reminder } }),
    onSuccess: (r: any, reminder) => {
      toast.success(
        `${reminder ? "Reminder" : "Invoice"} queued for ${r.recipient ?? "the client"}`,
      );
      // A first send stamps sent_at (takes the invoice out of the grace
      // window's auto-send loop) - refresh so the chips update.
      if (!reminder) refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const copyPayLink = () => {
    if (!inv) return;
    // appUrl(), not window.location.origin: this link goes to a CUSTOMER, and
    // the origin the staffer happens to be on is not necessarily the host the
    // product lives at — a Lovable preview URL would produce a pay link that
    // works today and 404s next week. See src/lib/app-origin.ts.
    const url = appUrl(`/pay/i/${inv.public_token}`);
    navigator.clipboard.writeText(url).then(
      () => {
        setCopied(true);
        toast.success("Pay link copied to clipboard");
        setTimeout(() => setCopied(false), 2000);
      },
      () => toast.error("Copy failed"),
    );
  };

  const open = inv?.status === "open";
  // The org's today — see src/hooks/useOrgToday.ts.
  const today = useOrgToday();
  const overdue = inv ? isInvoiceOverdue(inv.status, inv.due_on, today) : false;
  // Grace window (full auto billing): auto-generated invoice, not yet emailed.
  const inGrace = open && !inv?.sent_at && !!inv?.send_after;

  // Emailing a held invoice force-sends it — it bypasses the remaining grace
  // and takes the invoice out of the nightly auto-send loop. Confirm that
  // grace-bypass so it's a deliberate action, not an accidental early send.
  const sendToClient = async () => {
    if (inGrace && inv?.send_after) {
      const ok = await confirm({
        title: "Send this invoice now?",
        description: `This emails the invoice to ${client?.display_name ?? "the client"} right away, ahead of its scheduled send date (${formatDay(inv.send_after)}). It won't be sent again automatically.`,
        confirmLabel: "Send now",
      });
      if (!ok) return;
    }
    emailMut.mutate(false);
  };

  return (
    <>
      {dialog}
      {paymentDialog}
      <EditDrawer
        open={!!invoiceId}
        onClose={onClose}
        title={inv ? `Invoice #${String(inv.id).slice(0, 8)}` : "Invoice"}
        size="md"
      >
        {isLoading || !inv ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : view === "pay" ? (
          /* Embedded payment view (B2): saved card / credit / new card, all
           * inside the popup. Back arrow returns to the invoice detail. */
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => setView("detail")}
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4 shrink-0" /> Back to invoice
            </button>
            <StaffInvoicePayForm
              invoiceId={inv.id}
              onPaid={() => {
                refresh();
                setView("detail");
              }}
            />
          </div>
        ) : (
          <div className="space-y-5 text-sm">
            {/* Status line */}
            <div className="flex flex-wrap items-center gap-2">
              <InvoiceStatusBadge status={inv.status} />
              {overdue && (
                <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive">
                  Overdue
                </span>
              )}
              <span className="text-xs text-muted-foreground">{invoiceKindLabel(inv.kind)}</span>
              <span className="text-xs text-muted-foreground">
                {inv.period_start
                  ? `${formatDay(inv.period_start)} to ${formatDay(inv.period_end)}`
                  : formatDateTime(inv.created_at)}
              </span>
              {inv.due_on && inv.status !== "paid" && inv.status !== "void" && (
                <span
                  className={`text-xs ${overdue ? "font-medium text-destructive" : "text-muted-foreground"}`}
                >
                  Due {formatDay(inv.due_on)}
                </span>
              )}
              {inv.status === "paid" && inv.paid_at && (
                <span className="text-xs text-muted-foreground">Paid {formatDay(inv.paid_at)}</span>
              )}
              {inGrace && <MetaChip>Scheduled to send {formatDay(inv.send_after)}</MetaChip>}
              {inv.sent_at && <MetaChip>Sent {formatDay(inv.sent_at)}</MetaChip>}
            </div>

            {client?.display_name && (
              <p className="text-xs text-muted-foreground">
                Billed to <span className="font-medium text-foreground">{client.display_name}</span>
              </p>
            )}

            {/* Actions */}
            <div className="flex flex-wrap gap-2">
              {open && (
                <Button size="sm" onClick={() => setView("pay")}>
                  <CreditCard className="mr-1 h-3.5 w-3.5 shrink-0" />
                  Take payment
                </Button>
              )}
              {open && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={recordMut.isPending}
                  onClick={recordPayment}
                >
                  <Banknote className="mr-1 h-3.5 w-3.5 shrink-0" />
                  Record payment
                </Button>
              )}
              {open && client?.primary_email && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={emailMut.isPending}
                  onClick={sendToClient}
                >
                  <Mail className="mr-1 h-3.5 w-3.5 shrink-0" />
                  {inGrace ? "Send now" : "Send to client"}
                </Button>
              )}
              {open && client?.primary_email && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={emailMut.isPending}
                  onClick={() => emailMut.mutate(true)}
                >
                  <BellRing className="mr-1 h-3.5 w-3.5 shrink-0" /> Send reminder
                </Button>
              )}
              {open && (
                <Button size="sm" variant="outline" onClick={copyPayLink}>
                  <Link2 className="mr-1 h-3.5 w-3.5 shrink-0" />{" "}
                  {copied ? "Copied" : "Copy pay link"}
                </Button>
              )}
              {open && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  disabled={voidMut.isPending}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: "Void this invoice?",
                        description:
                          "Voiding removes this invoice from the client's balance and can't be undone.",
                        destructive: true,
                        confirmLabel: "Void invoice",
                      })
                    )
                      voidMut.mutate();
                  }}
                >
                  <Ban className="mr-1 h-3.5 w-3.5 shrink-0" /> Void
                </Button>
              )}
            </div>

            {/* Line items */}
            <div>
              <SectionLabel>Line items</SectionLabel>
              {lines.length === 0 ? (
                <p className="mt-1.5 text-muted-foreground">No line items recorded.</p>
              ) : (
                <ul className="mt-1.5 divide-y">
                  {lines.map((l) => (
                    <li key={l.id} className="flex items-center justify-between gap-2 py-1.5">
                      <span className="min-w-0 truncate">
                        {formatLineItemDescription(l.description)}
                      </span>
                      <span className="shrink-0 font-medium">
                        {fmtCents(l.amount_cents, inv.currency ?? "usd")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {inv.subtotal_cents != null && inv.subtotal_cents !== inv.total_cents && (
                <div className="mt-2 flex items-center justify-between border-t pt-2 text-muted-foreground">
                  <span>Subtotal</span>
                  <span>{fmtCents(inv.subtotal_cents, inv.currency ?? "usd")}</span>
                </div>
              )}
              <div className="mt-2 flex items-center justify-between border-t pt-2 font-medium">
                <span>Total</span>
                <span>{fmtCents(inv.total_cents, inv.currency ?? "usd")}</span>
              </div>
              {/* Credit applications live on the invoice (credit_applied_cents
                  + the credit ledger), not in the payments cash list. */}
              {((inv as { credit_applied_cents?: number | null }).credit_applied_cents ?? 0) >
                0 && (
                <>
                  <div className="mt-2 flex items-center justify-between text-muted-foreground">
                    <span>Credit applied</span>
                    <span>
                      -
                      {fmtCents(
                        (inv as { credit_applied_cents?: number | null }).credit_applied_cents,
                        inv.currency ?? "usd",
                      )}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between border-t pt-2 font-medium">
                    <span>Amount due</span>
                    <span>
                      {fmtCents(
                        Math.max(
                          (inv.total_cents ?? 0) -
                            ((inv as { credit_applied_cents?: number | null })
                              .credit_applied_cents ?? 0),
                          0,
                        ),
                        inv.currency ?? "usd",
                      )}
                    </span>
                  </div>
                </>
              )}
            </div>

            {/* Payments */}
            <div>
              <SectionLabel>Payments</SectionLabel>
              {pays.length === 0 ? (
                <p className="mt-1.5 text-muted-foreground">No payment attempts yet.</p>
              ) : (
                <ul className="mt-1.5 divide-y">
                  {pays.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-2 py-1.5">
                      <span className="min-w-0 text-muted-foreground">
                        {formatDateTime(p.paid_at ?? p.created_at)}
                        {describeManualPayment(p.method, p.reference) && (
                          <span className="block truncate text-2xs">
                            {describeManualPayment(p.method, p.reference)}
                          </span>
                        )}
                      </span>
                      <span className="flex items-center gap-2">
                        <StatusChip status={p.status} />
                        {(() => {
                          // What the card was charged. `amount_cents` alone is
                          // the invoice amount, which is not the number on the
                          // customer's statement when a surcharge applies.
                          const split = surchargeSplit(p.amount_cents, p.surcharge_cents);
                          return (
                            <span className="text-right">
                              <span className="font-medium">
                                {fmtCents(
                                  split?.chargedCents ?? p.amount_cents,
                                  inv.currency ?? "usd",
                                )}
                              </span>
                              {split && (
                                <span className="block text-2xs font-normal text-muted-foreground">
                                  {fmtCents(split.baseCents, inv.currency ?? "usd")} service +{" "}
                                  {fmtCents(split.feeCents, inv.currency ?? "usd")} card fee
                                </span>
                              )}
                            </span>
                          );
                        })()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <DrawerFooter>
              <Link
                to="/invoices/$invoiceId"
                params={{ invoiceId: inv.id }}
                onClick={onClose}
                className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
              >
                <ExternalLink className="mr-1.5 h-3.5 w-3.5 shrink-0" /> Open full invoice
              </Link>
            </DrawerFooter>
          </div>
        )}
      </EditDrawer>
    </>
  );
}
