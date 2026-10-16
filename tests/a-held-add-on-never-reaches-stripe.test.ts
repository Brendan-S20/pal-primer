// A held add-on never reaches Stripe (spec B-P0-2, B-P0-4, NP-3, NP-5).
//
// The billing page shows a disabled "Coming soon" button for the AI
// Receptionist, Managed texting and White label, but a server function is an
// HTTP endpoint: anyone signed in can POST to it with a button's add-on id. So
// the block that matters is the server's, and the claim it has to support is
// not "it throws" but "it throws BEFORE any Stripe call" — a refusal after a
// subscription item was created is a charge with an error message on it.
//
// These run `subscribePlatformAddon` for real, with the framework, Supabase and
// Stripe faked. The Stripe fake records every property touched on it, so "no
// Stripe call" is a fact about the run rather than a reading of the source.
//
// The worst case is tested deliberately: every held row is set to `active`,
// as if a platform admin had flipped it on /platform/addons. The code-level
// flag still refuses.
//
// A second block covers the interval switch: a grandfathered add-on going from
// yearly to monthly keeps the amount it is on, not today's catalog price.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HELD_ADDON_SLUGS, ADDON_LAUNCHED } from "@/lib/addon-launch";

const ORG = "0f000000-0000-4000-8000-0000000000a1";
const LAUNCH = "10000000-0000-4000-8000-000000000001";
const GROWTH = "10000000-0000-4000-8000-000000000002";

type Row = Record<string, any>;
let tables: Record<string, Row[]> = {};
const writes: Array<{ table: string; op: string; payload: unknown }> = [];

/** A PostgREST-shaped chain that filters on `.eq`, ignores ordering and the
 *  rest, and records writes. Just enough for the two handlers under test. */
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
let stripeImpl: Record<string, any> = {};
const makeStripe = vi.fn(async () =>
  new Proxy(
    {},
    {
      get: (_t, resource: string) => {
        stripeTouches.push(resource);
        return new Proxy(
          {},
          {
            get: (_t2, method: string) => {
              stripeTouches.push(`${resource}.${method}`);
              return stripeImpl[resource]?.[method] ?? (async () => ({ id: `${resource}_x`, data: [] }));
            },
          },
        );
      },
    },
  ),
);
vi.mock("@/lib/stripe-client.server", () => ({ makeStripe }));

let billingState: Record<string, any> = {};
vi.mock("@/lib/billing-state.server", () => ({
  getOrgBillingState: async () => billingState,
  subscriptionPeriodEnd: () => null,
}));

function addon(slug: string, extra: Row = {}): Row {
  return {
    id: `20000000-0000-4000-8000-${String(HELD_ADDON_SLUGS.indexOf(slug as any) + 10).padStart(12, "0")}`,
    slug,
    name: slug,
    description: null,
    price_cents: 9900,
    billing_interval: "month",
    // The worst case: an admin flipped every held row on.
    status: "active",
    is_active: true,
    stripe_product_id: `prod_${slug}`,
    stripe_price_id: `price_${slug}`,
    feature_flag: null,
    sort_order: 1,
    ...extra,
  };
}

function seed(planId: string) {
  tables = {
    platform_addons: [
      ...HELD_ADDON_SLUGS.map((s) => addon(s)),
      addon("priority-support", { id: "20000000-0000-4000-8000-000000000099" }),
      addon("developer-setup", {
        id: "20000000-0000-4000-8000-000000000098",
        billing_interval: "one_time",
        price_cents: 19900,
      }),
    ],
    platform_plans: [
      { id: LAUNCH, slug: "launch" },
      { id: GROWTH, slug: "growth" },
    ],
    organizations: [
      {
        id: ORG,
        stripe_subscription_id: "sub_live_1",
        stripe_customer_id: "cus_live_1",
        plan_status: "active",
        plan_id: planId,
      },
    ],
    org_platform_addons: [],
  };
}

beforeEach(() => {
  stripeTouches.length = 0;
  writes.length = 0;
  makeStripe.mockClear();
  stripeImpl = {};
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  seed(LAUNCH);
});

