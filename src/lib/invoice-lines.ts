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

// ── Discount lines (#653, R2-16) ────────────────────────────────────────────
//
// A discount is a line with a minus amount: "Loyalty discount  -$5.00". It was
// typed into New invoice and then dropped before the invoice was saved, so
// $20 - $5 came out as $20. Every sum in the product already reads
// amount_cents as a signed number (the invoice total, the PDF, the portal, the
// pay page, QuickBooks and Xero), and a payment is one PaymentIntent for the
// invoice's net balance, never one Stripe line per invoice line, so the only
// things a discount needs are the rules below, kept in one place so the form
// and the server refuse the same thing in the same words.

/** What a line on a hand-made invoice is, for the rules below. */
export type ManualLineShape = {
  amountCents: number;
  quantity?: number;
  unitAmountCents?: number;
  visitId?: string;
  addonChargeId?: string;
};

export const DISCOUNT_NEEDS_ONE =
  "A discount is one line: leave its quantity at 1 and put the whole discount in the price.";
export const DISCOUNT_NOT_ON_WORK =
  "A discount can't be a visit or an add-on. Add it as its own line.";
export const DISCOUNT_MORE_THAN_CHARGES =
  "The discounts are more than the charges. An invoice can't come to less than $0.01.";

/** Why this one line cannot go on an invoice as a discount, or null. A line
 *  with a minus amount is a total only (the database holds an itemized line's
 *  unit price at zero or more), and it is not a visit or an add-on: those
 *  are work, and a visit's line is what stops the billing run billing it. */
export function discountLineProblem(l: ManualLineShape): string | null {
  if (!(l.amountCents < 0)) return null;
  if (l.visitId !== undefined || l.addonChargeId !== undefined) return DISCOUNT_NOT_ON_WORK;
  if (l.quantity !== undefined || l.unitAmountCents !== undefined) return DISCOUNT_NEEDS_ONE;
  return null;
}

/** The invoice's subtotal: every line added up, discounts included. */
export function manualSubtotalCents(lines: ReadonlyArray<Pick<ManualLineShape, "amountCents">>) {
  return lines.reduce((s, l) => s + l.amountCents, 0);
}

/** Why these lines cannot make an invoice, or null. An invoice with a
 *  discount must still come to at least a cent: a $0 or minus invoice is a
 *  credit, and credit has its own ledger (post_credit_entry). */
export function manualLinesProblem(lines: ReadonlyArray<ManualLineShape>): string | null {
  for (const l of lines) {
    const p = discountLineProblem(l);
    if (p) return p;
  }
  if (lines.some((l) => l.amountCents < 0) && manualSubtotalCents(lines) < 1) {
    return DISCOUNT_MORE_THAN_CHARGES;
  }
  return null;
}

/** A line as the New invoice form holds it: three strings and a link. */
export type DraftInvoiceLine = {
  description: string;
  quantity: string;
  price: string;
  visitId?: string;
  addonChargeId?: string;
};

export type ManualItem = { description: string } & ManualLineShape;

/** What the form sends, and what it says before it lets anyone send it.
 *
 *  A line with no description, or with a quantity that is not one, is left
 *  out (the button is disabled for the second). A $0 line is left out unless
 *  it names a visit. A minus line is SENT: it is a discount, and leaving it
 *  out is what made $20 - $5 read $20 (#653). */
export function draftInvoiceItems(drafts: ReadonlyArray<DraftInvoiceLine>): {
  items: ManualItem[];
  badQuantity: boolean;
  problem: string | null;
  totalCents: number;
} {
  const parsed = drafts.map((d) => {
    const quantity = parseQuantity(d.quantity);
    const unitCents = Math.round((parseFloat(d.price) || 0) * 100);
    return {
      description: d.description.trim(),
      quantity,
      unitCents,
      amountCents: quantity === null ? 0 : lineTotalCents(quantity, unitCents),
      visitId: d.visitId,
      addonChargeId: d.addonChargeId,
    };
  });
  const badQuantity = parsed.some((l) => l.description && l.quantity === null);
  const items: ManualItem[] = parsed
    .filter((l) => l.description && l.quantity !== null && (l.amountCents !== 0 || l.visitId))
    .map((l) => {
      const link = {
        ...(l.visitId ? { visitId: l.visitId } : {}),
        ...(l.addonChargeId ? { addonChargeId: l.addonChargeId } : {}),
      };
      return l.quantity === 1
        ? { description: l.description, amountCents: l.amountCents, ...link }
        : {
            description: l.description,
            amountCents: l.amountCents,
            quantity: l.quantity!,
            unitAmountCents: l.unitCents,
            ...link,
          };
    });
  return {
    items,
    badQuantity,
    problem: items.length ? manualLinesProblem(items) : null,
    totalCents: manualSubtotalCents(items),
  };
}
