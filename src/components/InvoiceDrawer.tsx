// Shared invoice drawer (QA round 8): ONE rich invoice surface used by both
// the invoices index and the client Billing tab, replacing the two divergent
// click behaviors (navigate vs. a thin read-only drawer). Full line items,
// totals, due date, payments history, and every invoice action: charge the
// saved card, send/remind by email, take payment, copy the public pay link,
// void, open the full page.
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { LoadError } from "@/components/LoadError";
import { LineBones } from "@/components/PageSkeletons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { LineQuantity } from "@/components/LineQuantity";
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
import { DownloadPdfButton } from "@/components/DownloadPdfButton";
import { downloadInvoicePdf } from "@/lib/document-pdf.functions";
import { RefundPaymentAction } from "@/components/RefundPaymentAction";
import { canOfferRefund } from "@/lib/refunds";
import { usePermissions } from "@/hooks/useMyRole";
import { describePaymentSplit, formatDateTime, formatDay, surchargeSplit } from "@/lib/format";
import {
  formatLineItemDescription,
  invoiceKindLabel,
  invoiceNumberLabel,
} from "@/lib/invoice-labels";
import { bulkMarkInvoicesPaid, getInvoiceDetail, voidInvoice } from "@/lib/invoices.functions";
import { showsTaxLine, taxLineLabel } from "@/lib/sales-tax";
import { useRecordPaymentDialog, type RecordPaymentAnswer } from "@/components/RecordPaymentDialog";
import { describeManualPayment } from "@/lib/manual-payments";
import { getEmailSendStatus, sendInvoiceEmail } from "@/lib/notifications.functions";
import { reportQueuedSend } from "@/lib/send-report";

