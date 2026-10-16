// The founding offer is the plan price only (spec NP-2).
//
// LAUNCH20: 30% off the PLAN price, forever, first 20 PAYING accounts. Extra
// people and add-ons are full price. The banner's count is 20 minus the
// accounts that PAID with the code (founding_accounts, owner 2026-10-10), not
// Stripe's redemption count, which Stripe takes when the unpaid subscription
// is created and so includes abandoned checkouts. Cached briefly, hidden at
// zero; the browser never computes it.
//
// There are no Stripe keys here, so Stripe is faked. What these prove:
//   * the count, the cache and the hide-at-zero, from the paid count, with
//     Stripe's max_redemptions only as a backstop;
//   * an abandoned (incomplete) subscription takes no place, a paid one does,
//     and a payment after the 20th has its discount taken off in Stripe;
//   * a founding checkout with one extra person, monthly and yearly, puts the
//     code on the BASE PLAN ITEM and nowhere else (not the seat line, not the
//     subscription as a whole, which would discount every line);
//   * with 20 accounts paid the code is not applied and the buyer is told,
//     however few redemptions Stripe has counted; and abandoned checkouts do
//     not close it early;
//   * the Get-started box recognises the code;
//   * the Stripe setup script refuses a live key without --live, and sets the
//     backstop above the offer.
// The database half (claim_founding_place: once per account, NULL past the
// last place, a place never held twice) is proved in a real Postgres by
// a-founding-place-is-taken-by-paying.test.ts. What none of this can prove is
// that Stripe agrees; that is the release-gate run in test mode.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FOUNDING_SPOTS, foundingBannerText, isFoundingCode, placesLeft } from "@/lib/founding-offer";

const ORG = "0f000000-0000-4000-8000-0000000000f1";
const LAUNCH = "10000000-0000-4000-8000-0000000000f1";

