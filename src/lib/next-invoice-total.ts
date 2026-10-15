// The total under Settings > Plan & billing > "Your next invoice".
//
// A line whose price Stripe did not give us (unitAmountCents null) is drawn as
// "-", and the total used to skip it and print the sum of the rest: a plan row
// reading "-" above "Monthly total $0.00/mo" (A-07). A sum with an unknown term
// in it is unknown, so the answer is null and the page draws a dash.

export type NextInvoiceLine = {
  quantity: number | null;
  unitAmountCents: number | null;
  interval: string | null;
  intervalCount: number;
};

/** Cents per plan interval, or null when any line's price is unknown. Lines
 *  billed on a different interval are left out, as the label says. */
export function nextInvoiceTotalCents(
  items: NextInvoiceLine[],
  planInterval: string,
): number | null {
  let total = 0;
  for (const i of items) {
    if (i.unitAmountCents == null) return null;
    if (i.interval === planInterval && i.intervalCount === 1) {
      total += i.unitAmountCents * (i.quantity ?? 1);
    }
  }
  return total;
}