// Re-exported so existing imports (invoices index, client billing tab) keep
// working; the implementation now lives in the shared domain lib (I3).
export { isInvoiceOverdue } from "@/lib/overdue";
import { isInvoiceOverdue } from "@/lib/overdue";
import { toastSaveError } from "@/lib/stale-write-toast";
import { invoiceDueCents, isPartiallyPaid } from "@/lib/ar";
import { useOrgTimezone, useOrgToday } from "@/hooks/useOrgToday";
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
  const { role } = usePermissions();
  const { confirm, dialog } = useConfirmDialog();
  const { ask: askPayment, dialog: paymentDialog } = useRecordPaymentDialog();
  const detailFn = useServerFn(getInvoiceDetail);
  const voidFn = useServerFn(voidInvoice);
  const paidFn = useServerFn(bulkMarkInvoicesPaid);
  const emailFn = useServerFn(sendInvoiceEmail);
  const statusFn = useServerFn(getEmailSendStatus);
  const pdfFn = useServerFn(downloadInvoicePdf);
  const [copied, setCopied] = useState(false);
  // B2: "Take payment" swaps the drawer body to the embedded payment view
  // instead of navigating to the full invoice page.
  const [view, setView] = useState<"detail" | "pay">("detail");
  useEffect(() => setView("detail"), [invoiceId]);

  const { data, isError, isFetching, refetch } = useQuery({
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

  // `version` is the invoice as this drawer showed it. A payment or a void
  // somebody else saved since makes the server refuse this one and the
  // drawer offer Reload (#655).
  const voidMut = useMutation({
    // `version` is read when the Void confirm opens, below.
    mutationFn: (version: string | null | undefined) =>
      voidFn({
        data: {
          id: invoiceId!,
          ...(version !== undefined ? { expectedVersion: version } : {}),
        },
      }),
    onSuccess: () => {
      toast.success("Invoice voided");
      refresh();
    },
    onError: (e: Error) => toastSaveError(e, refresh),
  });

  const recordMut = useMutation({
    mutationFn: ({ how, version }: { how: RecordPaymentAnswer; version?: string | null }) =>
      paidFn({
        data: {
          ids: [invoiceId!],
          ...how,
          ...(version !== undefined ? { expectedVersion: version } : {}),
        },
      }),
    onSuccess: (r) => {
      if (!r.ok) {
        toast.error(
          r.refusal ??
            "The payment could not be recorded. The invoice may already be paid or void.",
        );
      } else if (r.partial?.length) {
        toast.success("Partial payment recorded. The rest stays open on the invoice");
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
    onError: (e: Error) => toastSaveError(e, refresh),
  });

  const creditCents = inv?.credit_applied_cents ?? 0;
  const paidCents = inv?.amount_paid_cents ?? 0;
  const dueCents = inv ? invoiceDueCents(inv) : 0;

  const recordPayment = async () => {
    if (!inv) return;
    const version = data?.version;
    const how = await askPayment({
      amountLine: `${fmtCents(dueCents, inv.currency ?? "usd")} is still owed${client?.display_name ? ` by ${client.display_name}` : ""}. The invoice is marked paid when the balance reaches zero. A payment can't be undone here.`,
      balanceCents: dueCents,
    });
    if (how) recordMut.mutate({ how, version });
  };

  const emailMut = useMutation({
    mutationFn: (reminder: boolean) => emailFn({ data: { invoiceId: invoiceId!, reminder } }),
    // The queue processor stamps sent_at when the provider takes the email
    // (#612): the Sent chip is refreshed then, and with email off the drawer
    // says "not sent" and offers the pay link instead.
    onSuccess: (r, reminder) =>
      reportQueuedSend(r, {
        what: reminder ? "Reminder" : "Invoice",
        poll: statusFn,
        onSent: refresh,
      }),
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
  // Payment and send times on the business's clock, not the device's (#654).
  const tz = useOrgTimezone();
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
        title={inv ? `Invoice ${invoiceNumberLabel(inv)}` : "Invoice"}
        size="md"
      >
        {/* Three states before the invoice, not one. `isLoading || !inv` read
            "Loading" forever after a failed read, because an errored query is
            no longer loading and still has no invoice (A-05). */}
        {!inv ? (
          isError ? (
            <LoadError what="this invoice" onRetry={() => refetch()} retrying={isFetching} />
          ) : data ? (
            <p className="text-sm text-muted-foreground">
              This invoice was not found. It may have been deleted.
            </p>
          ) : (
            <LineBones rows={4} />
          )
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
              {isPartiallyPaid(inv) && <MetaChip>Partially paid</MetaChip>}
              {overdue && (
                <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive">
                  Overdue
                </span>
              )}
              <span className="text-xs text-muted-foreground">{invoiceKindLabel(inv.kind)}</span>
              <span className="text-xs text-muted-foreground">
                {inv.period_start
                  ? `${formatDay(inv.period_start)} to ${formatDay(inv.period_end)}`
                  : formatDateTime(inv.created_at, tz)}
              </span>
              {inv.due_on && inv.status !== "paid" && inv.status !== "void" && (
                <span
                  className={`text-xs ${overdue ? "font-medium text-destructive" : "text-muted-foreground"}`}
                >
                  Due {formatDay(inv.due_on)}
                </span>
              )}
              {inv.status === "paid" && inv.paid_at && (
                <span className="text-xs text-muted-foreground">
                  Paid {formatDay(inv.paid_at, undefined, tz)}
                </span>
              )}
              {inGrace && !!inv.send_after && inv.send_after > today && (
                <MetaChip>Scheduled to send {formatDay(inv.send_after)}</MetaChip>
              )}
              {inv.sent_at && <MetaChip>Sent {formatDay(inv.sent_at, undefined, tz)}</MetaChip>}
              {/* sent_at is the provider's acceptance (#612), so an open
                  invoice without it has not reached anyone, unless it is
                  still held for a send date that has not come. Copy pay link
                  is in the actions below. */}
              {open && !inv.sent_at && (!inv.send_after || inv.send_after <= today) && (
                <MetaChip>Not sent: copy the pay link</MetaChip>
              )}
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
              {/* Every status, not only open: a paid invoice's PDF is the
                  receipt a bookkeeper asks for. */}
              <DownloadPdfButton
                size="sm"
                load={() => pdfFn({ data: { invoiceId: inv.id } })}
                nativeUrl={
                  inv.public_token
                    ? appUrl(`/api/public/invoice-pdf?token=${inv.public_token}`)
                    : null
                }
              />
              {open && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  disabled={voidMut.isPending}
                  onClick={async () => {
                    const version = data?.version;
                    if (
                      await confirm({
                        title: "Void this invoice?",
                        description:
                          "Voiding removes this invoice from the client's balance and can't be undone.",
                        destructive: true,
                        confirmLabel: "Void invoice",
                      })
                    )
                      voidMut.mutate(version);
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
                      <span className="min-w-0">
                        <span className="block truncate">
                          {formatLineItemDescription(l.description)}
                        </span>
                        <LineQuantity line={l} currency={inv.currency ?? "usd"} />
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
              {/* Sales tax, its own line and only when there is some: an
                  invoice made at a zero rate looks exactly as it always did. */}
              {showsTaxLine(inv) && (
                <div className="mt-2 flex items-center justify-between gap-2 text-muted-foreground">
                  <span className="min-w-0">{taxLineLabel(inv.tax_label, inv.tax_rate_bps)}</span>
                  <span className="shrink-0">{fmtCents(inv.tax_cents, inv.currency ?? "usd")}</span>
                </div>
              )}
              <div className="mt-2 flex items-center justify-between border-t pt-2 font-medium">
                <span>Total</span>
                <span>{fmtCents(inv.total_cents, inv.currency ?? "usd")}</span>
              </div>
              {/* Credit applications live on the invoice (credit_applied_cents
                  + the credit ledger), not in the payments cash list. Paid is
                  the sum of the payments below; on a partly paid invoice the
                  balance is what is still open. */}
              {creditCents > 0 && (
                <div className="mt-2 flex items-center justify-between text-muted-foreground">
                  <span>Credit applied</span>
                  <span>-{fmtCents(creditCents, inv.currency ?? "usd")}</span>
                </div>
              )}
              {paidCents > 0 && (
                <div className="mt-2 flex items-center justify-between text-muted-foreground">
                  <span>Paid</span>
                  <span>-{fmtCents(paidCents, inv.currency ?? "usd")}</span>
                </div>
              )}
              {(creditCents > 0 || paidCents > 0) && inv.status !== "void" && (
                <div className="mt-2 flex items-center justify-between border-t pt-2 font-medium">
                  <span>Balance due</span>
                  <span>{fmtCents(dueCents, inv.currency ?? "usd")}</span>
                </div>
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
                    <li key={p.id} className="py-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 text-muted-foreground">
                          {formatDateTime(p.paid_at ?? p.created_at, tz)}
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
                            const split = surchargeSplit(
                              p.amount_cents,
                              p.surcharge_cents,
                              p.tip_cents,
                            );
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
                                    {describePaymentSplit(split, (c) =>
                                      fmtCents(c, inv.currency ?? "usd"),
                                    )}
                                  </span>
                                )}
                              </span>
                            );
                          })()}
                        </span>
                      </div>
                      {/* Its own line under the payment, not squeezed into the
                        row: at 320px the row already holds a date, a chip and
                        a two-line amount. */}
                      {(p.refunded_cents > 0 || canOfferRefund(role, p)) && (
                        <div className="mt-1 flex items-center justify-between gap-2">
                          <span className="min-w-0 text-2xs text-muted-foreground">
                            {p.refunded_cents > 0
                              ? `${fmtCents(p.refunded_cents, inv.currency ?? "usd")} refunded`
                              : ""}
                          </span>
                          <RefundPaymentAction
                            payment={p}
                            invoiceId={inv.id}
                            currency={inv.currency}
                            customerName={client?.display_name}
                            onRefunded={onChanged}
                          />
                        </div>
                      )}
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
