// Shared invoice drawer (QA round 8): ONE rich invoice surface used by both
// the invoices index and the client Billing tab, replacing the two divergent
// click behaviors (navigate vs. a thin read-only drawer). Full line items,
// totals, due date, payments history, and every invoice action: charge the
// saved card, send/remind by email, take payment, copy the public pay link,
// void, open the full page.
import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { CreditCard, Link2, Mail, BellRing, ExternalLink, Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EditDrawer, DrawerFooter } from "@/components/client-detail/EditDrawer";
import { InvoiceStatusBadge } from "@/components/InvoiceStatusBadge";
import { SectionLabel, StatusChip } from "@/components/client-detail/primitives";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { formatDateTime, formatDay } from "@/lib/format";
import {
  getInvoiceDetail,
  chargeInvoiceWithSavedCard,
  voidInvoice,
} from "@/lib/invoices.functions";
import { sendInvoiceEmail } from "@/lib/notifications.functions";

function fmtCents(c: number | null | undefined, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: (currency || "usd").toUpperCase(),
  }).format((c ?? 0) / 100);
}

export function isInvoiceOverdue(status: string, dueOn: string | null | undefined) {
  return status === "open" && !!dueOn && dueOn < new Date().toISOString().slice(0, 10);
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
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirmDialog();
  const detailFn = useServerFn(getInvoiceDetail);
  const chargeFn = useServerFn(chargeInvoiceWithSavedCard);
  const voidFn = useServerFn(voidInvoice);
  const emailFn = useServerFn(sendInvoiceEmail);
  const [copied, setCopied] = useState(false);

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

  const chargeMut = useMutation({
    mutationFn: () => chargeFn({ data: { invoiceId: invoiceId! } }),
    onSuccess: (r: any) => {
      toast.success(
        r.status === "processing"
          ? "Charge started. Bank payments can take a few days to clear."
          : "Card charged. The invoice will update shortly.",
      );
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const voidMut = useMutation({
    mutationFn: () => voidFn({ data: { id: invoiceId! } }),
    onSuccess: () => {
      toast.success("Invoice voided");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const emailMut = useMutation({
    mutationFn: (reminder: boolean) => emailFn({ data: { invoiceId: invoiceId!, reminder } }),
    onSuccess: (r: any, reminder) => {
      toast.success(
        `${reminder ? "Reminder" : "Invoice"} queued for ${r.recipient ?? "the client"}`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const copyPayLink = () => {
    if (!inv) return;
    const url = `${window.location.origin}/pay/i/${inv.public_token}`;
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
  const overdue = inv ? isInvoiceOverdue(inv.status, inv.due_on) : false;
  const hasSavedCard = !!client?.default_payment_method_id;

  return (
    <>
      {dialog}
      <EditDrawer
        open={!!invoiceId}
        onClose={onClose}
        title={inv ? `Invoice #${String(inv.id).slice(0, 8)}` : "Invoice"}
        size="md"
      >
        {isLoading || !inv ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
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
              <span className="text-xs text-muted-foreground">{inv.kind}</span>
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
                <span className="text-xs text-muted-foreground">
                  Paid {formatDay(inv.paid_at)}
                </span>
              )}
            </div>

            {client?.display_name && (
              <p className="text-xs text-muted-foreground">
                Billed to <span className="font-medium text-foreground">{client.display_name}</span>
              </p>
            )}

            {/* Actions */}
            <div className="flex flex-wrap gap-2">
              {open && hasSavedCard && (
                <Button
                  size="sm"
                  disabled={chargeMut.isPending}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: `Charge ${client?.default_card_brand ?? "card"} ····${client?.default_card_last4 ?? ""}?`,
                        description: `The client's saved card will be charged ${fmtCents(inv.total_cents, inv.currency ?? "usd")} now.`,
                        confirmLabel: "Charge card",
                      })
                    )
                      chargeMut.mutate();
                  }}
                >
                  <CreditCard className="mr-1 h-3.5 w-3.5" />
                  {chargeMut.isPending ? "Charging…" : "Charge saved card"}
                </Button>
              )}
              {open && (
                <Button
                  size="sm"
                  variant={hasSavedCard ? "outline" : "default"}
                  onClick={() => {
                    onClose();
                    navigate({ to: "/invoices/$invoiceId", params: { invoiceId: inv.id } });
                  }}
                >
                  Take payment
                </Button>
              )}
              {open && client?.primary_email && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={emailMut.isPending}
                  onClick={() => emailMut.mutate(false)}
                >
                  <Mail className="mr-1 h-3.5 w-3.5" /> Send to client
                </Button>
              )}
              {open && client?.primary_email && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={emailMut.isPending}
                  onClick={() => emailMut.mutate(true)}
                >
                  <BellRing className="mr-1 h-3.5 w-3.5" /> Send reminder
                </Button>
              )}
              {open && (
                <Button size="sm" variant="outline" onClick={copyPayLink}>
                  <Link2 className="mr-1 h-3.5 w-3.5" /> {copied ? "Copied" : "Copy pay link"}
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
                  <Ban className="mr-1 h-3.5 w-3.5" /> Void
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
                      <span className="min-w-0 truncate">{l.description}</span>
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
                      <span className="text-muted-foreground">
                        {formatDateTime(p.paid_at ?? p.created_at)}
                      </span>
                      <span className="flex items-center gap-2">
                        <StatusChip status={p.status} />
                        <span className="font-medium">
                          {fmtCents(p.amount_cents, inv.currency ?? "usd")}
                        </span>
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
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> Open full invoice
              </Link>
            </DrawerFooter>
          </div>
        )}
      </EditDrawer>
    </>
  );
}
