// The founding offer is the plan price only (spec NP-2).
//
// LAUNCH20: 30% off the PLAN price, forever, first 20 paying accounts. Extra
// people and add-ons are full price. The banner's count is read from the
// promotion code in Stripe (20 minus redemptions), cached briefly, and hidden
// at zero; the browser never computes it.
//
// There are no Stripe keys here, so Stripe is faked. What these prove:
//   * the count, the cache and the hide-at-zero, from the promotion code;
//   * a founding checkout with one extra person, monthly and yearly, puts the
//     code on the BASE PLAN ITEM and nowhere else (not the seat line, not the
//     subscription as a whole, which would discount every line);
//   * with all 20 redeemed the code is not applied and the buyer is told;
//   * the Get-started box recognises the code;
//   * the Stripe setup script refuses a live key without --live.
// What they cannot prove is that Stripe agrees; that is the release-gate run
// in test mode (see the PR).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { foundingBannerText, isFoundingCode, placesLeft } from "@/lib/founding-offer";

const ORG = "0f000000-0000-4000-8000-0000000000f1";
const LAUNCH = "10000000-0000-4000-8000-0000000000f1";

describe("the count and the banner", () => {
  it("is 20 minus redemptions, never negative", () => {
    expect(placesLeft({ times_redeemed: 0, max_redemptions: 20 })).toBe(20);
    expect(placesLeft({ times_redeemed: 7, max_redemptions: 20 })).toBe(13);
    expect(placesLeft({ times_redeemed: 20, max_redemptions: 20 })).toBe(0);
    expect(placesLeft({ times_redeemed: 25, max_redemptions: null })).toBe(0);
    // Stripe's own cap wins if somebody set it lower.
    expect(placesLeft({ times_redeemed: 3, max_redemptions: 10 })).toBe(7);
  });

  it("says the spec's sentence, with the count in place of {X}", () => {
    expect(foundingBannerText(13)).toBe(
      "Founding customers: the first 20 paying accounts get 30% off their plan price for as long as they stay subscribed. Extra people and add-ons are billed at regular price. Use code LAUNCH20 at checkout. 13 of 20 left.",
    );
  });

  it("matches the code however it is typed", () => {
    expect(isFoundingCode(" launch20 ")).toBe(true);
    expect(isFoundingCode("LAUNCH2")).toBe(false);
    expect(isFoundingCode(null)).toBe(false);
  });

  it("is never computed in the browser", () => {
    const ui = readFileSync(join(import.meta.dirname, "..", "src/components/billing/PlanPicker.tsx"), "utf8");
    expect(ui).toMatch(/foundingBannerText\(founding\.left\)/);
    expect(ui).not.toMatch(/FOUNDING_SPOTS|times_redeemed|20\s*-\s*/);
  });
});

describe("reading the count from Stripe", () => {
  function fakeStripe(promo: Record<string, unknown> | null, calls: { n: number }) {
    return {
      promotionCodes: {
        list: async (params: Record<string, unknown>) => {
          calls.n += 1;
          expect(params).toMatchObject({ code: "LAUNCH20", active: true });
          return { data: promo ? [promo] : [] };
        },
      },
    } as any;
  }

  beforeEach(async () => {
    const { forgetFoundingOffer } = await import("@/lib/founding-offer.server");
    forgetFoundingOffer();
  });

  it("shows the places left, and caches the read", async () => {
    const { readFoundingOffer } = await import("@/lib/founding-offer.server");
    const calls = { n: 0 };
    const s = fakeStripe({ id: "promo_1", active: true, times_redeemed: 7, max_redemptions: 20 }, calls);
    expect(await readFoundingOffer(async () => s, 1_000_000)).toEqual({ visible: true, left: 13 });
    expect(await readFoundingOffer(async () => s, 1_030_000)).toEqual({ visible: true, left: 13 });
    expect(calls.n).toBe(1);
    // After the cache window, Stripe is asked again.
    await readFoundingOffer(async () => s, 1_061_000);
    expect(calls.n).toBe(2);
  });

  it("drops after a redemption once the cache is forgotten", async () => {
    const { readFoundingOffer, forgetFoundingOffer } = await import("@/lib/founding-offer.server");
    const promo = { id: "promo_1", active: true, times_redeemed: 7, max_redemptions: 20 };
    const s = fakeStripe(promo, { n: 0 });
    expect(await readFoundingOffer(async () => s)).toEqual({ visible: true, left: 13 });
    promo.times_redeemed = 8;
    forgetFoundingOffer();
    expect(await readFoundingOffer(async () => s)).toEqual({ visible: true, left: 12 });
  });

  it("hides at 20 redemptions, with no code, with no key, and when Stripe fails", async () => {
    const { readFoundingOffer, forgetFoundingOffer } = await import("@/lib/founding-offer.server");
    const hidden = { visible: false };
    expect(
      await readFoundingOffer(async () => fakeStripe({ id: "p", active: true, times_redeemed: 20, max_redemptions: 20 }, { n: 0 })),
    ).toEqual(hidden);
    forgetFoundingOffer();
    expect(await readFoundingOffer(async () => fakeStripe(null, { n: 0 }))).toEqual(hidden);
    forgetFoundingOffer();
    expect(await readFoundingOffer(async () => null)).toEqual(hidden);
    forgetFoundingOffer();
    expect(
      await readFoundingOffer(async () => {
        throw new Error("network");
      }),
    ).toEqual(hidden);
  });
});

