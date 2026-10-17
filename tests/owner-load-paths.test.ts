import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  tables: {} as Record<string, any>,
  errors: new Set<string>(),
  events: [] as string[],
  role: "owner",
  subscriptionId: "sub_test",
}));

function delayed<T>(name: string, value: T): Promise<T> {
  const events = state.events;
  events.push(`start:${name}`);
  return new Promise((resolve) => setTimeout(() => {
    events.push(`end:${name}`);
    resolve(value);
  }, 10));
}

function chain(table: string) {
  const q: any = {};
  for (const method of ["select", "eq", "in", "is", "gte", "lte", "order", "range", "limit", "single", "maybeSingle"]) {
    q[method] = () => q;
  }
  q.then = (resolve: any, reject: any) => delayed(table, {
    data: state.tables[table] ?? [],
    count: 112,
    error: state.errors.has(table) ? { message: `${table} unavailable` } : null,
  }).then(resolve, reject);
  return q;
}
const db = { from: chain };

vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    const b: any = {
      middleware: () => b,
      inputValidator: () => b,
      handler: (h: any) => () => h({ context: { supabase: db, userId: "owner" } }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: db }));
vi.mock("@/lib/authz.server", () => ({
  resolveCaller: async () => ({ orgId: "org", role: state.role }),
  requirePermission: async () => ({ orgId: "org", role: state.role }),
}));
vi.mock("@/lib/billing-state.server", () => ({
  getOrgBillingState: async () => ({ stripeSubscriptionId: state.subscriptionId, stripeCustomerId: "cus_test123456" }),
  subscriptionPeriodEnd: () => null,
}));
vi.mock("@/lib/stripe-client.server", () => ({
  makeStripe: async () => ({
    subscriptions: {
      retrieve: () => delayed("stripe-subscription", {
        id: "sub_test", default_payment_method: "pm_sub", items: { data: [] },
      }),
    },
    customers: {
      retrieve: () => delayed("stripe-customer", { invoice_settings: { default_payment_method: "pm_customer" } }),
      listPaymentMethods: () => delayed("stripe-methods", {
        data: [{ id: "pm_sub", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } }],
      }),
    },
  }),
}));
vi.mock("@/lib/stripe-price-catalog.server", () => ({
  loadPriceCatalog: () => delayed("stripe-catalog", new Map()),
  resolvePriceId: vi.fn(),
  resolvePriceIdSet: () => new Set(),
}));

import { getDashboardSummary } from "@/lib/dashboard.functions";
import { listSubscriptionItems, listOrgPaymentMethods } from "@/lib/billing.functions";
import { listClients } from "@/lib/clients.functions";
import { collectedMonthToDate } from "@/lib/revenue.server";

function overlaps(a: string, b: string) {
  expect(state.events.indexOf(`start:${a}`)).toBeGreaterThanOrEqual(0);
  expect(state.events.indexOf(`start:${b}`)).toBeGreaterThanOrEqual(0);
  expect(state.events.indexOf(`start:${a}`)).toBeLessThan(state.events.indexOf(`end:${b}`));
  expect(state.events.indexOf(`start:${b}`)).toBeLessThan(state.events.indexOf(`end:${a}`));
}

beforeEach(() => {
  state.events = [];
  state.errors.clear();
  state.role = "owner";
  state.subscriptionId = "sub_test";
  const now = new Date().toISOString();
  state.tables = {
    organizations: { timezone: "UTC", disputes_in_analytics: false },
    payments: [{ id: "payment", amount_cents: 10000, tax_cents: 1000, status: "succeeded", paid_at: now, created_at: now }],
    review_items: [{ id: "refund", kind: "payment_refunded", detected_at: now, detail: { revenue_cents: 2000 } }],
  };
  vi.stubEnv("STRIPE_SECRET_KEY", "test-placeholder");
});
afterEach(() => vi.unstubAllEnvs());

describe("owner read paths", () => {
  it("reads dashboard settings once and overlaps receipts with refunds", async () => {
    const result = await getDashboardSummary();
    expect(state.events.filter((e) => e === "start:organizations")).toHaveLength(1);
    overlaps("payments", "review_items");
    expect(result).toMatchObject({ activeClients: 112, mtdRevenueCents: 7000, mtdGrossCents: 9000, mtdRefundsCents: 2000 });
  });

  it("combines month-to-date settings for other callers too", async () => {
    const result = await collectedMonthToDate(db, "org");
    expect(state.events.filter((e) => e === "start:organizations")).toHaveLength(1);
    expect(result.netCents).toBe(7000);
  });

  it("never starts financial reads for a dispatcher", async () => {
    state.role = "dispatcher";
    const result = await getDashboardSummary();
    expect(result.mtdRevenueCents).toBeNull();
    expect(result.overdueInvoices).toBeNull();
    for (const name of ["payments", "review_items", "invoices"]) {
      expect(state.events).not.toContain(`start:${name}`);
    }
  });

  it.each(["organizations", "clients", "visits", "staff", "qc_tickets", "payments", "review_items", "invoices"])(
    "does not turn a failed %s dashboard read into zero", async (table) => {
      state.errors.add(table);
      await expect(getDashboardSummary()).rejects.toThrow(`${table} unavailable`);
    },
  );

  it("overlaps Stripe subscription, price catalog and database catalog reads", async () => {
    await listSubscriptionItems();
    overlaps("stripe-subscription", "stripe-catalog");
    overlaps("stripe-subscription", "platform_plans");
  });

  it("does not contact Stripe without a subscription", async () => {
    state.subscriptionId = "";
    expect(await listSubscriptionItems()).toMatchObject({ items: [], subscriptionId: null });
    expect(state.events).toEqual([]);
  });

  it("overlaps card listing with default lookup and keeps subscription precedence", async () => {
    const result = await listOrgPaymentMethods();
    overlaps("stripe-methods", "stripe-subscription");
    expect(result.methods[0]).toMatchObject({ id: "pm_sub", isDefault: true });
  });

  it.each(["properties", "subscriptions", "invoices"])(
    "does not publish a roster with invented aggregates when %s fails", async (table) => {
      state.tables.clients = [{ id: "client", active: true }];
      state.errors.add(table);
      await expect(listClients()).rejects.toThrow(`${table} unavailable`);
    },
  );

  it("uses a fixed number of batched reads for a roster of 112 clients", async () => {
    state.tables.clients = Array.from({ length: 112 }, (_, i) => ({ id: `client-${i}`, active: true }));
    expect((await listClients()).clients).toHaveLength(112);
    expect(state.events.filter((e) => e.startsWith("start:"))).toHaveLength(4);
    overlaps("properties", "subscriptions");
    overlaps("subscriptions", "invoices");
  });
});
