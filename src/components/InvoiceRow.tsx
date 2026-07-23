// ONE invoice list row (QA round 3, B4 + I3). The Invoices page and the client
// Billing tab both render this — same columns, same status/kind chips, same
// click-to-open-drawer behavior — so there is a single invoice-row + preview
// implementation instead of two divergent ones. The trailing cell is a
// Salesforce-style RowActions trio: View opens the drawer, and ••• carries
// "Open full invoice" + "Copy pay link" plus any caller-supplied actions
// (the Invoices page lifts send/remind/mark-paid/void in). Take payment
// stays drawer-only — it is an embedded payment view, not a one-shot action.
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { RowActions, type RowAction } from "@/components/RowActions";
import { MetaChip, StatusChip } from "@/components/client-detail/primitives";
import { isInvoiceOverdue } from "@/lib/overdue";
import { formatDay } from "@/lib/format";
import { invoiceKindLabel } from "@/lib/invoice-labels";

export type InvoiceRowData = {
  id: string;
  status: string;
  kind?: string | null;
  currency?: string | null;
  total_cents: number | null;
  period_start: string | null;
  period_end: string | null;
  due_on: string | null;
  send_after?: string | null;
  sent_at?: string | null;
  public_token?: string | null;
  clients?:
    | { display_name: string | null }
    | Array<{ display_name: string | null }>
    | null;
};

function fmtCents(c: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: (currency || "usd").toUpperCase(),
  }).format((c ?? 0) / 100);
}

/** "Wed, May 28 to Wed, Jun 25" instead of raw ISO dates. */
export function invoicePeriodLabel(
  start: string | null | undefined,
  end: string | null | undefined,
) {
  if (start && end) return `${formatDay(start)} to ${formatDay(end)}`;
  return formatDay(end ?? start) || "-";
}

export function InvoiceRow({
  invoice,
  showClient = false,
  selectable = false,
  selected = false,
  onToggleSelect,
  onOpen,
  actions = [],
}: {
  invoice: InvoiceRowData;
  /** Invoices page: shows the client column. Client tab: hidden (one client). */
  showClient?: boolean;
  /** Invoices page: bulk-select checkbox column. Client tab: hidden. */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (next: boolean) => void;
  onOpen: (invoiceId: string) => void;
  /** Extra ••• items appended after the built-in ones (Invoices page lifts
   * the drawer's send / remind / mark paid / void here). */
  actions?: RowAction[];
}) {
  const navigate = useNavigate();
  const client = Array.isArray(invoice.clients) ? invoice.clients[0] : invoice.clients;
  const overdue = isInvoiceOverdue(invoice.status, invoice.due_on);
  // Only the non-default kind (a prepaid top-up) is worth a chip; a plain
  // "Service" invoice needs no label. Either way the enum is never shown raw.
  const showKind = invoice.kind === "prepaid_topup";

  // Built-in ••• actions available anywhere the row renders; callers append
  // page-specific ones via `actions`. Copy pay link mirrors the drawer's
  // gating: open invoices only, and only when the token is in the row data.
  const menuActions: RowAction[] = [
    {
      label: "Open full invoice",
      onSelect: () =>
        navigate({ to: "/invoices/$invoiceId", params: { invoiceId: invoice.id } }),
    },
    ...(invoice.status === "open" && invoice.public_token
      ? [
          {
            label: "Copy pay link",
            onSelect: () => {
              const url = `${window.location.origin}/pay/i/${invoice.public_token}`;
              navigator.clipboard.writeText(url).then(
                () => toast.success("Pay link copied to clipboard"),
                () => toast.error("Copy failed"),
              );
            },
          },
        ]
      : []),
    ...actions,
  ];

  return (
    <tr
      className="cursor-pointer border-b last:border-0 hover:bg-muted/30"
      onClick={() => onOpen(invoice.id)}
    >
      {selectable && (
        <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={selected}
            onCheckedChange={(v) => onToggleSelect?.(!!v)}
            aria-label={`Select invoice for ${client?.display_name ?? "client"}`}
          />
        </td>
      )}
      {showClient && (
        <td className="px-4 py-2.5 font-medium">{client?.display_name ?? "-"}</td>
      )}
      <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
        #{invoice.id.slice(0, 8)}
      </td>
      <td className="px-4 py-2.5 text-muted-foreground">
        {invoicePeriodLabel(invoice.period_start, invoice.period_end)}
      </td>
      <td className="px-4 py-2.5">
        {invoice.due_on && invoice.status !== "paid" && invoice.status !== "void" ? (
          <span className={overdue ? "font-medium text-destructive" : "text-muted-foreground"}>
            {formatDay(invoice.due_on)}
            {overdue && (
              <span className="ml-1.5 rounded-full bg-destructive/15 px-1.5 py-0.5 text-xs">
                Overdue
              </span>
            )}
          </span>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums">
        {fmtCents(invoice.total_cents ?? 0, invoice.currency ?? "usd")}
      </td>
      <td className="px-4 py-2.5">
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <StatusChip status={invoice.status} />
          {showKind && <MetaChip>{invoiceKindLabel(invoice.kind)}</MetaChip>}
          {invoice.status === "open" && !invoice.sent_at && invoice.send_after && (
            <MetaChip>Scheduled to send {formatDay(invoice.send_after)}</MetaChip>
          )}
          {invoice.sent_at && <MetaChip>Sent {formatDay(invoice.sent_at)}</MetaChip>}
        </span>
      </td>
      <td className="px-4 py-2.5 text-right">
        <RowActions
          view={{
            label: `View invoice for ${client?.display_name ?? "client"}`,
            onSelect: () => onOpen(invoice.id),
          }}
          actions={menuActions}
        />
      </td>
    </tr>
  );
}
