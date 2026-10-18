import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Shared spy/state holders (hoisted so the vi.mock factories can see them).
const h = vi.hoisted(() => ({
  stripe: {
    subscriptions: { retrieve: vi.fn() },
    subscriptionItems: { update: vi.fn(), create: vi.fn(), del: vi.fn() },
    prices: { list: vi.fn() },
  },
  results: {} as Record<string, any>,
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
      then: (res: any, rej: any) => Promise.resolve(h.results[table]).then(res, rej),
    };
    return p;
  }
  return { supabaseAdmin: { from: (t: string) => chain(t) } };
});

import { syncOrgSeatQuantity } from "@/lib/seat-sync.server";

const ORG = "342d4d1e-56f7-4b6e-ad40-524d370e1a36";

function sub(items: { id: string; price: string; quantity?: number }[], status = "active") {
  return {
    status,
    items: { data: items.map((i) => ({ id: i.id, price: { id: i.price }, quantity: i.quantity })) },
  };
}

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_seat";
  delete process.env.PLATFORM_STRIPE_SECRET_KEY;
  h.stripe.subscriptions.retrieve.mockReset();
  h.stripe.subscriptionItems.update.mockReset();
  h.stripe.subscriptionItems.create.mockReset();
  h.stripe.subscriptionItems.del.mockReset();
  h.stripe.prices.list.mockReset();
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
  // Defaults: a Growth org (5 included, the Oct 9 catalog) with 13 active
  // staff, so 8 extra, on a live subscription with base + seat items.
  h.results.organizations = { data: { stripe_subscription_id: "sub_abc123456" } };
  h.results.platform_plans = {
    data: [
      {
        slug: "growth",
        included_seats: 5,
        stripe_price_id: "price_base",
        stripe_seat_price_id: "price_seat",
        stripe_annual_price_id: null,
        stripe_annual_seat_price_id: null,
      },
    ],
  };
  h.results.staff = { count: 13 };
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
  it("raises the seat quantity to the current overage", async () => {
    const r = await syncOrgSeatQuantity(ORG);
    expect(r).toEqual({ synced: true, quantity: 8, changed: true });
    expect(h.stripe.subscriptionItems.update).toHaveBeenCalledWith("si_seat", {
      quantity: 8,
      proration_behavior: "create_prorations",
    });
  });

  it("creates the seat item when the subscription doesn't have one yet", async () => {
    h.results.staff = { count: 12 };
    h.stripe.subscriptions.retrieve.mockResolvedValue(
      sub([{ id: "si_base", price: "price_base", quantity: 1 }]),
    );
    const r = await syncOrgSeatQuantity(ORG);
    expect(r).toEqual({ synced: true, quantity: 7, changed: true });
    expect(h.stripe.subscriptionItems.create).toHaveBeenCalledWith({
      subscription: "sub_abc123456",
      price: "price_seat",
      quantity: 7,
      proration_behavior: "create_prorations",
    });
  });

  it("removes the seat item when the org drops to/under included seats", async () => {
    h.results.staff = { count: 5 };
    const r = await syncOrgSeatQuantity(ORG);
    expect(r).toEqual({ synced: true, quantity: 0, changed: true });
    expect(h.stripe.subscriptionItems.del).toHaveBeenCalledWith("si_seat", {
      proration_behavior: "create_prorations",
    });
  });

  it("is a no-op when the quantity already matches", async () => {
    h.stripe.subscriptions.retrieve.mockResolvedValue(
      sub([
        { id: "si_base", price: "price_base", quantity: 1 },
        { id: "si_seat", price: "price_seat", quantity: 8 },
      ]),
    );
    const r = await syncOrgSeatQuantity(ORG);
    expect(r).toEqual({ synced: true, quantity: 8, changed: false });
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
    expect(r).toEqual({ synced: true, quantity: 8, changed: true });
    // And the seat item it creates is THIS account's seat price, not the live
    // id the database holds — which Stripe would reject outright.
    expect(h.stripe.subscriptionItems.create).toHaveBeenCalledWith({
      subscription: "sub_abc123456",
      price: "price_sandbox_seat",
      quantity: 8,
      proration_behavior: "create_prorations",
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
          included_seats: 5,
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
    expect(r).toEqual({ synced: true, quantity: 8, changed: true });
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
          included_seats: 5,
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
    expect(r).toEqual({ synced: true, quantity: 8, changed: true });
    expect(h.stripe.subscriptionItems.update).toHaveBeenCalledWith("si_seat", {
      quantity: 8,
      proration_behavior: "create_prorations",
    });
  });

  it("refuses to create a seat item from a price this account does not have", async () => {
    // The other half of that split. There is no item to update and the stored
    // id belongs to a different account, so the only options are "say so" and
    // "send Stripe an id it rejects". A named skip is the honest one.
    h.stripe.prices.list.mockResolvedValue({ data: [], has_more: false });
    h.results.staff = { count: 12 };
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