describe("the count and the banner", () => {
  it("is 20 minus the accounts that PAID, never negative", () => {
    expect(FOUNDING_SPOTS).toBe(20);
    expect(placesLeft(0, { times_redeemed: 0, max_redemptions: 30 })).toBe(20);
    expect(placesLeft(7, { times_redeemed: 7, max_redemptions: 30 })).toBe(13);
    expect(placesLeft(20, { times_redeemed: 20, max_redemptions: 30 })).toBe(0);
    expect(placesLeft(25, null)).toBe(0);
  });

  it("does not count Stripe's redemptions, which include abandoned checkouts", () => {
    // 9 checkouts started, 4 paid: 16 left, not 11.
    expect(placesLeft(4, { times_redeemed: 9, max_redemptions: 30 })).toBe(16);
  });

  it("lets Stripe's backstop close it only if the backstop is nearer", () => {
    expect(placesLeft(15, { times_redeemed: 28, max_redemptions: 30 })).toBe(2);
    expect(placesLeft(3, { times_redeemed: 30, max_redemptions: 30 })).toBe(0);
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

  it("writes the 20 in one place (FOUNDING_SPOTS); the database is handed it", () => {
    const code = (f: string) =>
      readFileSync(join(import.meta.dirname, "..", f), "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|--|\*)/.test(l))
        .join("\n");
    for (const f of [
      "src/lib/founding-offer.server.ts",
      "supabase/migrations/20261010120000_a-founding-place-is-taken-by-paying.sql",
    ]) {
      expect(code(f), f).not.toMatch(/\b20\b/);
    }
    expect(code("src/lib/founding-offer.server.ts")).toMatch(/_spots: FOUNDING_SPOTS/);
    const billing = code("src/lib/billing.functions.ts");
    expect(billing).toMatch(/All \$\{FOUNDING_SPOTS\} founding places have been taken\./);
    expect(billing).not.toMatch(/All 20 founding/);
  });
});

describe("reading the count: paid accounts, while the code is live in Stripe", () => {
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
  const paid = (n: number) => async () => n;

  beforeEach(async () => {
    const { forgetFoundingOffer } = await import("@/lib/founding-offer.server");
    forgetFoundingOffer();
  });

  it("shows the places left, and caches the read", async () => {
    const { readFoundingOffer } = await import("@/lib/founding-offer.server");
    const calls = { n: 0 };
    const s = fakeStripe({ id: "promo_1", active: true, times_redeemed: 9, max_redemptions: 30 }, calls);
    expect(await readFoundingOffer(async () => s, 1_000_000, paid(7))).toEqual({ visible: true, left: 13 });
    expect(await readFoundingOffer(async () => s, 1_030_000, paid(7))).toEqual({ visible: true, left: 13 });
    expect(calls.n).toBe(1);
    // After the cache window, it is asked again.
    await readFoundingOffer(async () => s, 1_061_000, paid(7));
    expect(calls.n).toBe(2);
  });

  it("drops after a payment once the cache is forgotten", async () => {
    const { readFoundingOffer, forgetFoundingOffer } = await import("@/lib/founding-offer.server");
    const s = fakeStripe({ id: "promo_1", active: true, times_redeemed: 7, max_redemptions: 30 }, { n: 0 });
    expect(await readFoundingOffer(async () => s, Date.now(), paid(7))).toEqual({ visible: true, left: 13 });
    forgetFoundingOffer();
    expect(await readFoundingOffer(async () => s, Date.now(), paid(8))).toEqual({ visible: true, left: 12 });
  });

  it("hides at 20 paid, with no code, with no key, and when Stripe or the count fails", async () => {
    const { readFoundingOffer, forgetFoundingOffer } = await import("@/lib/founding-offer.server");
    const hidden = { visible: false };
    const live = () => fakeStripe({ id: "p", active: true, times_redeemed: 22, max_redemptions: 30 }, { n: 0 });
    expect(await readFoundingOffer(async () => live(), Date.now(), paid(20))).toEqual(hidden);
    forgetFoundingOffer();
    expect(await readFoundingOffer(async () => fakeStripe(null, { n: 0 }), Date.now(), paid(0))).toEqual(hidden);
    forgetFoundingOffer();
    expect(await readFoundingOffer(async () => null, Date.now(), paid(0))).toEqual(hidden);
    forgetFoundingOffer();
    expect(
      await readFoundingOffer(
        async () => {
          throw new Error("network");
        },
        Date.now(),
        paid(0),
      ),
    ).toEqual(hidden);
    forgetFoundingOffer();
    expect(
      await readFoundingOffer(async () => live(), Date.now(), async () => {
        throw new Error("db down");
      }),
    ).toEqual(hidden);
  });
});

// ── Taking a place: only a PAID founding subscription ─────────────────────

describe("a place is taken by paying, not by starting a checkout", () => {
  // claim_founding_place in memory, with the SQL's rules (once per account;
  // NULL past the last place). The SQL itself is proved in a real Postgres.
  type Row = { organization_id: string; place: number | null; discount_removed_at?: string };
  function fakeDb() {
    const rows: Row[] = [];
    const rpcs: Array<Record<string, unknown>> = [];
    const admin = {
      rpc: async (fn: string, args: any) => {
        rpcs.push({ fn, ...args });
        const taken = rows.filter((r) => r.place != null).length;
        const have = rows.find((r) => r.organization_id === args._org);
        if (have) return { data: [{ place: have.place, newly_claimed: false, places_taken: taken }], error: null };
        const place = taken < args._spots ? taken + 1 : null;
        rows.push({ organization_id: args._org, place });
        return { data: [{ place, newly_claimed: true, places_taken: taken + (place ? 1 : 0) }], error: null };
      },
      from: () => {
        let patch: Partial<Row> | null = null;
        const q: any = {
          select: () => q,
          not: () => q,
          update: (p: Partial<Row>) => ((patch = p), q),
          eq: (_k: string, v: string) => {
            const row = rows.find((r) => r.organization_id === v);
            if (patch && row) Object.assign(row, patch);
            return q;
          },
          then: (res: any) =>
            Promise.resolve({ count: rows.filter((r) => r.place != null).length, error: null }).then(res),
        };
        return q;
      },
    };
    return { admin, rows, rpcs };
  }
  function fakeStripe() {
    const itemUpdates: Array<[string, unknown]> = [];
    const subUpdates: Array<[string, unknown]> = [];
    return {
      stripe: {
        subscriptionItems: { update: async (id: string, p: unknown) => (itemUpdates.push([id, p]), {}) },
        subscriptions: { update: async (id: string, p: unknown) => (subUpdates.push([id, p]), {}) },
      } as any,
      itemUpdates,
      subUpdates,
    };
  }
  const founding = (id: string, status: string): any => ({
    id,
    status,
    metadata: { promo_code: "LAUNCH20" },
    items: { data: [{ id: `si_base_${id}`, discounts: ["di_1"] }, { id: `si_seat_${id}`, discounts: [] }] },
  });

  it("an abandoned (incomplete) subscription takes no place, and the banner still says 20 left", async () => {
    const { recordFoundingPayment, countFoundingPaid, readFoundingOffer, forgetFoundingOffer } = await import(
      "@/lib/founding-offer.server"
    );
    const { admin, rpcs } = fakeDb();
    const { stripe } = fakeStripe();
    for (const status of ["incomplete", "incomplete_expired", "canceled"]) {
      expect(await recordFoundingPayment({ admin, stripe, orgId: "org-a", sub: founding("sub_a", status) })).toEqual({
        kind: "not_founding",
      });
    }
    expect(rpcs).toEqual([]);
    expect(await countFoundingPaid(admin)).toBe(0);
    // Stripe has counted the abandoned checkout; the banner has not.
    forgetFoundingOffer();
    const s = {
      promotionCodes: { list: async () => ({ data: [{ id: "p", active: true, times_redeemed: 1, max_redemptions: 30 }] }) },
    } as any;
    expect(await readFoundingOffer(async () => s, Date.now(), () => countFoundingPaid(admin))).toEqual({
      visible: true,
      left: 20,
    });
  });

  it("a paid one takes a place, once, and the banner drops by one", async () => {
    const { recordFoundingPayment, countFoundingPaid, readFoundingOffer } = await import(
      "@/lib/founding-offer.server"
    );
    const { admin, rpcs } = fakeDb();
    const { stripe, itemUpdates } = fakeStripe();
    const r = await recordFoundingPayment({ admin, stripe, orgId: "org-a", sub: founding("sub_a", "active") });
    expect(r).toEqual({ kind: "place", place: 1, newlyClaimed: true, placesTaken: 1 });
    expect(rpcs[0]).toEqual({ fn: "claim_founding_place", _org: "org-a", _subscription: "sub_a", _spots: 20 });
    // The webhook and the refresh both see it: still one place.
    const again = await recordFoundingPayment({ admin, stripe, orgId: "org-a", sub: founding("sub_a", "active") });
    expect(again).toMatchObject({ kind: "place", place: 1, newlyClaimed: false });
    expect(await countFoundingPaid(admin)).toBe(1);
    expect(itemUpdates).toEqual([]);
    // A newly taken place forgot the cache, so the banner reads 19 at once.
    const s = {
      promotionCodes: { list: async () => ({ data: [{ id: "p", active: true, times_redeemed: 1, max_redemptions: 30 }] }) },
    } as any;
    expect(await readFoundingOffer(async () => s, Date.now(), () => countFoundingPaid(admin))).toEqual({
      visible: true,
      left: 19,
    });
  });

  it("a subscription without the code takes nothing", async () => {
    const { recordFoundingPayment } = await import("@/lib/founding-offer.server");
    const { admin, rpcs } = fakeDb();
    const sub = { ...founding("sub_b", "active"), metadata: { promo_code: "" } };
    expect(await recordFoundingPayment({ admin, stripe: fakeStripe().stripe, orgId: "org-b", sub })).toEqual({
      kind: "not_founding",
    });
    expect(rpcs).toEqual([]);
  });

  it("at 20 paid the banner hides; a 21st payment gets no place and its discount comes off the plan line", async () => {
    const { recordFoundingPayment, countFoundingPaid, readFoundingOffer, forgetFoundingOffer } = await import(
      "@/lib/founding-offer.server"
    );
    const { admin, rows } = fakeDb();
    const { stripe, itemUpdates, subUpdates } = fakeStripe();
    for (let i = 1; i <= 20; i += 1) {
      await recordFoundingPayment({ admin, stripe, orgId: `org-${i}`, sub: founding(`sub_${i}`, "active") });
    }
    expect(await countFoundingPaid(admin)).toBe(20);
    forgetFoundingOffer();
    const s = {
      promotionCodes: { list: async () => ({ data: [{ id: "p", active: true, times_redeemed: 21, max_redemptions: 30 }] }) },
    } as any;
    expect(await readFoundingOffer(async () => s, Date.now(), () => countFoundingPaid(admin))).toEqual({
      visible: false,
    });

    // A checkout started before the 20th paid, and paid after it.
    const late = await recordFoundingPayment({ admin, stripe, orgId: "org-21", sub: founding("sub_21", "active") });
    expect(late).toEqual({ kind: "over", placesTaken: 20, discountRemoved: true });
    expect(itemUpdates).toEqual([["si_base_sub_21", { discounts: "" }]]);
    expect(subUpdates).toEqual([["sub_21", { metadata: { promo_code: "", founding_over_limit: "LAUNCH20" } }]]);
    const row = rows.find((r) => r.organization_id === "org-21");
    expect(row?.place).toBeNull();
    expect(row?.discount_removed_at).toBeTruthy();
    expect(await countFoundingPaid(admin)).toBe(20);
  });

  it("is called where a payment is seen: the platform webhook and refreshBillingStatus", () => {
    const hook = readFileSync(join(import.meta.dirname, "..", "src/routes/api/public/hooks/platform-stripe.ts"), "utf8");
    // After the incomplete skip, inside the subscription branch.
    const skip = hook.indexOf('if (sub.status === "incomplete" || sub.status === "incomplete_expired") break;');
    const call = hook.indexOf("recordFoundingPayment({ admin: supabaseAdmin, stripe, orgId, sub })");
    expect(skip).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(skip);
    const billing = readFileSync(join(import.meta.dirname, "..", "src/lib/billing.functions.ts"), "utf8");
    expect(billing).toMatch(/recordFoundingPayment\(\{ admin: supabaseAdmin, stripe, orgId, sub: active \}\)/);
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
  createServerOnlyFn: (fn: unknown) => fn,
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

function seed(signupCode: string | null = null, paidFounders = 4) {
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
    // Accounts that have PAID with the code (each holds a place).
    founding_accounts: Array.from({ length: paidFounders }, (_, i) => ({ organization_id: `paid-${i}`, place: i + 1 })),
  };
}

beforeEach(() => {
  creates.length = 0;
  promo = { id: "promo_launch20", code: "LAUNCH20", active: true, times_redeemed: 6, max_redemptions: 30 };
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

  it("with 20 accounts PAID, applies nothing and says so, whatever Stripe has counted", async () => {
    seed(null, 20);
    promo = { ...promo!, times_redeemed: 22 };
    const { createPlanSubscription } = await import("@/lib/billing.functions");
    const out: any = await createPlanSubscription({
      data: { planId: LAUNCH, interval: "month", promoCode: "LAUNCH20" },
    } as any);
    expect(out.promoApplied).toBeNull();
    expect(out.promoDropped).toMatchObject({
      code: "LAUNCH20",
      reason: "invalid",
      detail: "All 20 founding places have been taken.",
    });
    expect(JSON.stringify(creates[0])).not.toMatch(/promo_launch20|discounts/);
  });

  it("abandoned checkouts do not close it: 19 paid and 25 redemptions in Stripe still applies", async () => {
    seed(null, 19);
    promo = { ...promo!, times_redeemed: 25 };
    const { createPlanSubscription } = await import("@/lib/billing.functions");
    const out: any = await createPlanSubscription({
      data: { planId: LAUNCH, interval: "month", promoCode: "LAUNCH20" },
    } as any);
    expect(out.promoApplied).toBe("LAUNCH20");
    expect(creates[0].items[0].discounts).toEqual([{ promotion_code: "promo_launch20" }]);
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

  it("sets Stripe's cap as a backstop ABOVE the offer, so abandoned checkouts cannot close it", async () => {
    // @ts-expect-error -- a plain .mjs script with no types
    const { PROMO_MAX } = await import("../scripts/stripe-test-setup.mjs");
    expect(PROMO_MAX).toBe(30);
    expect(PROMO_MAX).toBeGreaterThan(FOUNDING_SPOTS);
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
