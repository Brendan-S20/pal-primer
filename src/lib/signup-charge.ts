/** What the online signup charges, from the quote the SERVER just priced.
 *
 *  The one input is a row `public_quote` returned. There is deliberately no
 *  parameter for anything the customer's browser sent: the browser sends a
 *  ZIP, a dog count, a frequency and a tier id, the database prices them, and
 *  this adds up what the database said. A price in the request body has
 *  nowhere to go. (`signupCheckoutSchema` strips unknown keys before the
 *  handler sees them, so it would not reach here anyway; the absence of a
 *  parameter is the second lock.) */
export type PricedSignupQuote = {
  initial_cleanup_cents: number | null;
  recurring_price_cents: number;
  first_cleanup_mode?: string | null;
  first_cleanup_label?: string | null;
};

export type SignupCharge = {
  firstCleanupCents: number;
  recurringCents: number;
  amountCents: number;
  /** The tier's label, for the invoice line. Null unless priced by tier. */
  firstCleanupLabel: string | null;
};

/** Thrown when the owner prices by "when was your yard last cleaned?" and the
 *  customer has not answered, or answered with a tier the owner removed. */
export const NEEDS_LAST_CLEANED =
  "Tell us when your yard was last cleaned so we can price the first cleanup.";

export function signupChargeFromQuote(q: PricedSignupQuote): SignupCharge {
  if (q.initial_cleanup_cents == null) throw new Error(NEEDS_LAST_CLEANED);
  const firstCleanupCents = Math.max(0, Math.round(q.initial_cleanup_cents));
  const recurringCents = Math.max(0, Math.round(q.recurring_price_cents));
  return {
    firstCleanupCents,
    recurringCents,
    amountCents: firstCleanupCents + recurringCents,
    firstCleanupLabel:
      q.first_cleanup_mode === "by_last_cleaned" ? (q.first_cleanup_label ?? null) : null,
  };
}

/** The per-tier prices `public_quote` lists for this yard, typed. */
export function parseQuoteOptions(
  raw: unknown,
): Array<{ id: string; label: string; priceCents: number }> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((o) => {
    if (!o || typeof o !== "object") return [];
    const { id, label, price_cents } = o as Record<string, unknown>;
    if (typeof id !== "string" || typeof label !== "string" || typeof price_cents !== "number") {
      return [];
    }
    return [{ id, label, priceCents: price_cents }];
  });
}
