// A new plan can be wrong in four ways the database is perfectly happy with,
// and every one of them surfaces somewhere else, later, as somebody else's bug.
//
// ── 1. A PRICE ONLY ONE STRIPE ACCOUNT CAN FIND ───────────────────────────
//
// `stripe-lookup-keys.ts` and `stripe-price-catalog.server.ts` exist because
// every price id in `platform_plans` is a LIVE id, ids are minted per account,
// and a test key asking for a live id gets nothing — so signup, subscribe,
// invoice and webhook could not be exercised outside the real account at all.
// The fix was to give every price a `lookup_key` and resolve by NAME.
//
// The add-on creation path — the only prior art for minting a Stripe price in
// this repo — does not do that. `platform-addons.functions.ts` calls
// `stripe.prices.create({ product, unit_amount, currency, recurring })` with no
// `lookup_key` at all and stores the id it gets back. Copying that shape for
// plans would have re-opened the hole for every plan created from here on, in
// the file whose own comments explain why the hole was closed.
//
// ── 2. A SLUG TWO PLANS SHARE IN STRIPE ───────────────────────────────────
//
// `platform_plans.slug` is UNIQUE, and `normalizeSlug` folds hyphens to
// underscores. So `pro-max` and `pro_max` are two rows to Postgres and ONE
// price name to Stripe. Whichever was created second either fails to mint its
// prices or silently resolves to the other plan's — a subscription billed at a
// price the page never showed.
//
// ── 3. A PLAN YOU CAN SEE AND CANNOT BUY ──────────────────────────────────
//
// `listPlatformPlans` (the tenant plan picker) does not filter on
// `included_seats`. `createPlanSubscription` selects sellable plans with
// `.not("included_seats", "is", null)`. A plan with no included-employee count
// is therefore in the picker and rejected at checkout with "That plan isn't
// available. Contact support." The table will store it; the product cannot
// sell it.
//
// ── 4. AN ANNUAL SEAT PRICE WITH NOWHERE TO COME FROM ─────────────────────
//
// `platform_plans` stores cents for the monthly base, the annual base and the
// monthly seat — and nothing for the annual seat, which exists only as
// `stripe_annual_seat_price_id`. `check-stripe-catalog.mjs` says so and
// deliberately refuses to assert that amount, because the annual plans carry
// the same two-months-free discount as the base rather than being twelve times
// the monthly.
//
// That sentence is also the derivation, and it is checkable: applying the
// plan's own declared annual discount to its monthly seat price reproduces all
// three annual seat prices that are in the live Stripe account today. The
// figures below are from that account (read on 2026-08-19), not invented.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  normalizePlanSlug,
  planMirrorState,
  planPriceSpecs,
  planShapeProblem,
  planSlugProblem,
  PLATFORM_CATALOG_CURRENCY,
  type PlanShapeInput,
} from "@/lib/platform-plan-catalog";
import { PLAN_PRICE_ID_COLUMN, planLookupKey } from "@/lib/stripe-lookup-keys";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

/** The three live per-employee plans, exactly as `platform_plans` holds them. */
const LIVE = {
  launch: {
    slug: "launch",
    name: "Launch",
    is_enterprise: false,
    price_cents: 7900,
    annual_price_cents: 79000,
    price_per_seat_cents: 1000,
  },
  growth: {
    slug: "growth",
    name: "Growth",
    is_enterprise: false,
    price_cents: 19900,
    annual_price_cents: 199000,
    price_per_seat_cents: 1000,
  },
  scale: {
    slug: "scale",
    name: "Scale",
    is_enterprise: false,
    price_cents: 44900,
    annual_price_cents: 449000,
    price_per_seat_cents: 1000,
  },
};

const sound: PlanShapeInput = {
  slug: "pro",
  currency: PLATFORM_CATALOG_CURRENCY,
  isEnterprise: false,
  priceCents: 29900,
  annualPriceCents: 299000,
  includedSeats: 15,
  pricePerSeatCents: 1000,
  interval: "month",
};

