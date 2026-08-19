// What a plan has to BE before it can be created, and which Stripe prices it
// implies once it exists.
//
// ── WHY THIS IS ITS OWN FILE ──────────────────────────────────────────────
//
// Every rule below has a consequence somewhere else in the codebase, and none
// of them is enforced by the table. `platform_plans` will accept a plan with no
// `included_seats`, no `slug` you can build a lookup key from, and a currency
// nothing else in the product can add up. The row is valid; the PLAN is not,
// and the symptom arrives later — in a tenant's plan picker, or in an MRR
// number, or at checkout.
//
// It is pure and it imports nothing but the lookup-key rule, so both the server
// function and the console screen can ask the same question and get the same
// answer, and so a test can ask it without a database or a Stripe account.

import {
  PLAN_PRICE_ID_COLUMN,
  planLookupKey,
  type PlanPriceKind,
} from "@/lib/stripe-lookup-keys";

/**
 * The one currency the catalog is allowed to be in.
 *
 * Not a style preference. `platform-metrics.ts` sums `price_cents` across every
 * plan into one MRR figure with no currency term anywhere in the arithmetic, and
 * `collectedNetCents` does the same for invoices. A EUR plan beside a USD one
 * would not fail, or warn, or look wrong — it would silently add euros to
 * dollars and report the total as money. Multi-currency is a project, not a
 * dropdown, so until that project happens the catalog is single-currency and
 * says so out loud.
 */
export const PLATFORM_CATALOG_CURRENCY = "usd";

/** Lowercase, trimmed, spaces folded to hyphens. The form people actually type
 *  a slug in — `Pro Max ` — is not the form the column stores. */
export function normalizePlanSlug(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "-").replace(/-+/g, "-");
}

/**
 * Why a slug cannot be used, or null if it can.
 *
 * `platform_plans.slug` is UNIQUE, so the database already refuses an exact
 * repeat — with a constraint-violation string, in a toast, on a screen the
 * person cannot fix it from. It also refuses nothing else, and there are two
 * collisions it cannot see:
 *
 *   * `pro-max` and `pro_max` are DIFFERENT slugs to Postgres and the SAME
 *     lookup key to Stripe, because `normalizeSlug` in stripe-lookup-keys.ts
 *     folds hyphens to underscores. Two plans, one `pro_max_base_monthly`, and
 *     whichever was created second would either fail to mint its price or
 *     quietly resolve to the other plan's — which is a subscription billed at
 *     another plan's rate.
 *   * a slug beginning `addon-` puts a plan's keys inside the add-on
 *     namespace: plan `addon-foo` wants `addon_foo_base_monthly`, and an add-on
 *     slugged `foo-base-monthly` wants exactly the same string. Vanishingly
 *     unlikely and free to prevent, which is the same trade the `addon_` prefix
 *     itself was made on.
 */
export function planSlugProblem(
  raw: string,
  existingSlugs: readonly string[],
): string | null {
  const slug = normalizePlanSlug(raw);
  if (!slug) return "A plan needs a slug — it is the name its Stripe prices answer to.";
  if (slug.length < 2 || slug.length > 40) return "A slug is between 2 and 40 characters.";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return "A slug is lowercase letters, digits and single hyphens — no spaces, underscores or punctuation.";
  }
  if (slug.startsWith("addon-")) {
    return "A slug can't start with “addon-”: that is the add-on half of the Stripe lookup-key namespace.";
  }
  // Compare on the key, not on the text. Two slugs that differ only in how
  // they separate words are one price name in Stripe.
  const keyOf = (s: string) => planLookupKey(s, "base_monthly");
  const wanted = keyOf(slug);
  for (const other of existingSlugs) {
    if (other === slug) return `The slug “${slug}” is already used by another plan.`;
    if (keyOf(other) === wanted) {
      return `“${slug}” and the existing plan “${other}” would share the Stripe price name ${wanted}.`;
    }
  }
  return null;
}

/** The fields a plan is created from. Cents throughout — dollars never reach
 *  here, exactly as `updatePlatformPlanSchema` requires. */
export type PlanShapeInput = {
  slug: string;
  currency: string;
  isEnterprise: boolean;
  /** MONTHLY base. Never annual dollars — see updatePlatformPlan's comment. */
  priceCents: number | null;
  annualPriceCents: number | null;
  includedSeats: number | null;
  pricePerSeatCents: number | null;
  interval: "month" | "year";
};

/**
 * Why a plan cannot be created, or null if it can. Each rule names the place
 * the plan would otherwise break.
 */
