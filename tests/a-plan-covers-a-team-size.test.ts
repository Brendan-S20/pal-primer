// A plan covers a team size (spec NP-1, NP-10; owner decisions of Oct 9).
//
// Launch covers up to 3 enabled users, Growth up to 15, Scale has no cap, and
// every enabled user counts (`staff.active`). Three things follow, and each is
// run for real here with the framework, Supabase and Stripe faked:
//
//   1. Enabling or inviting a user past the cap is refused, with the spec's
//      own sentence, BEFORE the write.
//   2. A plan whose cap is below the account's enabled users cannot be chosen,
//      and the refusal comes before any Stripe call.
//   3. During a trial there is no chosen plan, so nothing is capped: the
//      tier function sizes the trial's plan by team size instead.
//
// The database backstop (staff_team_size_cap) was proved inside BEGIN …
// ROLLBACK against a local database; the last block here pins its shape.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addUserRefusal,
  capApplies,
  choosePlanRefusal,
  ordinal,
  smallestPlanFor,
  teamSizeRange,
} from "@/lib/team-size";

const ORG = "0f000000-0000-4000-8000-0000000000b1";
const STAFF_OFF = "30000000-0000-4000-8000-000000000009";
const PLANS = [
  { id: "10000000-0000-4000-8000-000000000001", name: "Launch", slug: "launch", included_seats: 1, max_team_size: 3, is_active: true, is_enterprise: false, price_cents: 7900, annual_price_cents: 79000, stripe_price_id: "price_l", price_per_seat_cents: 1500 },
  { id: "10000000-0000-4000-8000-000000000002", name: "Growth", slug: "growth", included_seats: 5, max_team_size: 15, is_active: true, is_enterprise: false, price_cents: 19900, annual_price_cents: 199000, stripe_price_id: "price_g", price_per_seat_cents: 1500 },
  { id: "10000000-0000-4000-8000-000000000003", name: "Scale", slug: "scale", included_seats: 20, max_team_size: null, is_active: true, is_enterprise: false, price_cents: 44900, annual_price_cents: 449000, stripe_price_id: "price_s", price_per_seat_cents: 1500 },
  { id: "10000000-0000-4000-8000-000000000004", name: "Enterprise", slug: "enterprise", included_seats: null, max_team_size: null, is_active: true, is_enterprise: true },
];
const [LAUNCH, GROWTH, SCALE] = PLANS;

describe("the ranges and the sentences", () => {
  it("says the ranges the owner decided", () => {
    expect(teamSizeRange(LAUNCH, PLANS)).toBe("1–3 people");
    expect(teamSizeRange(GROWTH, PLANS)).toBe("4–15 people");
    expect(teamSizeRange(SCALE, PLANS)).toBe("16+ people");
  });

  it("refuses a 4th on Launch in the spec's exact words", () => {
    expect(addUserRefusal(LAUNCH, 3, PLANS)).toBe(
      "Launch covers up to 3 people. To add a 4th, move to Growth.",
    );
    expect(addUserRefusal(LAUNCH, 2, PLANS)).toBeNull();
  });

  it("refuses a 16th on Growth, and nothing on Scale", () => {
    expect(addUserRefusal(GROWTH, 15, PLANS)).toBe(
      "Growth covers up to 15 people. To add a 16th, move to Scale.",
    );
    expect(addUserRefusal(SCALE, 500, PLANS)).toBeNull();
  });

  it("will not sell a plan smaller than the team, and never enforces a minimum", () => {
    expect(choosePlanRefusal(LAUNCH, 5, PLANS)).toBe(
      "Launch covers up to 3 people, and 5 are enabled on this account. Choose Growth, or turn some users off first.",
    );
    expect(choosePlanRefusal(LAUNCH, 3, PLANS)).toBeNull();
    // A one-person team may choose Scale.
    expect(choosePlanRefusal(SCALE, 1, PLANS)).toBeNull();
    expect(choosePlanRefusal(GROWTH, 1, PLANS)).toBeNull();
  });

  it("sizes a team to the smallest plan whose range holds it", () => {
    expect(smallestPlanFor(1, PLANS)?.slug).toBe("launch");
    expect(smallestPlanFor(3, PLANS)?.slug).toBe("launch");
    expect(smallestPlanFor(4, PLANS)?.slug).toBe("growth");
    expect(smallestPlanFor(15, PLANS)?.slug).toBe("growth");
    expect(smallestPlanFor(16, PLANS)?.slug).toBe("scale");
  });

  it("counts ordinals properly", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 16, 21, 22, 23, 101, 111].map(ordinal)).toEqual(
      ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "16th", "21st", "22nd", "23rd", "101st", "111th"],
    );
  });

  it("caps only a chosen plan: not a trial, not a comped account", () => {
    expect(capApplies({ billing_status: "active" })).toBe(true);
    expect(capApplies({ billing_status: "past_due" })).toBe(true);
    expect(capApplies({ plan_status: "trialing", billing_status: "free" })).toBe(false);
    expect(capApplies({ billing_status: "active", is_comped: true })).toBe(false);
    expect(capApplies({ plan_status: "canceled" })).toBe(false);
  });
});

