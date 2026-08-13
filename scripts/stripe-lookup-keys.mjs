// The script-side twin of `src/lib/stripe-lookup-keys.ts`.
//
// `check-stripe-catalog.mjs` runs under plain node with no bundler, so it
// cannot import the TypeScript module the app uses. Rather than let the naming
// rule live in the checker as an inline string template — where it would drift
// from the app's rule the first time either changed — it lives here, and
// `tests/one-name-per-price.test.ts` imports BOTH files and asserts they agree
// on every slug and kind the live catalog actually contains.
//
// That is the same shape as the TS↔SQL permission parity test: two runtimes
// that cannot share code, one rule, and a test that fails when they diverge.
//
// If you edit this file, edit the TypeScript twin. The test will tell you.

/** @typedef {"base_monthly"|"base_annual"|"seat_monthly"|"seat_annual"} PlanPriceKind */

export const PLAN_PRICE_KINDS = ["base_monthly", "base_annual", "seat_monthly", "seat_annual"];

/** One normal form, underscores — see the note in the TypeScript twin. */
function normalizeSlug(slug) {
  return String(slug)
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
}

/** `launch` + `base_monthly` → `launch_base_monthly`. */
export function planLookupKey(slug, kind) {
  return `${normalizeSlug(slug)}_${kind}`;
}

/** `ai-receptionist` → `addon_ai_receptionist`. The prefix keeps add-ons out of
 *  the plans' namespace — see the twin for why that matters. */
export function addonLookupKey(slug) {
  return `addon_${normalizeSlug(slug)}`;
}

export const PLAN_PRICE_ID_COLUMN = {
  base_monthly: "stripe_price_id",
  base_annual: "stripe_annual_price_id",
  seat_monthly: "stripe_seat_price_id",
  seat_annual: "stripe_annual_seat_price_id",
};
