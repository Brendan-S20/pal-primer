// Done-for-you setup is free where the site says it is (spec NP-4).
//
// houndstack.com/pricing: "Done-for-you setup is $199 one time, and free with
// yearly billing, on Scale, or for founding accounts." Until 2026-10-10 the app
// charged $199 to everyone. The rule is `setupIsFreeFor` in
// src/lib/done-for-you-setup.ts; the purchase path and the billing page both
// ask it.
//
// These run `subscribePlatformAddon` for real with the framework, Supabase and
// Stripe faked, the same way a-held-add-on-never-reaches-stripe.test.ts does:
// the Stripe fake records every property touched on it and `makeStripe` is a
// spy, so "no charge" is a fact about the run, counted the way
// scripts/release-gate/harness.mjs counts the app's Stripe client.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setupIsFreeFor, subscriptionInterval, SETUP_ADDON_SLUG } from "@/lib/done-for-you-setup";

const ORG = "0f000000-0000-4000-8000-0000000000b1";
const LAUNCH = "10000000-0000-4000-8000-000000000001";
const GROWTH = "10000000-0000-4000-8000-000000000002";
const SCALE = "10000000-0000-4000-8000-000000000003";
const SETUP_ID = "20000000-0000-4000-8000-000000000098";
const PRIORITY_ID = "20000000-0000-4000-8000-000000000099";

type Row = Record<string, any>;
let tables: Record<string, Row[]> = {};
const writes: Array<{ table: string; op: string; payload: any }> = [];