describe("every price a plan implies carries the name it will be found by", () => {
  it("names all four kinds the way the live catalog names them", () => {
    const specs = planPriceSpecs(LIVE.launch);
    expect(specs.map((s) => s.lookupKey).sort()).toEqual([
      "launch_base_annual",
      "launch_base_monthly",
      "launch_seat_annual",
      "launch_seat_monthly",
    ]);
    // These four keys are in the live Stripe account today, on those exact
    // prices — this is not a scheme invented here.
    for (const s of specs) {
      expect(s.lookupKey).toBe(planLookupKey("launch", s.kind));
      expect(s.column).toBe(PLAN_PRICE_ID_COLUMN[s.kind]);
    }
  });

  it("puts each amount on the right interval", () => {
    const by = Object.fromEntries(planPriceSpecs(LIVE.growth).map((s) => [s.kind, s]));
    expect(by.base_monthly.unitAmountCents).toBe(19900);
    expect(by.base_monthly.interval).toBe("month");
    expect(by.base_annual.unitAmountCents).toBe(199000);
    expect(by.base_annual.interval).toBe("year");
    expect(by.seat_monthly.unitAmountCents).toBe(1000);
    expect(by.seat_monthly.interval).toBe("month");
    expect(by.seat_annual.interval).toBe("year");
  });

  it("derives the annual seat price the live catalog actually charges", () => {
    // 1000 x (79000/7900) = 10000, and the same for Growth and Scale. All three
    // of those prices exist in Stripe at exactly 10000.
    for (const plan of [LIVE.launch, LIVE.growth, LIVE.scale]) {
      const seatAnnual = planPriceSpecs(plan).find((s) => s.kind === "seat_annual");
      expect(seatAnnual?.unitAmountCents, `${plan.slug} annual seat`).toBe(10000);
    }
    // And it is the DISCOUNT, not twelve times the monthly — the distinction
    // check-stripe-catalog.mjs writes out at length.
    expect(planPriceSpecs(LIVE.launch).find((s) => s.kind === "seat_annual")!.unitAmountCents)
      .not.toBe(1000 * 12);
  });

  it("mints nothing for a contract tier or a free one", () => {
    expect(planPriceSpecs({ ...LIVE.launch, is_enterprise: true })).toEqual([]);
    expect(
      planPriceSpecs({
        slug: "free",
        name: "Free",
        is_enterprise: false,
        price_cents: 0,
        annual_price_cents: null,
        price_per_seat_cents: null,
      }),
    ).toEqual([]);
  });

  it("skips the annual seat when there is no discount to read", () => {
    // No annual base means no declared discount, and guessing one is how an
    // annual customer gets a rate nobody agreed to.
    const specs = planPriceSpecs({ ...LIVE.launch, annual_price_cents: null });
    expect(specs.map((s) => s.kind).sort()).toEqual(["base_monthly", "seat_monthly"]);
  });
});

describe("the price is created with its key, not just stored by id", () => {
  const mirror = codeOnly(read("src/lib/platform-plan-stripe.server.ts"));

  it("passes lookup_key to prices.create", () => {
    const create = mirror.slice(mirror.indexOf("await stripe.prices.create("));
    expect(create.slice(0, 600)).toMatch(/lookup_key: spec\.lookupKey/);
  });

  it("asks the account by name before it creates anything", () => {
    const resolve = mirror.indexOf("resolvePriceId(catalog, spec.lookupKey");
    const create = mirror.indexOf("await stripe.prices.create(");
    expect(resolve).toBeGreaterThan(-1);
    expect(resolve).toBeLessThan(create);
  });

  it("is the thing the add-on path does NOT do", () => {
    // Stated as an assertion so that if add-ons are ever fixed, whoever fixes
    // them finds this note rather than a stale comment. If this fails because
    // add-ons now carry keys too, delete the assertion — do not delete the key.
    const addons = codeOnly(read("src/lib/platform-addons.functions.ts"));
    const addonCreate = addons.slice(addons.indexOf("await stripe.prices.create("));
    expect(addonCreate.slice(0, 400)).not.toMatch(/lookup_key/);
  });

  it("refuses to adopt a price that charges something else", () => {
    // A key that resolves to a different amount is worse than a missing one:
    // resolution succeeds, nothing errors, and the card is charged a number the
    // Plans page never displayed.
    expect(mirror).toMatch(/price\.unit_amount !== spec\.unitAmountCents/);
    expect(mirror).toMatch(/PlanMirrorRefusal/);
  });

  it("refuses a stored id from the other account instead of minting beside it", () => {
    expect(mirror).toMatch(/stored && !catalog\.ids\.has\(stored\)/);
    expect(mirror).toMatch(/nothing was created/);
  });

  it("keeps the amount in the idempotency key", () => {
    // A key replayed with different parameters is an error from Stripe, and
    // "mirror failed → fix the price → mirror again" is exactly that sequence.
    expect(mirror).toMatch(/idempotencyKey: `plan-price-\$\{plan\.id\}-\$\{spec\.kind\}-\$\{spec\.unitAmountCents\}`/);
  });
});