describe("the launch flag", () => {
  it("holds all five keys, and every one is off", () => {
    expect([...HELD_ADDON_SLUGS].sort()).toEqual(
      ["ai-receptionist", "managed-sms", "white-label", "white-label-emails", "white-label-portal"],
    );
    for (const slug of HELD_ADDON_SLUGS) expect(ADDON_LAUNCHED[slug], slug).toBe(false);
  });
});

describe("a held add-on is refused before any Stripe call", () => {
  for (const slug of HELD_ADDON_SLUGS) {
    it(`${slug}: refused, Stripe untouched, nothing written`, async () => {
      const { subscribePlatformAddon } = await import("@/lib/platform-addons.functions");
      const id = tables.platform_addons.find((a) => a.slug === slug)!.id;
      await expect(subscribePlatformAddon({ data: { addonId: id } } as any)).rejects.toThrow(
        "This add-on isn't available yet.",
      );
      expect(makeStripe).not.toHaveBeenCalled();
      expect(stripeTouches).toEqual([]);
      expect(writes).toEqual([]);
    });
  }

  it("shows each held add-on as coming soon on the billing page, whatever its row says", async () => {
    const { listPlatformAddons } = await import("@/lib/platform-addons.functions");
    const { addons } = await listPlatformAddons({} as any);
    for (const slug of HELD_ADDON_SLUGS) {
      expect(addons.find((a) => a.slug === slug)?.status, slug).toBe("coming_soon");
    }
    expect(addons.find((a) => a.slug === "priority-support")?.status).toBe("active");
  });
});

