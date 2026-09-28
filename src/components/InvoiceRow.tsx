// ONE invoice list row (QA round 3, B4 + I3). The Invoices page and the client
// Billing tab both render this — same columns, same status/kind chips, same
// click-to-open-drawer behavior — so there is a single invoice-row + preview
// implementation instead of two divergent ones. The trailing cell is a
// Salesforce-style RowActions trio: View opens the drawer, and ••• carries
// "Open full invoice" + "Copy pay link" plus any caller-supplied actions
// (the Invoices page lifts send/remind/mark-paid/void in). Take payment
// stays drawer-only — it is an embedded payment view, not a one-shot action.
//
// Mobile Phase 2: InvoiceCard below is the phone-sized presentation of the
// SAME row — same data shape, same built-in ••• actions (via
// useInvoiceMenuActions), same drawer-opening tap. It lives here, not in the
// page, so the B4 "one invoice-row implementation" mandate holds.
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { RowActions, type RowAction } from "@/components/RowActions";
import { MetaChip, StatusChip } from "@/components/client-detail/primitives";
import { isInvoiceOverdue } from "@/lib/overdue";
import { useOrgToday } from "@/hooks/useOrgToday";
import { formatDay } from "@/lib/format";
import { invoiceKindLabel, invoiceNumberLabel } from "@/lib/invoice-labels";
import { appUrl } from "@/lib/app-origin";

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

/** Built-in ••• actions available anywhere the row/card renders; callers
 * append page-specific ones via `actions`. Copy pay link mirrors the drawer's
 * gating: open invoices only, and only when the token is in the row data. */
function useInvoiceMenuActions(invoice: InvoiceRowData, actions: RowAction[]): RowAction[] {
  const navigate = useNavigate();
  return [
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
              // appUrl(), not window.location.origin — same reason as the
              // drawer's copy: the link is for a customer, so it has to name
              // the host the product lives at, not the one staff are on.
              const url = appUrl(`/pay/i/${invoice.public_token}`);
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
  const client = Array.isArray(invoice.clients) ? invoice.clients[0] : invoice.clients;
  // The ORG's today, not the server default. See src/hooks/useOrgToday.ts —
  // this used to take the `America/Chicago` fallback while the dashboard read
  // the real setting, so the two disagreed about the same invoice for an hour
  // a night on any org east of Central.
  const today = useOrgToday();
  const overdue = isInvoiceOverdue(invoice.status, invoice.due_on, today);
  // Only the non-default kind (a prepaid top-up) is worth a chip; a plain
  // "Service" invoice needs no label. Either way the enum is never shown raw.
  const showKind = invoice.kind === "prepaid_topup";

  const menuActions = useInvoiceMenuActions(invoice, actions);

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
        {invoiceNumberLabel(invoice)}
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

/** Phone-sized presentation of the SAME invoice row (Mobile Phase 2): client,
 * amount, status/kind/sent chips, due date, tap → drawer. Bulk-select
 * checkbox and the ••• menu are preserved on the card. Rendered by the
 * Invoices page below `md`; the table above stays the desktop rendering. */
export function InvoiceCard({
  invoice,
  selectable = false,
  selected = false,
  onToggleSelect,
  onOpen,
  actions = [],
}: {
  invoice: InvoiceRowData;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (next: boolean) => void;
  onOpen: (invoiceId: string) => void;
  actions?: RowAction[];
}) {
  const client = Array.isArray(invoice.clients) ? invoice.clients[0] : invoice.clients;
  // The ORG's today, not the server default. See src/hooks/useOrgToday.ts —
  // this used to take the `America/Chicago` fallback while the dashboard read
  // the real setting, so the two disagreed about the same invoice for an hour
  // a night on any org east of Central.
  const today = useOrgToday();
  const overdue = isInvoiceOverdue(invoice.status, invoice.due_on, today);
  const showKind = invoice.kind === "prepaid_topup";
  const menuActions = useInvoiceMenuActions(invoice, actions);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(invoice.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(invoice.id);
        }
      }}
      className="cursor-pointer rounded-lg border bg-card p-3 shadow-sm transition-colors hover:bg-muted/30 active:bg-muted/40"
    >
      <div className="flex items-start gap-3">
        {selectable && (
          <span
            className="grid min-h-10 min-w-8 place-items-center"
            onClick={(e) => e.stopPropagation()}
          >
            <Checkbox
              checked={selected}
              onCheckedChange={(v) => onToggleSelect?.(!!v)}
              aria-label={`Select invoice for ${client?.display_name ?? "client"}`}
            />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate font-medium">{client?.display_name ?? "-"}</div>
              <div className="font-mono text-xs text-muted-foreground">
                {invoiceNumberLabel(invoice)}
              </div>
            </div>
            <div className="shrink-0 text-right text-sm font-semibold tabular-nums">
              {fmtCents(invoice.total_cents ?? 0, invoice.currency ?? "usd")}
            </div>
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {invoicePeriodLabel(invoice.period_start, invoice.period_end)}
          </div>
          {invoice.due_on && invoice.status !== "paid" && invoice.status !== "void" && (
            <div
              className={`mt-0.5 text-xs ${
                overdue ? "font-medium text-destructive" : "text-muted-foreground"
              }`}
            >
              Due {formatDay(invoice.due_on)}
              {overdue && (
                <span className="ml-1.5 rounded-full bg-destructive/15 px-1.5 py-0.5">Overdue</span>
              )}
            </div>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <StatusChip status={invoice.status} />
            {showKind && <MetaChip>{invoiceKindLabel(invoice.kind)}</MetaChip>}
            {invoice.status === "open" && !invoice.sent_at && invoice.send_after && (
              <MetaChip>Scheduled to send {formatDay(invoice.send_after)}</MetaChip>
            )}
            {invoice.sent_at && <MetaChip>Sent {formatDay(invoice.sent_at)}</MetaChip>}
          </div>
        </div>
        <RowActions
          view={{
            label: `View invoice for ${client?.display_name ?? "client"}`,
            onSelect: () => onOpen(invoice.id),
          }}
          actions={menuActions}
        />
      </div>
    </div>
  );
}
