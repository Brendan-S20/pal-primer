// The total under Settings > Plan & billing > "Your next invoice".
//
// A line whose price Stripe did not give us (unitAmountCents null) is metered
// usage: its amount is only known once the period closes. The total used to
// skip it and print the sum of the rest as if that were the whole bill, so a
// usage-only plan read "Monthly total $0.00/mo" (A-07). The page now prints
// the priced lines' sum with "+ usage" after it ("$199.00/mo + usage"), and
// "Usage only" when no line on the plan's interval has a price, never a $0.00
// that the server did not say.

export type NextInvoiceLine = {
  quantity: number | null;
  unitAmountCents: number | null;
  interval: string | null;
  intervalCount: number;
};

export type NextInvoiceTotal = {
  /** Sum of the priced lines on the plan's interval, in cents. */
  knownCents: number;
  /** At least one line on the plan's interval has a price. */
  hasKnown: boolean;
  /** At least one line on the plan's interval has no price (usage). */
  hasUsage: boolean;
};

/** The plan-interval total, split into what is priced and whether usage is
 *  added on top. Lines billed on a different interval are left out, as the
 *  label says. */
export function nextInvoiceTotalCents(
  items: NextInvoiceLine[],
  planInterval: string,
): NextInvoiceTotal {
  let knownCents = 0;
  let hasKnown = false;
  let hasUsage = false;
  for (const i of items) {
    if (i.interval !== planInterval || i.intervalCount !== 1) continue;
    if (i.unitAmountCents == null) {
      hasUsage = true;
    } else {
      hasKnown = true;
      knownCents += i.unitAmountCents * (i.quantity ?? 1);
    }
  }
  return { knownCents, hasKnown, hasUsage };
}
