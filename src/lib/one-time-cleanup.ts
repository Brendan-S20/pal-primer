/** A one-time cleanup: one pet-waste visit sold on its own, on the booking
 *  link (a pet-waste service set to "One visit", #574) or on a quote.
 *
 *  Decision D12 (R2-37, Brendan, 2026-11-08): the price is each business's,
 *  never a number in this file. It is two of the owner's own settings, both
 *  of which already existed and are reused rather than copied:
 *
 *    the visit          organizations.one_off_price_cents, Settings → Client
 *                       portal → Price of an extra visit. The one place a
 *                       pet-waste one-off's set price lives (#641): the
 *                       office's one-off dialog, the portal's extra cleanup
 *                       and the AI receptionist already book at it. Left
 *                       blank, the visit falls back to the zone's own
 *                       one-visit price (Zones & pricing), which is what the
 *                       link charged before this file.
 *    the first cleanup  organizations.first_cleanup_pricing (Zones & pricing
 *                       → First cleanup), priced by public_quote as for a
 *                       repeating plan. Off means none.
 *
 *  And the rule that goes with it: the customer is shown both lines and their
 *  sum BEFORE confirming, and is charged that sum. The sum shown
 *  (`oneTimeCleanupTotal`) and the sum charged (`signupChargeFromQuote`) are
 *  the same addition over the same server-priced quote, and
 *  tests/a-one-time-cleanup-shows-what-it-charges.test.tsx holds them equal. */

/** The visit's price: the owner's extra-visit price when they set one, the
 *  zone's one-visit price otherwise. A value that is not whole, non-negative
 *  cents is treated as not set, the same bounds as
 *  organizations_one_off_price_cents_check. */
export function oneTimeCleanupVisitCents(input: {
  zoneVisitCents: number | null;
  oneOffPriceCents: number | null | undefined;
}): number | null {
  const set = input.oneOffPriceCents;
  if (typeof set === "number" && Number.isInteger(set) && set >= 0 && set <= 1_000_000) return set;
  return input.zoneVisitCents;
}

/** Whether the link's quote for this service is a one-time CLEANUP, priced
 *  here: a pet-waste service the owner sells as one visit. Every other line
 *  sold as one visit is priced at the service's own price by public_quote. */
export function isOneTimeCleanup(
  mode: string,
  named: { service_line: string } | null | undefined,
): boolean {
  return mode === "one_time" && named?.service_line === "pet_waste";
}

/** A public_quote row repriced as a one-time cleanup: the visit at the
 *  owner's price. The first cleanup is left exactly as public_quote priced
 *  it. Like asPackageQuote, the only inputs are the database's row and the
 *  database's setting; nothing the browser sent is a price. */
export function asOneTimeCleanupQuote<Q extends { recurring_price_cents: number | null }>(
  q: Q,
  oneOffPriceCents: number | null | undefined,
): Q {
  return {
    ...q,
    recurring_price_cents: oneTimeCleanupVisitCents({
      zoneVisitCents: q.recurring_price_cents,
      oneOffPriceCents,
    }),
  };
}

export const ONE_TIME_CLEANUP_COPY = {
  /** The visit's line on the booking link and on a quote. */
  visitLine: "One-time cleanup visit",
  /** The first cleanup's line, as the link already words it. */
  firstCleanupLine: "First cleanup (one-time)",
  /** The sum, above the button. */
  totalLabel: "Total today",
  /** Under the total, in place of the session wording. */
  chargedOnce: "You're charged once for this cleanup. Nothing repeats.",
} as const;

/** Under the extra-visit price in Settings → Client portal, for a business
 *  that scoops: the same number prices a one-time cleanup. */
export const ONE_TIME_CLEANUP_SETTING_HINT =
  "It is also the visit price of a one-time cleanup on your booking link and on quotes. The first-cleanup fee added to it is set in Zones & pricing. Left blank, the booking link uses the zone's visit price.";

export type OneTimeCleanupLine = { key: "first_cleanup" | "visit"; label: string; cents: number };

/** The lines and the total a customer is shown for a one-time cleanup. The
 *  first cleanup is listed only when it costs something; the total is always
 *  visit + first cleanup, which is what signupChargeFromQuote charges. Null
 *  when either part cannot be priced yet (an unanswered tier, an unpriced
 *  visit): no total is shown rather than a wrong one. */
export function oneTimeCleanupTotal(input: {
  visitCents: number | null;
  firstCleanupCents: number | null;
}): { lines: OneTimeCleanupLine[]; totalCents: number } | null {
  if (input.visitCents == null || input.firstCleanupCents == null) return null;
  const visit = Math.max(0, Math.round(input.visitCents));
  const first = Math.max(0, Math.round(input.firstCleanupCents));
  const lines: OneTimeCleanupLine[] = [];
  if (first > 0) {
    lines.push({
      key: "first_cleanup",
      label: ONE_TIME_CLEANUP_COPY.firstCleanupLine,
      cents: first,
    });
  }
  lines.push({ key: "visit", label: ONE_TIME_CLEANUP_COPY.visitLine, cents: visit });
  return { lines, totalCents: visit + first };
}

/** The visit as a quote line, in the editor's shape: one time, at the owner's
 *  extra-visit price, or a blank price for the office to type when the owner
 *  has not set one. The first cleanup is its own line
 *  (first-cleanup.ts, firstCleanupQuoteLine), so the quote document lists
 *  both and its One-time total is their sum. */
export function oneTimeCleanupQuoteLine(oneOffPriceCents: number | null | undefined): {
  description: string;
  quantity: string;
  price: string;
  recurring: false;
} {
  const cents = oneTimeCleanupVisitCents({ zoneVisitCents: null, oneOffPriceCents });
  return {
    description: ONE_TIME_CLEANUP_COPY.visitLine,
    quantity: "1",
    price: cents == null ? "" : (cents / 100).toFixed(2),
    recurring: false,
  };
}
