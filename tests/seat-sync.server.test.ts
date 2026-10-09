import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The changeover from the licensed seat line, and the plan facts a seat
// charge is made from (seat-sync.server.ts). The charge itself is
// tests/seat-charges.test.ts.
//
// Owner, 2026-10-09: a period that was already prepaid under the old rule
// stays paid, no credit; the new rule starts with the next period. So the old
// seat item is deleted with NO proration, and the subscription is marked with
// the moment its prepaid seats run out.

const h = vi.hoisted(() => ({
  stripe: {
    subscriptions: { retrieve: vi.fn(), update: vi.fn() },
    subscriptionItems: { update: vi.fn(), create: vi.fn(), del: vi.fn() },
    prices: { list: vi.fn() },
  },
  results: {} as Record<string, any>,
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
      maybeSingle: () => Promise.resolve(h.results[table]),
      upsert: (row: any) => {
        h.upserts.push({ table, row });
        return Promise.resolve({ error: null });
      },
      then: (res: any, rej: any) => Promise.resolve(h.results[table]).then(res, rej),
    };
    return p;
  }
  return { supabaseAdmin: { from: (t: string) => chain(t), rpc: vi.fn() } };
});

import { prepareSeatBilling, resolveSeatPlan, syncOrgSeatQuantity } from "@/lib/seat-sync.server";

const ORG = "342d4d1e-56f7-4b6e-ad40-524d370e1a36";
const PERIOD_START = 1_759_968_000; // 2025-10-09T00:00:00Z
const PERIOD_END = 1_762_646_400; // 2025-11-09T00:00:00Z
const CHARGED_BY_PERIOD = { seat_billing: "arrears", seat_arrears_from: "0" };

function sub(
  items: { id: string; price: string; quantity?: number }[],
  metadata: Record<string, string> = {},
  status = "active",
) {
  return {
    id: "sub_abc123456",
    status,
    metadata,
    billing_cycle_anchor: PERIOD_START,
    items: {
      data: items.map((i) => ({
        id: i.id,
        price: { id: i.price },
        quantity: i.quantity,
        current_period_start: PERIOD_START,
        current_period_end: PERIOD_END,
      })),
    },
  } as any;
}

