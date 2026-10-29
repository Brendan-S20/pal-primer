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
  /** NULL for a service the owner has not priced yet (phase 5): "we cannot
   *  price this", which nothing may charge. Never NULL for pet waste. */
  recurring_price_cents: number | null;
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

/** Thrown when the chosen service has no online price (the owner unpriced it
 *  between the page loading and the button). public_quote says so with NULL
 *  prices; a pet-waste quote never does, so this never fires for one. */
export const SERVICE_NOT_PRICED =
  "That service doesn't have an online price yet. Pick another, or ask us for a quote.";

export function signupChargeFromQuote(q: PricedSignupQuote): SignupCharge {
  if (q.recurring_price_cents == null) throw new Error(SERVICE_NOT_PRICED);
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

/** The charge for how the service starts (#574), from the server's own
 *  terms: a repeating plan and one visit are what the quote says (the first
 *  cleanup, if any, plus one visit; one visit is priced as one session), and
 *  a package is the package's price, once, with no first cleanup. The
 *  package comes from the service_packages row the server read, never from
 *  the request. `recurringCents` is what the signup row records as the
 *  price of one: a session's share of a package. */
export function signupChargeForTerms(
  q: PricedSignupQuote,
  terms: {
    mode: "one_time" | "recurring" | "package";
    pkg: { price_cents: number; sessions_count: number } | null;
  },
): SignupCharge {
  if (terms.mode !== "package") return signupChargeFromQuote(q);
  if (!terms.pkg || !(terms.pkg.price_cents > 0)) throw new Error(SERVICE_NOT_PRICED);
  const amountCents = Math.round(terms.pkg.price_cents);
  return {
    firstCleanupCents: 0,
    recurringCents: Math.round(amountCents / Math.max(1, terms.pkg.sessions_count)),
    amountCents,
    firstCleanupLabel: null,
  };
}
