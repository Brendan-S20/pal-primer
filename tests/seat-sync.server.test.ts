import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Shared spy/state holders (hoisted so the vi.mock factories can see them).
const h = vi.hoisted(() => ({
  stripe: {
    subscriptions: { retrieve: vi.fn() },
    subscriptionItems: { update: vi.fn(), create: vi.fn(), del: vi.fn() },
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
  // Defaults: a Growth org (10 included) on a live subscription with base + seat items.
  h.results.organizations = { data: { stripe_subscription_id: "sub_abc123456" } };
  h.results.platform_plans = { data: { included_seats: 10, stripe_seat_price_id: "price_seat" } };
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
    expect(r).toEqual({ synced: true, quantity: 3, changed: true });
    expect(h.stripe.subscriptionItems.update).toHaveBeenCalledWith("si_seat", {
      quantity: 3,
      proration_behavior: "create_prorations",
    });
  });

  it("creates the seat item when the subscription doesn't have one yet", async () => {
    h.results.staff = { count: 12 };
    h.stripe.subscriptions.retrieve.mockResolvedValue(
      sub([{ id: "si_base", price: "price_base", quantity: 1 }]),
    );
    const r = await syncOrgSeatQuantity(ORG);
    expect(r).toEqual({ synced: true, quantity: 2, changed: true });
    expect(h.stripe.subscriptionItems.create).toHaveBeenCalledWith({
      subscription: "sub_abc123456",
      price: "price_seat",
      quantity: 2,
      proration_behavior: "create_prorations",
    });
  });

  it("removes the seat item when the org drops to/under included seats", async () => {
    h.results.staff = { count: 8 };
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
    h.results.platform_plans = { data: null };
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

  it("skips when Stripe isn't configured", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const r = await syncOrgSeatQuantity(ORG);
    expect(r).toEqual({ skipped: "stripe_not_configured" });
  });
});
