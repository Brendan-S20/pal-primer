import { describe, expect, it } from "vitest";
// @ts-expect-error - plain ESM script, no types
import { auditCatalog } from "../scripts/check-stripe-catalog.mjs";

// `platform_plans` stores a price in cents AND a Stripe price id. The app
// renders the cents; Stripe charges the id. Nothing had ever compared them.
//
// That is survivable while both are created in one sitting. It stops being
// survivable at the live-mode cutover — the last external blocker before
// launch — where a fresh live catalog is built by hand and every repointed id
// is a chance for the pricing page to say $79 while the card is charged $199.
// The worst version does not error at all: a live key holding test price ids
// fails for the first time at checkout, in front of the first paying customer.
//
// Verified against the real test catalog on 2026-08-02: the twelve prices
// behind Launch, Growth and Scale all reconcile. These tests are about keeping
// that true, and about the audit function reporting honestly what it did NOT
// compare — every add-on is `coming_soon`, so that half of the check currently
// measures nothing, and a summary that hides it would be a green tick over an
// empty set.

const PRICES = new Map<string, any>([
  ["p_base_m", { id: "p_base_m", active: true, livemode: false, product: "prod_x", recurring: { interval: "month" }, unit_amount: 7900 }],
  ["p_base_y", { id: "p_base_y", active: true, livemode: false, product: "prod_x", recurring: { interval: "year" }, unit_amount: 79000 }],
  ["p_seat_m", { id: "p_seat_m", active: true, livemode: false, product: "prod_x", recurring: { interval: "month" }, unit_amount: 1000 }],
  ["p_seat_y", { id: "p_seat_y", active: true, livemode: false, product: "prod_x", recurring: { interval: "year" }, unit_amount: 10000 }],
  ["p_other", { id: "p_other", active: true, livemode: false, product: "prod_other", recurring: { interval: "month" }, unit_amount: 19900 }],
  ["p_live", { id: "p_live", active: true, livemode: true, product: "prod_x", recurring: { interval: "month" }, unit_amount: 7900 }],
  ["p_archived", { id: "p_archived", active: false, livemode: false, product: "prod_x", recurring: { interval: "month" }, unit_amount: 7900 }],
  ["p_once", { id: "p_once", active: true, livemode: false, product: "prod_a", recurring: null, unit_amount: 49900 }],
]);

const plan = (over: Record<string, unknown> = {}) => ({
  slug: "launch",
  is_active: true,
  price_cents: 7900,
  annual_price_cents: 79000,
  price_per_seat_cents: 1000,
  stripe_product_id: "prod_x",
  stripe_price_id: "p_base_m",
  stripe_annual_price_id: "p_base_y",
  stripe_seat_price_id: "p_seat_m",
  stripe_annual_seat_price_id: "p_seat_y",
  ...over,
});

const audit = (plans: unknown[], addons: unknown[] = [], expectLive = false) =>
  auditCatalog({ plans, addons }, PRICES, { expectLive });

describe("a clean catalog passes", () => {
  it("reports no problems and says how much it compared", () => {
    const r = audit([plan()]);
    expect(r.problems).toEqual([]);
    expect(r.checked.plans).toBe(1);
    expect(r.checked.prices).toBe(4);
  });
});