export function planShapeProblem(input: PlanShapeInput): string | null {
  if (input.currency !== PLATFORM_CATALOG_CURRENCY) {
    return (
      `The catalog is ${PLATFORM_CATALOG_CURRENCY.toUpperCase()}-only. Platform MRR adds every plan's ` +
      `cents together with no currency conversion, so a second currency would be added to the total as ` +
      `if it were dollars.`
    );
  }

  if (input.isEnterprise) {
    // Enterprise is the contact-us tier: `formatBase` renders "Custom" for it
    // whatever the columns say, so a base price stored here is invisible on
    // this screen and still counted by platform MRR. A number that bills and
    // cannot be seen is worse than no number.
    if (input.priceCents !== null || input.annualPriceCents !== null) {
      return "An enterprise plan is priced by contract — leave the base and annual prices blank.";
    }
    return null;
  }

  // The table's own `price_shape_present` CHECK, said in advance and in
  // English, so the person sees it in the form rather than as a constraint
  // name in a toast.
  if (input.priceCents === null) {
    return "A plan needs a monthly base price. Mark it enterprise if it is priced by contract.";
  }

  // `createPlanSubscription` selects sellable plans with
  // `.not("included_seats", "is", null)`. A plan without it still appears in
  // `listPlatformPlans`, which does not filter on it — so the tenant sees the
  // plan in the picker, chooses it, and is told "That plan isn't available.
  // Contact support." A plan you can see and cannot buy is the exact fault
  // class this round is about.
  if (input.includedSeats === null) {
    return "A plan needs an included-employee count, or no tenant can subscribe to it.";
  }

  // The 12x MRR bug, in the shape the edit dialog already guards against:
  // `monthlyEquivalentCents` divides an annual plan's base by 12, and there is
  // nothing to divide if the yearly base was never recorded.
  if (input.interval === "year" && input.annualPriceCents === null) {
    return "An annual plan needs an annual price ($/year) — MRR divides that number by 12.";
  }

  return null;
}

/** One Stripe price this plan implies: what to create, and where to keep it. */
export type PlanPriceSpec = {
  kind: PlanPriceKind;
  /** The name the price answers to in whichever account is in hand. */
  lookupKey: string;
  /** The `platform_plans` column that holds this kind's id. */
  column: string;
  unitAmountCents: number;
  interval: "month" | "year";
  /** Human-readable, matching the live catalog's ("Launch base monthly"). */
  nickname: string;
};

export type PlanPricingRow = {
  slug: string;
  name: string;
  is_enterprise: boolean;
  price_cents: number | null;
  annual_price_cents: number | null;
  price_per_seat_cents: number | null;
};

/**
 * The prices a plan row implies, in the shape the live catalog already has:
 * one product per plan carrying up to four prices, each named
 * `<slug>_<kind>`.
 *
 * ── THE ANNUAL SEAT PRICE HAS NO COLUMN ───────────────────────────────────
 *
 * `platform_plans` stores cents for the monthly base, the annual base and the
 * monthly seat — and nothing for the annual seat, which exists only as
 * `stripe_annual_seat_price_id`. `check-stripe-catalog.mjs` says so explicitly
 * and deliberately does not assert that amount, because "the annual plans carry
 * the same two-months-free discount as the base", so it is not the monthly seat
 * times twelve.
 *
 * That sentence is also the derivation. The discount the plan itself declares
 * is `annual_price_cents / price_cents`, and applying it to the monthly seat
 * reproduces the live catalog exactly: Launch 1000 x (79000/7900) = 10000,
 * Growth 1000 x (199000/19900) = 10000, Scale 1000 x (449000/44900) = 10000 —
 * the three annual seat prices that are actually in Stripe today.
 *
 * Deriving it beats asking for it: a fourth price typed by hand is a fourth
 * chance to give annual customers a discount the base price never promised,
 * and nothing in the repo would compare the two.
 */
export function planPriceSpecs(plan: PlanPricingRow): PlanPriceSpec[] {
  // Enterprise is billed by contract. The live enterprise row carries no
  // product and no price, and this keeps it that way.
  if (plan.is_enterprise) return [];

  const specs: PlanPriceSpec[] = [];
  const base = plan.price_cents;
  const annual = plan.annual_price_cents;
  const seat = plan.price_per_seat_cents;

  const push = (kind: PlanPriceKind, cents: number, interval: "month" | "year", label: string) =>
    specs.push({
      kind,
      lookupKey: planLookupKey(plan.slug, kind),
      column: PLAN_PRICE_ID_COLUMN[kind],
      unitAmountCents: cents,
      interval,
      nickname: `${plan.name} ${label}`,
    });

  // A zero base is a free plan. Stripe would accept a zero-amount price, but
  // there is nothing to charge and the two free rows in the live catalog carry
  // no Stripe ids either — so this mirrors nothing rather than minting a price
  // that bills no one.
  if (base !== null && base > 0) push("base_monthly", base, "month", "base monthly");
  if (annual !== null && annual > 0) push("base_annual", annual, "year", "base annual");
  if (seat !== null && seat > 0) push("seat_monthly", seat, "month", "per-seat monthly");
  if (seat !== null && seat > 0 && annual !== null && annual > 0 && base !== null && base > 0) {
    push("seat_annual", Math.round((seat * annual) / base), "year", "per-seat annual");
  }
  return specs;
}

/**
 * What the console should say about a plan's Stripe state.
 *
 * The Plans table used to print `stripe_price_id ?? "-"`, and a dash reads as
 * "nothing to show here" for three different situations: a plan that is billed
 * by contract, a plan that is free, and a plan that was supposed to be mirrored
 * and is not. Only the third one is a problem, and it was the one the dash hid.
 */
export type PlanMirrorState = "enterprise" | "nothing-to-mirror" | "mirrored" | "partial" | "absent";

export function planMirrorState(
  plan: PlanPricingRow & Record<string, unknown>,
): PlanMirrorState {
  if (plan.is_enterprise) return "enterprise";
  const specs = planPriceSpecs(plan);
  if (specs.length === 0) return "nothing-to-mirror";
  const present = specs.filter((s) => !!plan[s.column]).length;
  if (present === 0) return "absent";
  return present === specs.length ? "mirrored" : "partial";
}