// ── Checkout, run for real with Stripe faked ─────────────────────────────

type Row = Record<string, any>;
let tables: Record<string, Row[]> = {};
function chain(table: string) {
  const filters: Array<[string, unknown]> = [];
  let op = "select";
  const rows = () => (tables[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
  const api: any = {
    select: () => api,
    eq: (k: string, v: unknown) => (filters.push([k, v]), api),
    not: () => api,
    order: () => api,
    ilike: () => api,
    is: () => api,
    limit: () => api,
    update: () => ((op = "update"), api),
    insert: () => ((op = "insert"), api),
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    single: async () => ({ data: rows()[0] ?? null, error: null }),
    then: (res: any, rej: any) =>
      Promise.resolve(op === "select" ? { data: rows(), error: null, count: rows().length } : { data: null, error: null }).then(res, rej),
  };
  return api;
}
const db = { from: (t: string) => chain(t), auth: { getUser: async () => ({ data: { user: { email: "o@example.test" } } }) } };

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (d: unknown) => unknown = (d) => d;
    const b: any = {
      middleware: () => b,
      inputValidator: (v: (d: unknown) => unknown) => ((validate = v), b),
      handler:
        (h: (ctx: { data: unknown; context: unknown }) => unknown) =>
        (opts: { data?: unknown } = {}) =>
          h({ data: validate(opts.data), context: { supabase: db, userId: "owner-1" } }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: db }));
vi.mock("@/lib/authz.server", () => ({
  requirePermission: async () => ({ orgId: ORG, role: "owner" }),
  resolveCaller: async () => ({ orgId: ORG, role: "owner" }),
}));
vi.mock("@/lib/billing-state.server", () => ({
  getOrgBillingState: async () => ({ stripeSubscriptionId: null, stripeCustomerId: "cus_test1234567", orgName: "Founding Co" }),
  subscriptionPeriodEnd: () => null,
}));

let promo: Record<string, unknown> | null = null;
const creates: any[] = [];
vi.mock("@/lib/stripe-client.server", () => ({
  makeStripe: async () => ({
    prices: {
      list: async () => ({
        has_more: false,
        data: [
          { id: "price_base_m", lookup_key: "launch_base_monthly", unit_amount: 7900 },
          { id: "price_base_y", lookup_key: "launch_base_annual", unit_amount: 79000 },
          { id: "price_seat_m", lookup_key: "launch_seat_monthly", unit_amount: 1500 },
          { id: "price_seat_y", lookup_key: "launch_seat_annual", unit_amount: 15000 },
        ],
      }),
    },
    promotionCodes: { list: async () => ({ data: promo ? [promo] : [] }) },
    subscriptions: {
      list: async () => ({ data: [] }),
      create: async (params: any) => {
        creates.push(params);
        return { id: "sub_new", latest_invoice: { confirmation_secret: { client_secret: "cs_1" } } };
      },
    },
  }),
}));

function seed(signupCode: string | null = null) {
  tables = {
    organizations: [{ id: ORG, signup_promo_code: signupCode }],
    // Two enabled people on a plan that includes one: one extra person.
    staff: [
      { organization_id: ORG, active: true },
      { organization_id: ORG, active: true },
    ],
    platform_plans: [
      {
        id: LAUNCH, name: "Launch", slug: "launch", is_active: true, is_enterprise: false,
        stripe_price_id: "price_base_m", stripe_annual_price_id: "price_base_y",
        stripe_seat_price_id: "price_seat_m", stripe_annual_seat_price_id: "price_seat_y",
        price_cents: 7900, annual_price_cents: 79000, included_seats: 1, price_per_seat_cents: 1500,
      },
    ],
    platform_coupons: [],
  };
}

beforeEach(() => {
  creates.length = 0;
  promo = { id: "promo_launch20", code: "LAUNCH20", active: true, times_redeemed: 4, max_redemptions: 20 };
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_fake";
});

describe("a founding checkout with one extra person", () => {
  for (const interval of ["month", "year"] as const) {
    it(`discounts only the plan line (${interval}ly)`, async () => {
      seed();
      const { createPlanSubscription } = await import("@/lib/billing.functions");
      const out: any = await createPlanSubscription({
        data: { planId: LAUNCH, interval, promoCode: "launch20" },
      } as any);
      expect(out.promoApplied).toBe("LAUNCH20");
      expect(out.promoDropped).toBeNull();
      const params = creates[0];
      // Never the subscription as a whole: that would discount every line.
      expect(params.discounts).toBeUndefined();
      const base = interval === "year" ? "price_base_y" : "price_base_m";
      const seat = interval === "year" ? "price_seat_y" : "price_seat_m";
      expect(params.items).toEqual([
        { price: base, quantity: 1, discounts: [{ promotion_code: "promo_launch20" }] },
        { price: seat, quantity: 1 },
      ]);
      expect(params.metadata.promo_code).toBe("LAUNCH20");
    });
  }

  it("applies a code typed on Get-started the same way", async () => {
    seed("LAUNCH20");
    const { createPlanSubscription } = await import("@/lib/billing.functions");
    await createPlanSubscription({ data: { planId: LAUNCH, interval: "month" } } as any);
    expect(creates[0].items[0].discounts).toEqual([{ promotion_code: "promo_launch20" }]);
    expect(creates[0].items[1].discounts).toBeUndefined();
  });

  it("with all 20 places taken, applies nothing and says so", async () => {
    seed();
    promo = { ...promo!, times_redeemed: 20 };
    const { createPlanSubscription } = await import("@/lib/billing.functions");
    const out: any = await createPlanSubscription({
      data: { planId: LAUNCH, interval: "month", promoCode: "LAUNCH20" },
    } as any);
    expect(out.promoApplied).toBeNull();
    expect(out.promoDropped).toMatchObject({ code: "LAUNCH20", reason: "invalid" });
    expect(JSON.stringify(creates[0])).not.toMatch(/promo_launch20|discounts/);
  });

  it("an add-on bought later carries no discount", () => {
    // Add-ons are separate subscription items created by subscribePlatformAddon,
    // which never passes `discounts`, and the code sits on the base item only.
    const src = readFileSync(join(import.meta.dirname, "..", "src/lib/platform-addons.functions.ts"), "utf8");
    expect(src).not.toMatch(/discounts/);
  });
});

describe("the Get-started code box", () => {
  it("recognises LAUNCH20 as a discount, not a typo", async () => {
    const { lookupSignupCode } = await import("@/lib/signup-codes.server");
    const fake = {
      from: () => {
        const q: any = { select: () => q, ilike: () => q, is: () => q, limit: async () => ({ data: [] }) };
        return q;
      },
    };
    const hit = await lookupSignupCode(fake, "launch20");
    expect(hit.kind).toBe("coupon");
    if (hit.kind === "coupon") expect(hit.coupon.code).toBe("LAUNCH20");
  });
});

describe("scripts/stripe-test-setup.mjs", () => {
  it("refuses a live key unless --live is passed, and anything that is not a key", async () => {
    // @ts-expect-error -- a plain .mjs script with no types
    const { keyVerdict } = await import("../scripts/stripe-test-setup.mjs");
    expect(keyVerdict("sk_live_abc").ok).toBe(false);
    expect(keyVerdict("rk_live_abc").ok).toBe(false);
    expect(keyVerdict("sk_live_abc", { liveOk: true })).toEqual({ ok: true, live: true });
    expect(keyVerdict("sk_test_abc")).toEqual({ ok: true, live: false });
    expect(keyVerdict("").ok).toBe(false);
    expect(keyVerdict("pk_test_abc").ok).toBe(false);
  });

  it("creates new prices only, and never edits or archives one", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "scripts/stripe-test-setup.mjs"), "utf8");
    expect(src).not.toMatch(/prices\.update|products\.del|coupons\.del|active:\s*false/);
    expect(src).toMatch(/transfer_lookup_key: true/);
    expect(src).toMatch(/max_redemptions: PROMO_MAX/);
    expect(src).toMatch(/first_time_transaction: true/);
    expect(src).toMatch(/percent_off: 30,\s*duration: "forever"/);
  });

  it("names nothing longer than Stripe takes", () => {
    // Stripe refuses a coupon name over 40 characters, and it refused this
    // script's first one (42) in test mode on 2026-10-10, after the prices
    // were already made. Every literal `name:` here is checked against the
    // tightest limit; a product name may be longer, but none needs to be.
    const src = readFileSync(join(import.meta.dirname, "..", "scripts/stripe-test-setup.mjs"), "utf8");
    const names = [...src.matchAll(/\bname:\s*"([^"]*)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(n.length, n).toBeLessThanOrEqual(40);
  });
});