describe("a slug two plans would share in Stripe is refused", () => {
  it("accepts a plain new one", () => {
    expect(planSlugProblem("pro", ["launch", "growth"])).toBeNull();
    expect(planSlugProblem("Pro Max", ["launch"])).toBeNull();
    expect(normalizePlanSlug("  Pro   Max ")).toBe("pro-max");
  });

  it("catches the exact repeat", () => {
    expect(planSlugProblem("launch", ["launch"])).toMatch(/already used/);
  });

  it("catches the pair that is one name in Stripe and two rows in Postgres", () => {
    // `pro_max` is a legal value in the column — nothing constrains its format —
    // and planLookupKey folds `pro-max` onto it.
    const problem = planSlugProblem("pro-max", ["pro_max"]);
    expect(problem).toMatch(/pro_max_base_monthly/);
  });

  it("keeps plans out of the add-on half of the namespace", () => {
    expect(planSlugProblem("addon-foo", [])).toMatch(/addon-/);
  });

  it("refuses shapes no lookup key can be built from", () => {
    expect(planSlugProblem("", [])).toBeTruthy();
    expect(planSlugProblem("a", [])).toBeTruthy();
    expect(planSlugProblem("Pro!", [])).toBeTruthy();
    expect(planSlugProblem("pro/max", [])).toBeTruthy();
  });
});

describe("a plan that could not be bought is refused before it exists", () => {
  it("accepts a sound one", () => {
    expect(planShapeProblem(sound)).toBeNull();
  });

  it("requires an included-employee count", () => {
    const problem = planShapeProblem({ ...sound, includedSeats: null });
    expect(problem).toMatch(/included-employee/);
  });

  it("requires a monthly base unless it is priced by contract", () => {
    expect(planShapeProblem({ ...sound, priceCents: null })).toMatch(/monthly base price/);
    expect(
      planShapeProblem({
        ...sound,
        isEnterprise: true,
        priceCents: null,
        annualPriceCents: null,
      }),
    ).toBeNull();
  });

  it("refuses a contract tier that quietly carries a price", () => {
    // `formatBase` renders "Custom" for an enterprise plan whatever the columns
    // say, and platform MRR still counts the number. A price that bills and
    // cannot be seen is worse than no price.
    expect(planShapeProblem({ ...sound, isEnterprise: true })).toMatch(/by contract/);
  });

  it("keeps the 12x MRR guard the edit dialog already has", () => {
    expect(planShapeProblem({ ...sound, interval: "year", annualPriceCents: null })).toMatch(
      /annual price/,
    );
    expect(planShapeProblem({ ...sound, interval: "year" })).toBeNull();
  });

  it("refuses a second currency", () => {
    // platform-metrics sums every plan's cents into one MRR figure with no
    // currency term anywhere in the arithmetic.
    const problem = planShapeProblem({ ...sound, currency: "eur" });
    expect(problem).toMatch(/MRR/);
  });
});

describe("the console can tell the three empty Stripe columns apart", () => {
  const withIds = {
    ...LIVE.launch,
    stripe_price_id: "price_a",
    stripe_annual_price_id: "price_b",
    stripe_seat_price_id: "price_c",
    stripe_annual_seat_price_id: "price_d",
  };

  it("calls a fully mirrored plan mirrored", () => {
    expect(planMirrorState(withIds)).toBe("mirrored");
  });

  it("does not call a plan mirrored on the strength of its base price alone", () => {
    // This is the one the old dash hid: a base price present, the seat and
    // annual prices missing, and a column that read as done.
    expect(planMirrorState({ ...withIds, stripe_seat_price_id: null })).toBe("partial");
  });

  it("separates never-mirrored from nothing-to-mirror from by-contract", () => {
    expect(planMirrorState(LIVE.launch)).toBe("absent");
    expect(planMirrorState({ ...LIVE.launch, is_enterprise: true })).toBe("enterprise");
    expect(
      planMirrorState({
        slug: "free",
        name: "Free",
        is_enterprise: false,
        price_cents: 0,
        annual_price_cents: null,
        price_per_seat_cents: null,
      }),
    ).toBe("nothing-to-mirror");
  });
});

describe("the form and the server ask the same questions", () => {
  const route = codeOnly(read("src/routes/platform.plans.tsx"));
  const fns = codeOnly(read("src/lib/platform.functions.ts"));

  it("both call the shared validators rather than re-implementing them", () => {
    for (const fn of ["planSlugProblem(", "planShapeProblem("]) {
      expect(route, `the page must use ${fn}`).toContain(fn);
      expect(fns, `the server must use ${fn}`).toContain(fn);
    }
  });

  it("the server is still the one that decides", () => {
    // A client-side check is a courtesy. Removing the server's would make the
    // form the only gate, and the form is not the boundary.
    const create = fns.slice(fns.indexOf("export const createPlatformPlan ="));
    expect(create).toMatch(/if \(slugProblem\) throw new Error\(slugProblem\)/);
    expect(create).toMatch(/if \(shapeProblem\) throw new Error\(shapeProblem\)/);
  });
});