function chain(table: string) {
  const filters: Array<[string, unknown]> = [];
  let op: "select" | "update" | "upsert" | "insert" = "select";
  let payload: unknown;
  const rows = () => (tables[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
  const run = async () => {
    if (op !== "select") {
      writes.push({ table, op, payload });
      return { data: null, error: null };
    }
    return { data: rows(), error: null, count: rows().length };
  };
  const api: any = {
    select: () => api,
    eq: (k: string, v: unknown) => (filters.push([k, v]), api),
    not: () => api,
    order: () => api,
    in: () => api,
    update: (p: unknown) => ((op = "update"), (payload = p), api),
    upsert: (p: unknown) => ((op = "upsert"), (payload = p), api),
    insert: (p: unknown) => ((op = "insert"), (payload = p), api),
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    single: async () => ({ data: rows()[0] ?? null, error: rows()[0] ? null : { message: "no rows" } }),
    then: (res: any, rej: any) => run().then(res, rej),
  };
  return api;
}
const db = { from: (t: string) => chain(t), auth: { getUser: async () => ({ data: { user: null } }) } };

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (d: unknown) => unknown = (d) => d;
    const b: any = {
      middleware: () => b,
      inputValidator: (v: (d: unknown) => unknown) => ((validate = v), b),
      handler:
        (h: (ctx: { data: unknown; context: unknown }) => unknown) =>
        (opts: { data?: unknown } = {}) =>
          h({ data: validate(opts.data), context: { supabase: db, userId: "user-1" } }),
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

/** Every property read off the Stripe client, in order. Empty means untouched. */
const stripeTouches: string[] = [];
const invoiceItemCreates: any[] = [];
let subscriptionIntervalInStripe: "month" | "year" = "month";
const makeStripe = vi.fn(async () => {
  const impl: Record<string, Record<string, any>> = {
    prices: {
      list: async () => ({
        data: [{ id: "price_setup_test", lookup_key: "addon_developer_setup", unit_amount: 19900 }],
        has_more: false,
      }),
    },
    subscriptions: {
      retrieve: async () => ({
        id: "sub_1",
        items: {
          data: [{ price: { id: "price_plan", recurring: { interval: subscriptionIntervalInStripe } } }],
        },
      }),
    },
    invoiceItems: {
      create: async (params: any) => (invoiceItemCreates.push(params), { id: "ii_setup" }),
    },
  };
  return new Proxy(
    {},
    {
      get: (_t, resource: string) => {
        stripeTouches.push(resource);
        return new Proxy(
          {},
          {
            get: (_t2, method: string) => {
              stripeTouches.push(`${resource}.${method}`);
              return impl[resource]?.[method] ?? (async () => ({ id: `${resource}_x`, data: [] }));
            },
          },
        );
      },
    },
  );
});
vi.mock("@/lib/stripe-client.server", () => ({ makeStripe }));

function seed(opts: { planId: string; foundingPlace?: number | null | "none"; interval?: "month" | "year" }) {
  subscriptionIntervalInStripe = opts.interval ?? "month";
  tables = {
    platform_addons: [
      {
        id: SETUP_ID,
        slug: SETUP_ADDON_SLUG,
        name: "Done-for-you setup",
        description: null,
        price_cents: 19900,
        billing_interval: "one_time",
        status: "active",
        is_active: true,
        stripe_product_id: "prod_setup",
        stripe_price_id: "price_1UP1QtQjJFmqXgZDJA7vgmdX",
        feature_flag: null,
        sort_order: 5,
      },
      {
        id: PRIORITY_ID,
        slug: "priority-support",
        name: "Priority support",
        description: null,
        price_cents: 9900,
        billing_interval: "month",
        status: "active",
        is_active: true,
        stripe_product_id: "prod_priority",
        stripe_price_id: "price_priority",
        feature_flag: null,
        sort_order: 4,
      },
    ],
    platform_plans: [
      { id: LAUNCH, slug: "launch" },
      { id: GROWTH, slug: "growth" },
      { id: SCALE, slug: "scale" },
    ],
    organizations: [
      {
        id: ORG,
        stripe_subscription_id: "sub_1",
        stripe_customer_id: "cus_1",
        plan_status: "active",
        plan_id: opts.planId,
      },
    ],
    founding_accounts:
      opts.foundingPlace === undefined || opts.foundingPlace === "none"
        ? []
        : [{ organization_id: ORG, stripe_subscription_id: "sub_1", place: opts.foundingPlace }],
    org_platform_addons: [],
  };
}

async function buySetup() {
  const { subscribePlatformAddon } = await import("@/lib/platform-addons.functions");
  return subscribePlatformAddon({ data: { addonId: SETUP_ID } } as any);
}

const recorded = () => writes.filter((w) => w.table === "org_platform_addons" && w.op === "upsert");

beforeEach(() => {
  stripeTouches.length = 0;
  writes.length = 0;
  invoiceItemCreates.length = 0;
  makeStripe.mockClear();
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
});

describe("the rule", () => {
  it("is free on Scale, for a founding place, and on yearly billing; charged otherwise", () => {
    expect(setupIsFreeFor({ planSlug: "scale", founding: false, planInterval: "month" })).toBe("scale");
    expect(setupIsFreeFor({ planSlug: "launch", founding: true, planInterval: "month" })).toBe("founding");
    expect(setupIsFreeFor({ planSlug: "growth", founding: false, planInterval: "year" })).toBe("yearly");
    expect(setupIsFreeFor({ planSlug: "growth", founding: false, planInterval: "month" })).toBeNull();
    expect(setupIsFreeFor({ planSlug: "launch", founding: false, planInterval: null })).toBeNull();
    expect(setupIsFreeFor({ planSlug: null, founding: false, planInterval: undefined })).toBeNull();
  });

  it("names the cheapest-to-know reason first when more than one holds", () => {
    expect(setupIsFreeFor({ planSlug: "scale", founding: true, planInterval: "year" })).toBe("scale");
    expect(setupIsFreeFor({ planSlug: "launch", founding: true, planInterval: "year" })).toBe("founding");
  });

  it("reads the interval off the subscription's items", () => {
    expect(subscriptionInterval({ items: { data: [{ price: { recurring: { interval: "year" } } }] } })).toBe("year");
    expect(subscriptionInterval({ items: { data: [{ price: { recurring: { interval: "month" } } }] } })).toBe("month");
    expect(subscriptionInterval({ items: { data: [{ price: { recurring: null } }] } })).toBeNull();
    expect(subscriptionInterval(null)).toBeNull();
  });
});

describe("a qualifying org gets setup with no Stripe charge", () => {
  it("Scale: recorded as waived, Stripe never touched", async () => {
    seed({ planId: SCALE });
    expect(await buySetup()).toEqual({ ok: true, waived: "scale" });
    expect(makeStripe).not.toHaveBeenCalled();
    expect(stripeTouches).toEqual([]);
    expect(recorded()).toEqual([
      {
        table: "org_platform_addons",
        op: "upsert",
        payload: {
          organization_id: ORG,
          addon_id: SETUP_ID,
          stripe_subscription_item_id: null,
          status: "active",
          canceled_at: null,
          waived_reason: "scale",
        },
      },
    ]);
  });

  it("founding place: recorded as waived, Stripe never touched", async () => {
    seed({ planId: LAUNCH, foundingPlace: 7 });
    expect(await buySetup()).toEqual({ ok: true, waived: "founding" });
    expect(makeStripe).not.toHaveBeenCalled();
    expect(stripeTouches).toEqual([]);
    expect(recorded()[0].payload).toMatchObject({ status: "active", waived_reason: "founding" });
  });

  it("yearly billing: the subscription is read for its interval, and nothing is charged", async () => {
    seed({ planId: GROWTH, interval: "year" });
    expect(await buySetup()).toEqual({ ok: true, waived: "yearly" });
    // One read to learn the interval; no invoice item, no subscription item,
    // no price looked up or minted.
    // (`then` is the await on the client itself, not a Stripe resource.)
    expect(stripeTouches.filter((t) => t !== "then")).toEqual(["subscriptions", "subscriptions.retrieve"]);
    expect(invoiceItemCreates).toEqual([]);
    expect(recorded()[0].payload).toMatchObject({ status: "active", waived_reason: "yearly" });
  });
});

describe("a non-qualifying org is still charged $199 through Stripe", () => {
  it("monthly Growth, no founding place: one invoice item at addon_developer_setup", async () => {
    seed({ planId: GROWTH, interval: "month" });
    expect(await buySetup()).toEqual({ ok: true });
    expect(makeStripe).toHaveBeenCalledTimes(1);
    expect(stripeTouches).toContain("prices.list");
    expect(invoiceItemCreates).toHaveLength(1);
    expect(invoiceItemCreates[0]).toMatchObject({
      customer: "cus_1",
      pricing: { price: "price_setup_test" },
      subscription: "sub_1",
    });
    // Recorded exactly as before: no waiver on the row.
    const row = recorded()[0].payload;
    expect(row).toMatchObject({ addon_id: SETUP_ID, status: "active", stripe_subscription_item_id: null });
    expect(row).not.toHaveProperty("waived_reason");
  });

  it("a founding row with no place (paid after the places were gone) is not founding", async () => {
    seed({ planId: LAUNCH, foundingPlace: null, interval: "month" });
    expect(await buySetup()).toEqual({ ok: true });
    expect(invoiceItemCreates).toHaveLength(1);
  });

  it("the waiver is for setup only: Priority support on yearly Launch is still sold", async () => {
    seed({ planId: LAUNCH, interval: "year" });
    const { subscribePlatformAddon } = await import("@/lib/platform-addons.functions");
    await subscribePlatformAddon({ data: { addonId: PRIORITY_ID } } as any).catch(() => undefined);
    expect(recorded().some((w) => w.payload?.waived_reason)).toBe(false);
    expect(stripeTouches.some((t) => t.startsWith("subscriptionItems.create"))).toBe(true);
  });
});

describe("the billing page asks the same rule", () => {
  it("is handed the plan and the founding place, and reads waived rows", async () => {
    seed({ planId: LAUNCH, foundingPlace: 3 });
    tables.org_platform_addons = [
      { organization_id: ORG, addon_id: SETUP_ID, status: "active", waived_reason: "founding" },
    ];
    const { listPlatformAddons } = await import("@/lib/platform-addons.functions");
    const out = await listPlatformAddons({} as any);
    expect(out.setup).toEqual({ planSlug: "launch", founding: true });
    expect(out.addons.find((a) => a.id === SETUP_ID)?.waivedReason).toBe("founding");
    expect(makeStripe).not.toHaveBeenCalled();
  });

  it("the card decides with setupIsFreeFor, not a copy of it", () => {
    const page = readFileSync(
      join(import.meta.dirname, "..", "src/routes/_authenticated/settings.billing.tsx"),
      "utf8",
    );
    expect(page).toMatch(/setupIsFreeFor\(\{ \.\.\.data\.setup, planInterval \}\)/);
    expect(page).not.toMatch(/=== "scale"/);
    expect(page).not.toMatch(/founding_accounts/);
  });
});
