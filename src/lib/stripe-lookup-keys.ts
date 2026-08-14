// The one name a price answers to, in whichever Stripe account you are holding.
//
// ── WHY A NAME AND NOT AN ID ──────────────────────────────────────────────
//
// `platform_plans.stripe_price_id` stores a LIVE price id, because that is the
// account the product bills on. Stripe mints ids per account, so the same
// $79 Launch base price is `price_1U0Tkd…` live and `price_1U483N…` in the
// sandbox. A test-mode run resolving through the database therefore asks a test
// key for a live id and gets nothing — which is why there has never been a way
// to exercise signup, subscription or invoicing without touching real money.
//
// A `lookup_key` is Stripe's own answer to this: a string YOU choose, unique
// per account, that both accounts can carry. Ask for `launch_base_monthly` and
// the account you are pointed at hands back its own price.
//
// Both accounts now carry these eighteen keys (set 2026-08-13), so the rule
// below is not aspirational — it describes what is in Stripe.
//
// ── THIS FILE HAS A TWIN ──────────────────────────────────────────────────
//
// `scripts/stripe-lookup-keys.mjs` implements the same rule for
// `check-stripe-catalog.mjs`, which runs under plain node and cannot import
// TypeScript. Two implementations of one rule is exactly the drift this
// codebase keeps finding, so `tests/one-name-per-price.test.ts` imports both
// and asserts they agree on every slug and kind the catalog actually contains.
// If you change the shape here, that test fails until the twin matches.

/** The four prices a paid plan carries. Mirrors PLAN_PRICE_FIELDS in the
 *  catalog check, and the `kind` metadata on every price in Stripe. */
export const PLAN_PRICE_KINDS = [
  "base_monthly",
  "base_annual",
  "seat_monthly",
  "seat_annual",
] as const;

export type PlanPriceKind = (typeof PLAN_PRICE_KINDS)[number];

/**
 * Slugs reach this from two directions with two spellings: plan slugs are
 * already bare words (`launch`), add-on slugs are hyphenated
 * (`white-label-portal`). Stripe lookup keys allow both, but allowing both
 * HERE would mean `white-label-portal` and `white_label_portal` are different
 * keys for one add-on, and only one of them would exist in Stripe.
 *
 * So there is a single normal form and it is underscores.
 */
function normalizeSlug(slug: string): string {
  return slug
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
}

/** `launch` + `base_monthly` → `launch_base_monthly`. */
export function planLookupKey(slug: string, kind: PlanPriceKind): string {
  return `${normalizeSlug(slug)}_${kind}`;
}

/**
 * `ai-receptionist` → `addon_ai_receptionist`.
 *
 * The `addon_` prefix is not decoration. A plan slug and an add-on slug live in
 * one namespace inside a Stripe account, and nothing stops someone naming a
 * future add-on after a plan. Without the prefix that add-on would silently
 * take the plan's key, and the failure would be a subscription billed at the
 * wrong price rather than an error.
 */
export function addonLookupKey(slug: string): string {
  return `addon_${normalizeSlug(slug)}`;
}

/** Which column on `platform_plans` holds the id for each kind. Kept beside
 *  the naming rule so a new kind cannot be added to one and not the other. */
export const PLAN_PRICE_ID_COLUMN: Record<PlanPriceKind, string> = {
  base_monthly: "stripe_price_id",
  base_annual: "stripe_annual_price_id",
  seat_monthly: "stripe_seat_price_id",
  seat_annual: "stripe_annual_seat_price_id",
};