describe("the failures that cost money", () => {
  it("catches a price the database and Stripe disagree about", () => {
    // The pricing page renders 19900; the card is charged 7900.
    const r = audit([plan({ price_cents: 19900 })]);
    expect(r.problems.join(" ")).toMatch(/amount disagrees/);
  });

  it("catches a live price under a test key, and the reverse", () => {
    // The cutover's signature failure. It does not error until checkout.
    expect(audit([plan({ stripe_price_id: "p_live" })]).problems.join(" ")).toMatch(
      /is a LIVE price but the key in use is TEST/,
    );
    expect(audit([plan()], [], true).problems.join(" ")).toMatch(
      /is a TEST price but the key in use is LIVE/,
    );
  });

  it("catches a price borrowed from another product", () => {
    const r = audit([plan({ stripe_price_id: "p_other" })]);
    expect(r.problems.join(" ")).toMatch(/belongs to product prod_other/);
  });

  it("catches an annual slot holding a monthly price", () => {
    const r = audit([plan({ stripe_annual_price_id: "p_base_m" })]);
    expect(r.problems.join(" ")).toMatch(/should recur yearly but Stripe says monthly/);
  });

  it("catches an archived price", () => {
    const r = audit([plan({ stripe_price_id: "p_archived" })]);
    expect(r.problems.join(" ")).toMatch(/archived in Stripe/);
  });

  it("catches an id that does not resolve", () => {
    const r = audit([plan({ stripe_price_id: "p_nope" })]);
    expect(r.problems.join(" ")).toMatch(/does not exist in this Stripe account/);
  });

  it("catches an active priced plan with no price id", () => {
    const r = audit([plan({ stripe_price_id: null })]);
    expect(r.problems.join(" ")).toMatch(/no stripe_price_id/);
  });

  it("catches a one-time add-on Stripe has as recurring", () => {
    const r = audit([], [
      { slug: "setup", is_active: true, status: "available", price_cents: 7900, billing_interval: "one_time", stripe_product_id: "prod_x", stripe_price_id: "p_base_m" },
    ]);
    expect(r.problems.join(" ")).toMatch(/should be one-time but Stripe has it recurring/);
  });
});

describe("what it deliberately does not flag", () => {
  it("ignores inactive plans carrying stale ids", () => {
    // Five retired SKUs from an older catalog still hold test price ids. They
    // cannot be bought. Flagging them would make this noisy and get it ignored,
    // which is the fate of every check that cries wolf.
    const r = audit([plan({ slug: "fetch", is_active: false, price_cents: 999999 })]);
    expect(r.problems).toEqual([]);
    expect(r.skipped.plans.join(" ")).toMatch(/fetch \(not active\)/);
  });

  it("ignores a contact-us tier with no prices", () => {
    const r = audit([
      { slug: "enterprise", is_active: true, price_cents: null, annual_price_cents: null, price_per_seat_cents: 1000, stripe_product_id: null, stripe_price_id: null, stripe_annual_price_id: null, stripe_seat_price_id: null, stripe_annual_seat_price_id: null },
    ]);
    expect(r.problems).toEqual([]);
    expect(r.skipped.plans.join(" ")).toMatch(/contact-us tier/);
  });

  it("does not require an annual pair — that is a product decision", () => {
    const r = audit([plan({ stripe_annual_price_id: null, annual_price_cents: null, stripe_annual_seat_price_id: null })]);
    expect(r.problems).toEqual([]);
  });

  it("does not compare the annual seat price to the monthly one", () => {
    // The annual plans carry a two-months-free discount, so the annual seat
    // price is 10x the monthly, not 12x. Asserting 12x would fail on correct
    // data — which is how a check earns its way into being switched off.
    const r = audit([plan()]);
    expect(r.problems).toEqual([]);
  });
});

describe("it reports its own coverage", () => {
  it("names every row it skipped, so a tick cannot hide an empty set", () => {
    const r = audit(
      [plan({ slug: "dead", is_active: false })],
      [{ slug: "ai-receptionist", is_active: false, status: "coming_soon", price_cents: 4900, billing_interval: "month", stripe_product_id: "prod_x", stripe_price_id: "p_base_m" }],
    );
    expect(r.checked.plans).toBe(0);
    expect(r.checked.addons).toBe(0);
    expect(r.checked.prices).toBe(0);
    expect(r.skipped.plans).toHaveLength(1);
    expect(r.skipped.addons.join(" ")).toMatch(/coming_soon/);
  });

  it("counts prices compared, not ids present", () => {
    // An unresolvable id is a problem, not a comparison.
    const r = audit([plan({ stripe_seat_price_id: "p_nope" })]);
    expect(r.checked.prices).toBe(3);
    expect(r.problems).toHaveLength(1);
  });
});