describe("priority support is sold on Launch only (NP-3)", () => {
  it("is refused on Growth, before any Stripe call", async () => {
    seed(GROWTH);
    const { subscribePlatformAddon } = await import("@/lib/platform-addons.functions");
    await expect(
      subscribePlatformAddon({ data: { addonId: "20000000-0000-4000-8000-000000000099" } } as any),
    ).rejects.toThrow(/included on your plan/);
    expect(makeStripe).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("reads as included, not for sale, on Growth's billing page", async () => {
    seed(GROWTH);
    const { listPlatformAddons } = await import("@/lib/platform-addons.functions");
    const { addons } = await listPlatformAddons({} as any);
    expect(addons.find((a) => a.slug === "priority-support")?.includedReason).toMatch(/included/);
    expect(addons.find((a) => a.slug === "developer-setup")?.includedReason).toBeNull();
  });

  it("goes through to Stripe on Launch", async () => {
    stripeImpl = {
      prices: { list: async () => ({ data: [], has_more: false }) },
      subscriptions: {
        retrieve: async () => ({ items: { data: [{ price: { recurring: { interval: "month" } } }] } }),
      },
      subscriptionItems: { create: async () => ({ id: "si_new" }) },
    };
    // The stored price is not in this (fake) account, so the purchase stops
    // with the lookup-key error — AFTER Stripe was asked. That is the point:
    // Launch is not refused by the plan check.
    const { subscribePlatformAddon } = await import("@/lib/platform-addons.functions");
    await subscribePlatformAddon({ data: { addonId: "20000000-0000-4000-8000-000000000099" } } as any).catch(
      () => undefined,
    );
    expect(makeStripe).toHaveBeenCalled();
    expect(stripeTouches).toContain("prices.list");
  });

  it("done-for-you setup is still sold on any plan", async () => {
    seed(GROWTH);
    stripeImpl = {
      prices: {
        list: async () => ({
          data: [{ id: "price_setup_test", lookup_key: "addon_developer_setup", unit_amount: 19900 }],
          has_more: false,
        }),
      },
      invoiceItems: { create: async () => ({ id: "ii_1" }) },
    };
    const { subscribePlatformAddon } = await import("@/lib/platform-addons.functions");
    const out = await subscribePlatformAddon({
      data: { addonId: "20000000-0000-4000-8000-000000000098" },
    } as any);
    expect(out).toEqual({ ok: true });
    expect(stripeTouches).toContain("invoiceItems.create");
  });
});

describe("a grandfathered add-on keeps its price across a yearly-to-monthly switch", () => {
  // An annual org with Priority support at the old $29, billed as 29 x 12 =
  // $348/yr. The catalog has since moved `addon_priority_support` to $99.
  function annualOrgWithOldPriority(catalogMonthlyAmount: number) {
    billingState = { stripeSubscriptionId: "sub_live_1", stripeCustomerId: "cus_live_1", orgName: "X" };
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_fake";
    tables.staff = [{ organization_id: ORG, active: true }];
    tables.platform_plans = [
      {
        id: LAUNCH, slug: "launch", name: "Launch", is_active: true, is_enterprise: false,
        stripe_price_id: "price_launch_m", stripe_annual_price_id: "price_launch_y",
        stripe_seat_price_id: "price_seat_m", stripe_annual_seat_price_id: "price_seat_y",
        price_cents: 7900, annual_price_cents: 79000, included_seats: 1, price_per_seat_cents: 1500,
      },
    ];
    tables.platform_addons = [
      {
        slug: "priority-support", stripe_product_id: "prod_priority",
        stripe_price_id: "price_priority_new", billing_interval: "month",
      },
    ];
    const updates: any[] = [];
    stripeImpl = {
      prices: {
        list: async () => ({
          data: [
            { id: "price_launch_m", lookup_key: "launch_base_monthly", unit_amount: 7900 },
            { id: "price_launch_y", lookup_key: "launch_base_annual", unit_amount: 79000 },
            { id: "price_priority_new", lookup_key: "addon_priority_support", unit_amount: catalogMonthlyAmount },
          ],
          has_more: false,
        }),
      },
      subscriptions: {
        retrieve: async () => ({
          id: "sub_live_1",
          status: "active",
          metadata: {},
          items: {
            data: [
              { id: "si_plan", price: { id: "price_launch_y", unit_amount: 79000, recurring: { interval: "year" } } },
              {
                id: "si_priority",
                quantity: 1,
                price: {
                  id: "price_inline_348",
                  unit_amount: 34800,
                  currency: "usd",
                  product: "prod_priority",
                  recurring: { interval: "year" },
                },
              },
            ],
          },
        }),
        update: async (_id: string, params: any) => {
          updates.push(params);
          return { id: "sub_live_1", latest_invoice: null };
        },
      },
    };
    return updates;
  }

  it("rebuilds the item at its own $29, not the catalog's $99", async () => {
    const updates = annualOrgWithOldPriority(9900);
    const { createPlanSubscription } = await import("@/lib/billing.functions");
    await createPlanSubscription({ data: { planId: LAUNCH, interval: "month" } } as any);
    const items = updates[0].items as any[];
    const added = items.filter((i) => !i.id && (i.price_data?.product === "prod_priority" || i.price === "price_priority_new"));
    expect(added).toHaveLength(1);
    expect(added[0].price).toBeUndefined();
    expect(added[0].price_data).toMatchObject({ unit_amount: 2900, recurring: { interval: "month" } });
  });

  it.each(HELD_ADDON_SLUGS)(
    "%s cannot get a replacement item through an interval change",
    async (slug) => {
      const updates = annualOrgWithOldPriority(9900);
      tables.platform_addons[0].slug = slug;
      const { createPlanSubscription } = await import("@/lib/billing.functions");
      await expect(
        createPlanSubscription({ data: { planId: LAUNCH, interval: "month" } }),
      ).rejects.toThrow("This add-on isn't available yet.");
      expect(updates).toEqual([]);
      expect(writes).toEqual([]);
      expect(stripeTouches).not.toContain("subscriptions.update");
      expect(stripeTouches).not.toContain("subscriptionItems.create");
    },
  );

  it("reuses the catalog price when it is the same amount", async () => {
    const updates = annualOrgWithOldPriority(2900);
    const { createPlanSubscription } = await import("@/lib/billing.functions");
    await createPlanSubscription({ data: { planId: LAUNCH, interval: "month" } } as any);
    const items = updates[0].items as any[];
    expect(items).toContainEqual({ price: "price_priority_new", quantity: 1 });
  });
});
