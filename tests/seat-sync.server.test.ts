import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Shared spy/state holders (hoisted so the vi.mock factories can see them).
const h = vi.hoisted(() => ({
  stripe: {
    subscriptions: { retrieve: vi.fn(), update: vi.fn() },
    subscriptionItems: { update: vi.fn(), create: vi.fn(), del: vi.fn() },
    prices: { list: vi.fn() },
  },
  results: {} as Record<string, any>,
  rpc: vi.fn(),
  upserts: [] as Array<{ table: string; row: any }>,
}));

vi.mock("stripe", () => ({
  default: class {
    constructor() {
      return h.stripe as any;
    }
  },
}));

vi.mock("@/integrations/supabase/client.server", () => {
  function chain(table: string) {
    const p: any = {
      select: () => p,
      eq: () => p,
      in: () => p,
      or: () => p,
      not: () => p,
      maybeSingle: () => Promise.resolve(h.results[table]),
      upsert: (row: any) => {
        h.upserts.push({ table, row });
        return Promise.resolve({ error: null });
      },
      then: (res: any, rej: any) => Promise.resolve(h.results[table]).then(res, rej),
    };
    return p;
  }
  return { supabaseAdmin: { from: (t: string) => chain(t), rpc: h.rpc } };
});

import { syncOrgSeatQuantity } from "@/lib/seat-sync.server";

const ORG = "342d4d1e-56f7-4b6e-ad40-524d370e1a36";

// The current billing period, on the items, as API versions since 2025 put it.
const PERIOD_START = 1_759_968_000; // 2025-10-09T00:00:00Z
const PERIOD_END = 1_762_646_400; // 2025-11-09T00:00:00Z
// A subscription created by this code: seats in arrears from the first period.
const ARREARS = { seat_billing: "arrears", seat_arrears_from: "0" };

function sub(
  items: { id: string; price: string; quantity?: number }[],
  status = "active",
  metadata: Record<string, string> = ARREARS,
) {
  return {
    status,
    metadata,
    items: {
      data: items.map((i) => ({
        id: i.id,
        price: { id: i.price },
        quantity: i.quantity,
        current_period_start: PERIOD_START,
        current_period_end: PERIOD_END,
      })),
    },
  };
}

