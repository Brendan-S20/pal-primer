import { lineQuantityLabel, type LineDetail } from "@/lib/invoice-lines";

/** "3 × $15.00" under an invoice line's description, or nothing for a line
 *  that is only a total. One component so the office, the drawer and the
 *  customer's pay page cannot word it three ways. */
export function LineQuantity({ line, currency }: { line: LineDetail; currency?: string | null }) {
  const fmt = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: (currency || "usd").toUpperCase(),
  });
  const label = lineQuantityLabel(line, (c) => fmt.format(c / 100));
  if (!label) return null;
  return <span className="block text-xs tabular-nums text-muted-foreground">{label}</span>;
}
