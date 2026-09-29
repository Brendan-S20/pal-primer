/** Quantity on an invoice line.
 *
 *  `amount_cents` is the line TOTAL and is the only number anything adds up.
 *  `quantity` and `unit_amount_cents` are detail beside it: what the customer
 *  reads as "3 × $15.00", and what QuickBooks and Xero receive as Qty and
 *  UnitPrice. The database holds them together with
 *  `invoice_line_items_total_is_quantity_times_unit`, and `lineTotalCents` is
 *  the same rounding on this side, so a line the form accepts is a line the
 *  database accepts. */

export type LineDetail = {
  amount_cents: number;
  quantity?: number | string | null;
  unit_amount_cents?: number | null;
};

/** The largest quantity the column holds, numeric(10,2). */
export const QUANTITY_MAX = 99_999_999.99;

/** round(quantity × unit), matching Postgres's `round(numeric)`: half away
 *  from zero. Done in hundredths of a unit so no float product lands a
 *  hair either side of .5. */
export function lineTotalCents(quantity: number, unitCents: number): number {
  const hundredths = Math.round(quantity * 100);
  return Math.round((hundredths * unitCents) / 100);
}

/** A typed quantity, or null when it is not one: positive, at most two
 *  decimal places, within the column. "1.5" and "2" are; "0", "-1", "1.255"
 *  and "" are not. */
export function parseQuantity(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  if (!(n > 0) || n > QUANTITY_MAX) return null;
  return n;
}

function asNumber(q: LineDetail["quantity"]): number {
  const n = typeof q === "string" ? Number(q) : (q ?? 1);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** "3 × $15.00" for an itemized line, null for a line that is only a total
 *  or is one of something (where "1 × $15.00" beside "$15.00" says nothing). */
export function lineQuantityLabel(
  li: LineDetail,
  formatCents: (cents: number) => string,
): string | null {
  if (li.unit_amount_cents == null) return null;
  const q = asNumber(li.quantity);
  if (q === 1) return null;
  return `${q.toLocaleString("en-US", { maximumFractionDigits: 2 })} × ${formatCents(li.unit_amount_cents)}`;
}

/** What an accounting system is sent for one line.
 *
 *  Both QuickBooks and Xero recompute Qty × UnitPrice and either reject a
 *  line whose product is not its Amount (QuickBooks) or silently post their
 *  own rounding of it (Xero). For a whole-number quantity the product is
 *  exact, so the detail goes across. For a fractional one — 2.5 hours at
 *  $13.33 — a cent can land differently on their side, so it is sent as one
 *  of the line total with the quantity written into the description, and the
 *  books agree with the invoice to the cent. */
export function accountingLine(
  li: LineDetail & { description: string | null },
  formatCents: (cents: number) => string,
): { description: string; quantity: number; unitAmount: number; amount: number } {
  const description = li.description ?? "Service";
  const amount = li.amount_cents / 100;
  const q = asNumber(li.quantity);
  if (li.unit_amount_cents != null && Number.isInteger(q)) {
    return { description, quantity: q, unitAmount: li.unit_amount_cents / 100, amount };
  }
  const label = lineQuantityLabel(li, formatCents);
  return {
    description: label ? `${description} (${label})` : description,
    quantity: 1,
    unitAmount: amount,
    amount,
  };
}