/** People who used their login this period, as billable_seat_count answers. */
function seen(n: number) {
  h.rpc.mockResolvedValue({ data: n, error: null });
}

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_seat";
  delete process.env.PLATFORM_STRIPE_SECRET_KEY;
  h.stripe.subscriptions.retrieve.mockReset();
  h.stripe.subscriptionItems.update.mockReset();
  h.stripe.subscriptionItems.create.mockReset();
  h.stripe.subscriptionItems.del.mockReset();
  h.stripe.prices.list.mockReset();
  h.stripe.subscriptions.update.mockReset();
  h.rpc.mockReset();
  h.upserts.length = 0;
  // The live account, before anything was named: it holds the prices the
  // database points at, and none of them carry a lookup key yet. These cases
  // therefore exercise the stored-id fallback — exactly what shipped before.
  h.stripe.prices.list.mockResolvedValue({
    data: [
      { id: "price_base", lookup_key: null },
      { id: "price_seat", lookup_key: null },
    ],
    has_more: false,
  });
  // Defaults: a Growth org (10 included) on a live subscription with base + seat items.
  h.results.organizations = { data: { stripe_subscription_id: "sub_abc123456" } };
  h.results.platform_plans = {
    data: [
      {
        slug: "growth",
        included_seats: 10,
        stripe_price_id: "price_base",
        stripe_seat_price_id: "price_seat",
        stripe_annual_price_id: null,
        stripe_annual_seat_price_id: null,
      },
    ],
  };
  seen(13);
  h.stripe.subscriptions.retrieve.mockResolvedValue(
    sub([
      { id: "si_base", price: "price_base", quantity: 1 },
      { id: "si_seat", price: "price_seat", quantity: 1 },
    ]),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("syncOrgSeatQuantity", () => {
  it("raises the seat quantity to the people seen this period past the allowance", async () => {
    const r = await syncOrgSeatQuantity(ORG);
    expect(r).toEqual({ synced: true, quantity: 3, changed: true });
    expect(h.stripe.subscriptionItems.update).toHaveBeenCalledWith("si_seat", {
      quantity: 3,
      proration_behavior: "none",
    });
  });

  it("creates the seat item when the subscription doesn't have one yet", async () => {
    seen(12);
    h.stripe.subscriptions.retrieve.mockResolvedValue(
      sub([{ id: "si_base", price: "price_base", quantity: 1 }]),
    );
    const r = await syncOrgSeatQuantity(ORG);
    expect(r).toEqual({ synced: true, quantity: 2, changed: true });
    expect(h.stripe.subscriptionItems.create).toHaveBeenCalledWith({
      subscription: "sub_abc123456",
      price: "price_seat",
      quantity: 2,
      proration_behavior: "none",
    });
  });

  it("removes the seat item when the org drops to/under included seats", async () => {
    seen(8);
    const r = await syncOrgSeatQuantity(ORG);
    expect(r).toEqual({ synced: true, quantity: 0, changed: true });
    expect(h.stripe.subscriptionItems.del).toHaveBeenCalledWith("si_seat", {
      proration_behavior: "none",
    });
  });

  it("is a no-op when the quantity already matches", async () => {
    h.stripe.subscriptions.retrieve.mockResolvedValue(
      sub([
        { id: "si_base", price: "price_base", quantity: 1 },
        { id: "si_seat", price: "price_seat", quantity: 3 },
      ]),
    );
    const r = await syncOrgSeatQuantity(ORG);
    expect(r).toEqual({ synced: true, quantity: 3, changed: false });
    expect(h.stripe.subscriptionItems.update).not.toHaveBeenCalled();
  });

  it("skips when the org has no live subscription", async () => {
    h.results.organizations = { data: { stripe_subscription_id: null } };
    const r = await syncOrgSeatQuantity(ORG);
    expect(r).toEqual({ skipped: "no_subscription" });
    expect(h.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("skips demo/seed subscription ids", async () => {
    h.results.organizations = { data: { stripe_subscription_id: "sub_demo_seed" } };
    const r = await syncOrgSeatQuantity(ORG);
    expect(r).toEqual({ skipped: "no_subscription" });
  });

  it("skips legacy (non per-employee) plans without touching Stripe items", async () => {
    h.results.platform_plans = { data: [] };
    const r = await syncOrgSeatQuantity(ORG);
    expect(r).toEqual({ skipped: "not_per_employee_plan" });
    expect(h.stripe.subscriptionItems.update).not.toHaveBeenCalled();
    expect(h.stripe.subscriptionItems.create).not.toHaveBeenCalled();
  });

  it("skips a canceled subscription", async () => {
    h.stripe.subscriptions.retrieve.mockResolvedValue(
      sub([{ id: "si_base", price: "price_base" }], "canceled"),
    );
    const r = await syncOrgSeatQuantity(ORG);
    expect(r).toEqual({ skipped: "status_canceled" });
  });

  // ── The sandbox case, which is why this reads the catalog at all ─────────
  //
  // Every id in `platform_plans` is a LIVE id. Under a test key the old code
  // asked the database for a plan row whose stored id equalled one on the
  // subscription, found nothing, and returned `not_per_employee_plan` — the
  // same answer it gives for a legacy per-client plan. Checkout would set the
  // initial seat count and nothing would ever reconcile it again, silently,
  // for the entire life of the subscription.

  it("finds the plan by lookup key when the subscription is in another account", async () => {
    h.stripe.prices.list.mockResolvedValue({
      data: [
        { id: "price_sandbox_base", lookup_key: "growth_base_monthly" },
        { id: "price_sandbox_seat", lookup_key: "growth_seat_monthly" },
      ],
      has_more: false,
    });
    h.stripe.subscriptions.retrieve.mockResolvedValue(
      sub([{ id: "si_base", price: "price_sandbox_base", quantity: 1 }]),
    );
    const r = await syncOrgSeatQuantity(ORG);
    expect(r).toEqual({ synced: true, quantity: 3, changed: true });
    // And the seat item it creates is THIS account's seat price, not the live
    // id the database holds — which Stripe would reject outright.
    expect(h.stripe.subscriptionItems.create).toHaveBeenCalledWith({
      subscription: "sub_abc123456",
      price: "price_sandbox_seat",
      quantity: 3,
      proration_behavior: "none",
    });
  });

  it("takes the seat price from the interval the base item is already on", async () => {
    // Stripe forbids mixing month and year items on one subscription, so an
    // annual base has to get the annual seat price — resolved by name like
    // everything else.
    h.results.platform_plans = {
      data: [
        {
          slug: "growth",
          included_seats: 10,
          stripe_price_id: "price_base",
          stripe_seat_price_id: "price_seat",
          stripe_annual_price_id: "price_base_year",
          stripe_annual_seat_price_id: "price_seat_year",
        },
      ],
    };
    h.stripe.prices.list.mockResolvedValue({
      data: [
        { id: "price_sb_year", lookup_key: "growth_base_annual" },
        { id: "price_ss_year", lookup_key: "growth_seat_annual" },
      ],
      has_more: false,
    });
    h.stripe.subscriptions.retrieve.mockResolvedValue(
      sub([{ id: "si_base", price: "price_sb_year", quantity: 1 }]),
    );
    const r = await syncOrgSeatQuantity(ORG);
    expect(r).toEqual({ synced: true, quantity: 3, changed: true });
    expect(h.stripe.subscriptionItems.create).toHaveBeenCalledWith(
      expect.objectContaining({ price: "price_ss_year" }),
    );
  });

  it("still leaves a legacy per-client plan alone even when its slug has keys", async () => {
    // A plan with no seat price at all is not per-employee and must never gain
    // a seat item. The old `.not("stripe_seat_price_id", "is", null)` filter
    // made that exclusion; resolving by name must not quietly undo it.
    h.results.platform_plans = {
      data: [
        {
          slug: "growth",
          included_seats: 10,
          stripe_price_id: "price_base",
          stripe_seat_price_id: null,
          stripe_annual_price_id: null,
          stripe_annual_seat_price_id: null,
        },
      ],
    };
    h.stripe.prices.list.mockResolvedValue({
      data: [
        { id: "price_base", lookup_key: "growth_base_monthly" },
        { id: "price_seat_sandbox", lookup_key: "growth_seat_monthly" },
      ],
      has_more: false,
    });
    const r = await syncOrgSeatQuantity(ORG);
    expect(r).toEqual({ skipped: "not_per_employee_plan" });
    expect(h.stripe.subscriptionItems.create).not.toHaveBeenCalled();
  });

  it("still reconciles an existing seat item whose price is archived", async () => {
    // Finding the seat line and minting a new one need different strictness.
    // `loadPriceCatalog` reads ACTIVE prices, so a seat price archived in
    // Stripe while subscriptions still bill on it drops out of the catalog.
    // Requiring the account to list it before touching the item would freeze
    // that org's seat billing at whatever it happened to be — a regression on
    // behaviour that worked before any of this, and one nobody would see.
    h.stripe.prices.list.mockResolvedValue({ data: [], has_more: false });
    const r = await syncOrgSeatQuantity(ORG);
    expect(r).toEqual({ synced: true, quantity: 3, changed: true });
    expect(h.stripe.subscriptionItems.update).toHaveBeenCalledWith("si_seat", {
      quantity: 3,
      proration_behavior: "none",
    });
  });

  it("refuses to create a seat item from a price this account does not have", async () => {
    // The other half of that split. There is no item to update and the stored
    // id belongs to a different account, so the only options are "say so" and
    // "send Stripe an id it rejects". A named skip is the honest one.
    h.stripe.prices.list.mockResolvedValue({ data: [], has_more: false });
    seen(12);
    h.stripe.subscriptions.retrieve.mockResolvedValue(
      sub([{ id: "si_base", price: "price_base", quantity: 1 }]),
    );
    const r = await syncOrgSeatQuantity(ORG);
    expect(r).toEqual({ skipped: "seat_price_not_in_account" });
    expect(h.stripe.subscriptionItems.create).not.toHaveBeenCalled();
  });

  it("skips when Stripe isn't configured", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const r = await syncOrgSeatQuantity(ORG);
    expect(r).toEqual({ skipped: "stripe_not_configured" });
  });
});

// ── A seat is somebody who used their login this period (2026-10-09) ───────
describe("what the seat line is told", () => {
  it("counts the people seen since THIS Stripe period began, not the staff list", async () => {
    await syncOrgSeatQuantity(ORG);
    expect(h.rpc).toHaveBeenCalledWith("billable_seat_count", {
      _org_id: ORG,
      _since: new Date(PERIOD_START * 1000).toISOString(),
    });
  });

  it("never prorates, in either direction: the renewal bills the period whole", async () => {
    seen(14);
    await syncOrgSeatQuantity(ORG);
    seen(8);
    await syncOrgSeatQuantity(ORG);
    const sends = [
      ...h.stripe.subscriptionItems.update.mock.calls.map((c) => c[1]),
      ...h.stripe.subscriptionItems.create.mock.calls.map((c) => c[0]),
      ...h.stripe.subscriptionItems.del.mock.calls.map((c) => c[1]),
    ];
    expect(sends.length).toBeGreaterThan(0);
    for (const s of sends) expect(s.proration_behavior).toBe("none");
  });

  it("nobody past the allowance used it: no seat line, so the renewal bills no seats", async () => {
    // Thirteen people on the team, two of whom opened the app this period.
    seen(2);
    const r = await syncOrgSeatQuantity(ORG);
    expect(r).toEqual({ synced: true, quantity: 0, changed: true });
    expect(h.stripe.subscriptionItems.del).toHaveBeenCalledWith("si_seat", { proration_behavior: "none" });
  });

  it("records which period it reconciled, so a sighting knows when to ask again", async () => {
    await syncOrgSeatQuantity(ORG);
    expect(h.upserts).toEqual([
      {
        table: "org_seat_periods",
        row: expect.objectContaining({
          organization_id: ORG,
          period_start: new Date(PERIOD_START * 1000).toISOString(),
          period_end: new Date(PERIOD_END * 1000).toISOString(),
          billable_seats: 13,
          seat_quantity: 3,
        }),
      },
    ]);
  });

  it("refuses to guess when the count could not be read", async () => {
    // Zero would delete the seat line and the renewal would bill nobody.
    h.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(syncOrgSeatQuantity(ORG)).rejects.toThrow(/billable_seat_count/);
    expect(h.stripe.subscriptionItems.del).not.toHaveBeenCalled();
    expect(h.stripe.subscriptionItems.update).not.toHaveBeenCalled();
  });

  it("refuses to guess when Stripe gave no period", async () => {
    h.stripe.subscriptions.retrieve.mockResolvedValue({
      status: "active",
      metadata: ARREARS,
      items: { data: [{ id: "si_base", price: { id: "price_base" }, quantity: 1 }] },
    });
    const r = await syncOrgSeatQuantity(ORG);
    expect(r).toEqual({ skipped: "no_period" });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("never bills the demo org, whatever its subscription id looks like", async () => {
    h.results.organizations = { data: { stripe_subscription_id: "sub_abc123456", slug: "demo" } };
    expect(await syncOrgSeatQuantity(ORG)).toEqual({ skipped: "demo_org" });
    h.results.organizations = { data: { stripe_subscription_id: "sub_abc123456", is_comped: true } };
    expect(await syncOrgSeatQuantity(ORG)).toEqual({ skipped: "demo_org" });
    expect(h.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });
});

describe("the changeover from seats billed in advance", () => {
  it("a subscription from before this change: its period was prepaid, so nothing more is billed for it", async () => {
    // Billed under the old rule, the seat line was charged at this period's
    // start for the period ahead. Leaving 3 there would bill this period's
    // seats a second time at renewal.
    h.stripe.subscriptions.retrieve.mockResolvedValue(
      sub(
        [
          { id: "si_base", price: "price_base", quantity: 1 },
          { id: "si_seat", price: "price_seat", quantity: 3 },
        ],
        "active",
        {},
      ),
    );
    const r = await syncOrgSeatQuantity(ORG);
    expect(r).toEqual({ synced: true, quantity: 0, changed: true });
    expect(h.stripe.subscriptionItems.del).toHaveBeenCalledWith("si_seat", { proration_behavior: "none" });
    // ...and it is marked: arrears start with the next period.
    expect(h.stripe.subscriptions.update).toHaveBeenCalledWith("sub_abc123456", {
      metadata: { seat_billing: "arrears", seat_arrears_from: String(PERIOD_END) },
    });
  });

  it("the next period, once marked, is billed in arrears", async () => {
    h.stripe.subscriptions.retrieve.mockResolvedValue(
      sub(
        [
          { id: "si_base", price: "price_base", quantity: 1 },
          { id: "si_seat", price: "price_seat", quantity: 0 },
        ],
        "active",
        { seat_billing: "arrears", seat_arrears_from: String(PERIOD_START) },
      ),
    );
    const r = await syncOrgSeatQuantity(ORG);
    expect(r).toEqual({ synced: true, quantity: 3, changed: true });
    expect(h.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("a marked subscription still inside its prepaid period stays at zero", async () => {
    h.stripe.subscriptions.retrieve.mockResolvedValue(
      sub([{ id: "si_base", price: "price_base", quantity: 1 }], "active", {
        seat_billing: "arrears",
        seat_arrears_from: String(PERIOD_END),
      }),
    );
    const r = await syncOrgSeatQuantity(ORG);
    expect(r).toEqual({ synced: true, quantity: 0, changed: false });
    expect(h.stripe.subscriptionItems.create).not.toHaveBeenCalled();
  });
});
