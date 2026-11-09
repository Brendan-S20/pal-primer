import { Badge } from "@/components/ui/badge";
import type { InvoiceRefundState } from "@/lib/refund-outcome";

/**
 * One palette for invoice status everywhere. Before this, four surfaces
 * rendered the same status four different ways ("paid" was outline on the
 * list, primary on the client tab, green in the portal) — nothing could be
 * color-scanned (P2). Green = money in, blue = awaiting payment, red = a
 * problem, gray = inert.
 */
const STYLES: Record<string, { label: string; className: string }> = {
  paid: {
    label: "Paid",
    className: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/15",
  },
  open: {
    label: "Open",
    className: "border-transparent bg-blue-500/15 text-blue-700 dark:text-blue-400 hover:bg-blue-500/15",
  },
  draft: {
    label: "Draft",
    className: "border-transparent bg-muted text-muted-foreground hover:bg-muted",
  },
  void: {
    label: "Void",
    className: "text-muted-foreground",
  },
  uncollectible: {
    label: "Uncollectible",
    className: "border-transparent bg-destructive/15 text-destructive hover:bg-destructive/15",
  },
};

/** A paid invoice whose money went back (#674). "Paid" there would say the
 *  money was kept; these say it was not, in the same palette: gray for all of
 *  it back, amber for some. */
const REFUND_STYLES: Record<
  Exclude<InvoiceRefundState, null>,
  { label: string; className: string }
> = {
  refunded: {
    label: "Refunded",
    className: "border-transparent bg-muted text-muted-foreground hover:bg-muted",
  },
  partly_refunded: {
    label: "Partly refunded",
    className:
      "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400 hover:bg-amber-500/15",
  },
};

export function InvoiceStatusBadge({
  status,
  refund = null,
}: {
  status: string;
  /** From `invoiceRefundState`; absent reads as no refund. */
  refund?: InvoiceRefundState;
}) {
  const s = (refund ? REFUND_STYLES[refund] : null) ?? STYLES[status];
  if (!s) return <Badge variant="secondary">{status}</Badge>;
  return (
    <Badge variant={status === "void" ? "outline" : "secondary"} className={s.className}>
      {s.label}
    </Badge>
  );
}