const WITH_SEAT_LINE = () =>
  sub([
    { id: "si_base", price: "price_base", quantity: 1 },
    { id: "si_seat", price: "price_seat", quantity: 3 },
  ]);

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_seat";
  delete process.env.PLATFORM_STRIPE_SECRET_KEY;
  for (const f of [
    h.stripe.subscriptions.retrieve,
    h.stripe.subscriptions.update,
    h.stripe.subscriptionItems.update,
    h.stripe.subscriptionItems.create,
    h.stripe.subscriptionItems.del,
    h.stripe.prices.list,
  ])
    f.mockReset();
  h.upserts.length = 0;
  // The live account, before anything was named: it holds the prices the
  // database points at, and none carry a lookup key yet.
  h.stripe.prices.list.mockResolvedValue({
    data: [
      { id: "price_base", lookup_key: null },
      { id: "price_seat", lookup_key: null },
    ],
    has_more: false,
  });
  h.results.organizations = { data: { stripe_subscription_id: "sub_abc123456" } };
  h.results.platform_plans = {
    data: [
      {
        slug: "growth",
        included_seats: 10,
        price_per_seat_cents: 1000,
        stripe_price_id: "price_base",
        stripe_seat_price_id: "price_seat",
        stripe_annual_price_id: null,
        stripe_annual_seat_price_id: null,
      },
    ],
  };
  h.stripe.subscriptions.retrieve.mockResolvedValue(WITH_SEAT_LINE());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("the changeover", () => {
  it("a subscription on the old rule: its period stays paid, the seat line goes, no proration", async () => {
    const r = await syncOrgSeatQuantity(ORG);
    expect(r).toEqual({ synced: true, quantity: 0, changed: true });
    // Marked first: per-period charging starts when the prepaid period ends.
    expect(h.stripe.subscriptions.update).toHaveBeenCalledWith("sub_abc123456", {
      metadata: { seat_billing: "arrears", seat_arrears_from: String(PERIOD_END) },
    });
    // Then removed. No proration in either direction: no credit for the
    // prepaid period (owner's decision), and no charge.
    expect(h.stripe.subscriptionItems.del).toHaveBeenCalledWith("si_seat", { proration_behavior: "none" });
    expect(h.stripe.subscriptions.update.mock.invocationCallOrder[0]).toBeLessThan(
      h.stripe.subscriptionItems.del.mock.invocationCallOrder[0],
    );
    // Nothing is ever ADDED as a seat line again.
    expect(h.stripe.subscriptionItems.create).not.toHaveBeenCalled();
    expect(h.stripe.subscriptionItems.update).not.toHaveBeenCalled();
  });

  it("is a no-op once done", async () => {
    h.stripe.subscriptions.retrieve.mockResolvedValue(
      sub([{ id: "si_base", price: "price_base", quantity: 1 }], CHARGED_BY_PERIOD),
    );
    const r = await syncOrgSeatQuantity(ORG);
    expect(r).toEqual({ synced: true, quantity: 0, changed: false });
    expect(h.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(h.stripe.subscriptionItems.del).not.toHaveBeenCalled();
  });

  it("a marked subscription that still has a seat line (a delete that failed) is marked through this period", async () => {
    h.stripe.subscriptions.retrieve.mockResolvedValue(
      sub(
        [
          { id: "si_base", price: "price_base", quantity: 1 },
          { id: "si_seat", price: "price_seat", quantity: 3 },
        ],
        { seat_billing: "arrears", seat_arrears_from: String(PERIOD_START) },
      ),
    );
    await syncOrgSeatQuantity(ORG);
    // The line charged this period in advance; charging it by period too
    // would be twice.
    expect(h.stripe.subscriptions.update).toHaveBeenCalledWith("sub_abc123456", {
      metadata: { seat_billing: "arrears", seat_arrears_from: String(PERIOD_END) },
    });
  });

  it("a renewal invoice that already charged the new period in advance pushes the marker past it", async () => {
    const stripe = h.stripe as any;
    const plan = await resolveSeatPlan(stripe, WITH_SEAT_LINE(), (await import("@/integrations/supabase/client.server")).supabaseAdmin);
    const r = await prepareSeatBilling(stripe, WITH_SEAT_LINE(), plan!, { prepaidThrough: PERIOD_END + 100 });
    expect(r.markedFrom).toBe(PERIOD_END + 100);
  });

  it("never pulls an existing marker earlier", async () => {
    const stripe = h.stripe as any;
    const s = sub([{ id: "si_base", price: "price_base", quantity: 1 }], {
      seat_billing: "arrears",
      seat_arrears_from: String(PERIOD_END + 999),
    });
    const plan = await resolveSeatPlan(stripe, s, (await import("@/integrations/supabase/client.server")).supabaseAdmin);
    const r = await prepareSeatBilling(stripe, s, plan!, { prepaidThrough: PERIOD_START });
    expect(r).toEqual({ markedFrom: PERIOD_END + 999, removed: 0, changed: false });
  });

  it("records the seat period the org is in", async () => {
    await syncOrgSeatQuantity(ORG);
    expect(h.upserts).toEqual([
      {
        table: "org_seat_periods",
        row: expect.objectContaining({ organization_id: ORG }),
      },
    ]);
  });
});

describe("who is left alone", () => {
  it("an org with no live subscription", async () => {
    h.results.organizations = { data: { stripe_subscription_id: null } };
    expect(await syncOrgSeatQuantity(ORG)).toEqual({ skipped: "no_subscription" });
    expect(h.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("the demo org, and any comped org, whatever its subscription id looks like", async () => {
    h.results.organizations = { data: { stripe_subscription_id: "sub_abc123456", slug: "demo" } };
    expect(await syncOrgSeatQuantity(ORG)).toEqual({ skipped: "demo_org" });
    h.results.organizations = { data: { stripe_subscription_id: "sub_abc123456", is_comped: true } };
    expect(await syncOrgSeatQuantity(ORG)).toEqual({ skipped: "demo_org" });
    h.results.organizations = { data: { stripe_subscription_id: "sub_demo_seed" } };
    expect(await syncOrgSeatQuantity(ORG)).toEqual({ skipped: "no_subscription" });
    expect(h.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("a legacy per-client plan", async () => {
    h.results.platform_plans = { data: [] };
    expect(await syncOrgSeatQuantity(ORG)).toEqual({ skipped: "not_per_employee_plan" });
    expect(h.stripe.subscriptionItems.del).not.toHaveBeenCalled();
  });

  it("a canceled subscription", async () => {
    h.stripe.subscriptions.retrieve.mockResolvedValue(sub([{ id: "si_base", price: "price_base" }], {}, "canceled"));
    expect(await syncOrgSeatQuantity(ORG)).toEqual({ skipped: "status_canceled" });
  });

  it("when Stripe isn't configured", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect(await syncOrgSeatQuantity(ORG)).toEqual({ skipped: "stripe_not_configured" });
  });
});

describe("resolveSeatPlan", () => {
  const admin = async () => (await import("@/integrations/supabase/client.server")).supabaseAdmin;

  it("gives the allowance and the MONTHLY seat price, which yearly plans are charged by the month too", async () => {
    const plan = await resolveSeatPlan(h.stripe as any, WITH_SEAT_LINE(), await admin());
    expect(plan).toMatchObject({ slug: "growth", includedSeats: 10, unitAmountCents: 1000 });
  });

  it("finds the plan by lookup key when the subscription is in another account", async () => {
    // Every id in platform_plans is a LIVE id. Under a test key, matching by
    // stored id alone found nothing and looked exactly like a legacy plan.
    h.stripe.prices.list.mockResolvedValue({
      data: [
        { id: "price_sandbox_base", lookup_key: "growth_base_monthly" },
        { id: "price_sandbox_seat", lookup_key: "growth_seat_monthly" },
      ],
      has_more: false,
    });
    const s = sub([
      { id: "si_base", price: "price_sandbox_base", quantity: 1 },
      { id: "si_seat", price: "price_sandbox_seat", quantity: 2 },
    ]);
    const plan = await resolveSeatPlan(h.stripe as any, s, await admin());
    expect(plan?.includedSeats).toBe(10);
    // And the sandbox seat line is recognised, so the changeover removes it.
    expect(plan?.seatPriceIds.has("price_sandbox_seat")).toBe(true);
  });

  it("recognises a yearly plan by its yearly base price", async () => {
    h.results.platform_plans.data[0].stripe_annual_price_id = "price_base_year";
    h.results.platform_plans.data[0].stripe_annual_seat_price_id = "price_seat_year";
    const s = sub([
      { id: "si_base", price: "price_base_year", quantity: 1 },
      { id: "si_seat", price: "price_seat_year", quantity: 1 },
    ]);
    const plan = await resolveSeatPlan(h.stripe as any, s, await admin());
    expect(plan?.unitAmountCents).toBe(1000);
    expect(plan?.seatPriceIds.has("price_seat_year")).toBe(true);
  });

  it("still recognises a seat line whose price is archived in Stripe", async () => {
    // loadPriceCatalog reads ACTIVE prices; the stored id stays in the set so
    // an archived seat price is still removed at the changeover.
    h.stripe.prices.list.mockResolvedValue({ data: [], has_more: false });
    const plan = await resolveSeatPlan(h.stripe as any, WITH_SEAT_LINE(), await admin());
    expect(plan?.seatPriceIds.has("price_seat")).toBe(true);
  });

  it("leaves a legacy per-client plan alone even when its slug has keys", async () => {
    h.results.platform_plans.data[0].stripe_seat_price_id = null;
    expect(await resolveSeatPlan(h.stripe as any, WITH_SEAT_LINE(), await admin())).toBeNull();
  });
});