// ── The server functions, run ────────────────────────────────────────────

type Row = Record<string, any>;
let tables: Record<string, Row[]> = {};
const writes: Array<{ table: string; op: string }> = [];
const rpcs: string[] = [];

function chain(table: string) {
  const filters: Array<[string, unknown]> = [];
  let op = "select";
  const rows = () => (tables[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
  const run = async () => {
    if (op !== "select") {
      writes.push({ table, op });
      return { data: op === "insert" ? [{ id: "new", token: "t" }] : null, error: null };
    }
    return { data: rows(), error: null, count: rows().length };
  };
  const api: any = {
    select: () => api,
    eq: (k: string, v: unknown) => (filters.push([k, v]), api),
    not: () => api,
    order: () => api,
    update: () => ((op = "update"), api),
    insert: () => ((op = "insert"), api),
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    single: async () => {
      if (op !== "select") {
        writes.push({ table, op });
        return { data: { id: "new", token: "t" }, error: null };
      }
      return { data: rows()[0] ?? null, error: rows()[0] ? null : { message: "no rows" } };
    },
    then: (res: any, rej: any) => run().then(res, rej),
  };
  return api;
}
const db = {
  from: (t: string) => chain(t),
  rpc: async (fn: string) => (rpcs.push(fn), { data: null, error: null }),
  auth: { getUser: async () => ({ data: { user: { email: "o@example.test" } } }) },
};

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
vi.mock("@/lib/seat-sync.server", () => ({ syncOrgSeatQuantity: async () => ({ skipped: "test" }) }));
const makeStripe = vi.fn(async () => {
  throw new Error("STRIPE REACHED");
});
vi.mock("@/lib/stripe-client.server", () => ({ makeStripe }));
vi.mock("@/lib/billing-state.server", () => ({
  getOrgBillingState: async () => ({ stripeSubscriptionId: null, stripeCustomerId: null, orgName: "X" }),
  subscriptionPeriodEnd: () => null,
}));

function seed(org: Row, activeStaff: number) {
  tables = {
    organizations: [{ id: ORG, plan_id: LAUNCH.id, is_comped: false, ...org }],
    platform_plans: PLANS,
    user_roles: [{ user_id: "owner-1", organization_id: ORG }],
    staff: [
      ...Array.from({ length: activeStaff }, (_, i) => ({ id: `30000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`, organization_id: ORG, active: true })),
      { id: STAFF_OFF, organization_id: ORG, active: false },
    ],
    org_invites: [],
  };
}

beforeEach(() => {
  writes.length = 0;
  rpcs.length = 0;
  makeStripe.mockClear();
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_fake";
});

describe("enabling a user", () => {
  it("refuses a 4th on a paid Launch account before the RPC runs", async () => {
    seed({ billing_status: "active", plan_status: "active" }, 3);
    const { setStaffActive } = await import("@/lib/users.functions");
    await expect(setStaffActive({ data: { staffId: STAFF_OFF, active: true } } as any)).rejects.toThrow(
      "Launch covers up to 3 people. To add a 4th, move to Growth.",
    );
    expect(rpcs).toEqual([]);
  });

  it("lets a 3rd in", async () => {
    seed({ billing_status: "active", plan_status: "active" }, 2);
    const { setStaffActive } = await import("@/lib/users.functions");
    await setStaffActive({ data: { staffId: STAFF_OFF, active: true } } as any);
    expect(rpcs).toEqual(["set_staff_active"]);
  });

  it("never refuses turning somebody off", async () => {
    seed({ billing_status: "active", plan_status: "active" }, 9);
    const { setStaffActive } = await import("@/lib/users.functions");
    await setStaffActive({ data: { staffId: "30000000-0000-4000-8000-000000000100", active: false } } as any);
    expect(rpcs).toEqual(["set_staff_active"]);
  });

  it("does not cap a trial", async () => {
    seed({ billing_status: "free", plan_status: "trialing" }, 3);
    const { setStaffActive } = await import("@/lib/users.functions");
    await setStaffActive({ data: { staffId: STAFF_OFF, active: true } } as any);
    expect(rpcs).toEqual(["set_staff_active"]);
  });
});

describe("inviting a user", () => {
  it("refuses an invite on a full paid Launch account, writing nothing", async () => {
    seed({ billing_status: "active", plan_status: "active" }, 3);
    const { createOrgInvite } = await import("@/lib/users.functions");
    await expect(
      createOrgInvite({ data: { email: "fourth@example.test", role: "tech" } } as any),
    ).rejects.toThrow("Launch covers up to 3 people. To add a 4th, move to Growth.");
    expect(writes).toEqual([]);
  });

  it("refuses a 16th on Growth", async () => {
    seed({ billing_status: "active", plan_status: "active", plan_id: GROWTH.id }, 15);
    const { createOrgInvite } = await import("@/lib/users.functions");
    await expect(
      createOrgInvite({ data: { email: "sixteenth@example.test", role: "tech" } } as any),
    ).rejects.toThrow("Growth covers up to 15 people. To add a 16th, move to Scale.");
  });
});

describe("choosing a plan", () => {
  it("refuses Launch for five enabled users, before any Stripe call", async () => {
    seed({ billing_status: "free", plan_status: "trialing" }, 5);
    const { createPlanSubscription } = await import("@/lib/billing.functions");
    await expect(
      createPlanSubscription({ data: { planId: LAUNCH.id, interval: "month" } } as any),
    ).rejects.toThrow("Launch covers up to 3 people, and 5 are enabled on this account. Choose Growth");
    expect(makeStripe).not.toHaveBeenCalled();
  });

  it("lets five people choose Growth or Scale (it reaches Stripe)", async () => {
    seed({ billing_status: "free", plan_status: "trialing" }, 5);
    const { createPlanSubscription } = await import("@/lib/billing.functions");
    for (const plan of [GROWTH, SCALE]) {
      makeStripe.mockClear();
      await expect(
        createPlanSubscription({ data: { planId: plan.id, interval: "year" } } as any),
      ).rejects.toThrow("STRIPE REACHED");
      expect(makeStripe).toHaveBeenCalledTimes(1);
    }
  });

  it("tells the picker how many users are enabled", async () => {
    seed({ billing_status: "free", plan_status: "trialing" }, 4);
    const { listPlatformPlans } = await import("@/lib/billing.functions");
    const out = (await listPlatformPlans({} as any)) as any;
    expect(out.enabledUsers).toBe(4);
  });
});

describe("the database backstop", () => {
  const SQL = readFileSync(
    join(import.meta.dirname, "..", "supabase/migrations/20261009160000_a-plan-covers-a-team-size.sql"),
    "utf8",
  ).replace(/--[^\n]*/g, "");

  it("fires on every way a user becomes enabled", () => {
    expect(SQL).toMatch(
      /CREATE TRIGGER staff_team_size_cap\s+BEFORE INSERT OR UPDATE OF active ON public\.staff\s+FOR EACH ROW\s+WHEN \(NEW\.active IS TRUE\)/,
    );
  });

  it("says the same sentence as the server", () => {
    expect(SQL).toMatch(/'%s covers up to %s people\. To add a %s, %s\.'/);
    expect(SQL).toMatch(/'move to ' \|\| _next/);
  });

  it("caps only a chosen, paid, uncomped plan", () => {
    expect(SQL).toMatch(/IF _max IS NULL OR _comped IS TRUE THEN RETURN NEW;/);
    expect(SQL).toMatch(/_billing IN \('active', 'past_due', 'grace'\)/);
  });

  it("is not callable by a client role", () => {
    expect(SQL).toMatch(/REVOKE ALL ON FUNCTION public\.enforce_team_size_cap\(\) FROM PUBLIC, anon, authenticated;/);
  });
});
