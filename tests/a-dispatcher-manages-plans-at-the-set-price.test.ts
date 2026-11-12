// A dispatcher manages an existing client's plans at the set price (#728).
//
// Owner decision, 2026-11-10 2:24 PM ET, verbatim: "Yes, dispatchers can
// manage plans at the set price". Acceptance: as a dispatcher, add, pause,
// resume and end a plan on an existing client; a price edit or an override
// sent straight to the server is refused with a plain message; tenant
// isolation holds; every plan change records who made it and when.
//
// The handlers run here against fakes (nothing reaches a real Supabase). Each
// write is recorded with the client it came through, so a test can say WHICH
// key wrote a row: the dispatcher's own (RLS decides) or the service role
// (the server decided, after checking the business itself).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasPermission } from "@/lib/permissions";

// The SQL proof below waits its turn for the shared proof lock
// (tests/the-proofs-take-turns.test.ts).
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

const USER = "the dispatcher's own key";
const ADMIN = "the service role";

type Write = {
  db: string;
  table: string;
  op: "insert" | "update" | "delete";
  row: any;
  filters: Record<string, unknown>;
};

const state = vi.hoisted(() => ({
  role: "dispatcher" as string,
  orgId: "org-1",
  writes: [] as Array<{
    db: string;
    table: string;
    op: "insert" | "update" | "delete";
    row: any;
    filters: Record<string, unknown>;
  }>,
  activity: [] as any[],
  // The rows as each business holds them.
  client: { id: "", organization_id: "org-1", account_type: "residential" },
  property: {
    id: "",
    organization_id: "org-1",
    client_id: "",
    postal_code: "48201",
    latitude: 42.3,
    longitude: -83.0,
    boundary_area_sqm: null as number | null,
  },
  sub: {
    id: "",
    organization_id: "org-1",
    client_id: "",
    property_id: "",
    status: "active",
    started_on: "2026-01-05",
    ends_on: null as string | null,
    frequency: "weekly",
  },
  quote: { available: true, quote: { recurringPriceCents: 4000, zoneId: "" } } as any,
}));

const CLIENT = "11111111-1111-4111-8111-111111111111";
const PROPERTY = "22222222-2222-4222-8222-222222222222";
const SUB = "33333333-3333-4333-8333-333333333333";
const ZONE = "44444444-4444-4444-8444-444444444444";
const OTHER_ZONE = "55555555-5555-4555-8555-555555555555";

/** A chainable stand-in for the Supabase query builder. */
function fakeDb(tag: string): any {
  const from = (table: string) => {
    let op: Write["op"] | null = null;
    let payload: any = null;
    let head = false;
    let returning = false;
    const filters: Record<string, unknown> = {};
    const fixture = (): any =>
      table === "clients"
        ? state.client
        : table === "properties"
          ? state.property
          : table === "subscriptions"
            ? state.sub
            : table === "organizations"
              ? { timezone: "America/Detroit" }
              : null;
    // A row is visible when every filter the query named matches it.
    const visible = () => {
      const row = fixture();
      if (!row) return null;
      for (const [k, v] of Object.entries(filters)) if (k in row && row[k] !== v) return null;
      return row;
    };
    const record = () =>
      state.writes.push({ db: tag, table, op: op!, row: payload, filters: { ...filters } });
    const q: any = {
      select: (_cols?: string, opts?: { head?: boolean }) => {
        if (op) returning = true;
        if (opts?.head) head = true;
        return q;
      },
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return q;
      },
      neq: () => q,
      gt: () => q,
      gte: () => q,
      in: () => q,
      order: () => q,
      limit: () => q,
      insert: (row: any) => {
        op = "insert";
        payload = row;
        return q;
      },
      update: (row: any) => {
        op = "update";
        payload = row;
        return q;
      },
      delete: () => {
        op = "delete";
        return q;
      },
      single: async () => {
        if (op === "insert") {
          record();
          return { data: { id: "new-plan" }, error: null };
        }
        const row = visible();
        return row
          ? { data: row, error: null }
          : { data: null, error: { message: "Cannot coerce the result to a single JSON object" } };
      },
      maybeSingle: async () => ({ data: visible(), error: null }),
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
        try {
          if (op) {
            const matched = op === "update" && table === "subscriptions" ? visible() : true;
            if (matched) record();
            resolve({
              data: returning ? (matched ? [{ id: state.sub.id }] : []) : null,
              error: null,
            });
          } else resolve(head ? { count: 0, data: null, error: null } : { data: [], error: null });
        } catch (e) {
          reject?.(e);
        }
      },
    };
    return q;
  };
  return { tag, from, rpc: async () => ({ data: null, error: null }) };
}

const USER_DB = fakeDb(USER);
const ADMIN_DB = fakeDb(ADMIN);

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (data: unknown) => unknown = (data) => data;
    const builder = {
      middleware: () => builder,
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return builder;
      },
      handler:
        (fn: (args: { data: unknown; context: unknown }) => unknown) =>
        async (args?: { data: unknown }) =>
          fn({ data: validate(args?.data), context: { supabase: USER_DB, userId: "user-1" } }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: ADMIN_DB }));
vi.mock("@/lib/authz.server", async () => {
  const { hasPermission: can } = await import("@/lib/permissions");
  return {
    resolveCaller: async () => ({ orgId: state.orgId, role: state.role }),
    requirePermission: async (_db: unknown, _user: string, permission: any) => {
      if (!can(state.role as any, permission)) throw new Error("Not authorized");
      return { orgId: state.orgId, role: state.role };
    },
  };
});
vi.mock("@/lib/internal-quote.server", () => ({ internalQuote: async () => state.quote }));
vi.mock("@/lib/estimate.server", () => ({ recomputePropertyEstimate: async () => {} }));
vi.mock("@/lib/visit-generation.server", () => ({ generateVisitHorizon: async () => 0 }));
vi.mock("@/lib/walk-notify.server", () => ({ notifyWalkPlanChanged: async () => {} }));
vi.mock("@/lib/activity.server", () => ({
  logActivity: async (_db: unknown, entry: unknown) => {
    state.activity.push(entry);
  },
}));
vi.mock("@/lib/org-day", () => ({
  orgToday: () => "2026-11-11",
  DEFAULT_ORG_TIMEZONE: "America/Detroit",
}));

const {
  createSubscription,
  updateSubscription,
  pauseSubscription,
  resumeSubscription,
  endSubscription,
  deleteDraftSubscription,
  getPlanSetPrice,
} = await import("@/lib/subscriptions.functions");
const {
  PLAN_CADENCE_IS_BILLING,
  PLAN_EDIT_IS_PRICING,
  PLAN_DELETE_IS_PRICING,
  NO_PLAN_SET_PRICE_SCHEDULE,
  updatePlanLifecycleAsServer,
} = await import("@/lib/plan-set-price.server");

const OVERRIDE_REFUSED =
  "Only someone who sets prices can change this price. The set price is $40.00.";

const newPlan = (over: Record<string, unknown> = {}) =>
  createSubscription({
    data: {
      clientId: CLIENT,
      propertyId: PROPERTY,
      accountType: "residential",
      frequency: "weekly",
      priceCents: 4000,
      dogCount: 2,
      zoneId: ZONE,
      billingCadence: "postpaid",
      startedOn: "2026-11-12",
      ...over,
    } as any,
  });

const subscriptionWrites = (op?: Write["op"]) =>
  state.writes.filter((w: Write) => w.table === "subscriptions" && (!op || w.op === op));

beforeEach(() => {
  state.role = "dispatcher";
  state.orgId = "org-1";
  state.writes.length = 0;
  state.activity.length = 0;
  state.client = { id: CLIENT, organization_id: "org-1", account_type: "residential" };
  state.property = {
    id: PROPERTY,
    organization_id: "org-1",
    client_id: CLIENT,
    postal_code: "48201",
    latitude: 42.3,
    longitude: -83.0,
    boundary_area_sqm: null,
  };
  state.sub = {
    id: SUB,
    organization_id: "org-1",
    client_id: CLIENT,
    property_id: PROPERTY,
    status: "active",
    started_on: "2026-01-05",
    ends_on: null,
    frequency: "weekly",
  };
  state.quote = { available: true, quote: { recurringPriceCents: 4000, zoneId: ZONE } };
});

// ── The matrix ─────────────────────────────────────────────────────────────

describe("manage_plans", () => {
  it("is the dispatcher's, and the owner's and office manager's with everything else", () => {
    expect(hasPermission("dispatcher", "manage_plans")).toBe(true);
    expect(hasPermission("office_manager", "manage_plans")).toBe(true);
    expect(hasPermission("owner", "manage_plans")).toBe(true);
    expect(hasPermission("tech", "manage_plans")).toBe(false);
  });

  it("gives a dispatcher no price, money, settings or access permission", () => {
    for (const p of [
      "manage_pricing",
      "manage_client_billing",
      "manage_org_billing",
      "manage_settings",
      "manage_users",
      "view_financials",
    ] as const)
      expect(hasPermission("dispatcher", p), p).toBe(false);
  });
});

// ── Add ────────────────────────────────────────────────────────────────────

describe("a dispatcher adds a plan to an existing client", () => {
  it("at the set price, written by the server, stamped with who and when", async () => {
    const before = Date.now();
    await expect(newPlan()).resolves.toEqual({ id: "new-plan" });
    const [w] = subscriptionWrites("insert");
    expect(w.db).toBe(ADMIN);
    expect(w.row).toMatchObject({
      organization_id: "org-1",
      client_id: CLIENT,
      property_id: PROPERTY,
      price_cents: 4000,
      zone_id: ZONE,
      priced_from_zone_id: ZONE,
      billing_cadence: "postpaid",
      dog_count: 2,
      created_by: "user-1",
      last_changed_by: "user-1",
    });
    expect(Date.parse(w.row.last_changed_at)).toBeGreaterThanOrEqual(before - 1000);
    expect(w.row).not.toHaveProperty("price_overridden_at");
    expect(state.activity[0]).toMatchObject({ kind: "service.created", actorUserId: "user-1" });
  });

  it("every 2 weeks is the biweekly set price", async () => {
    await newPlan({ intervalWeeks: 2 });
    expect(subscriptionWrites("insert")[0].row).toMatchObject({ interval_weeks: 2 });
  });

  it("shows the same set price the server will accept", async () => {
    await expect(
      getPlanSetPrice({
        data: { clientId: CLIENT, propertyId: PROPERTY, frequency: "weekly", dogCount: 2 },
      }),
    ).resolves.toMatchObject({ cents: 4000, zoneId: ZONE, reason: null });
  });

  it("a schedule with no set price is refused in words, before anything is written", async () => {
    await expect(newPlan({ frequency: "every_n_days", intervalDays: 10 })).rejects.toThrow(
      NO_PLAN_SET_PRICE_SCHEDULE,
    );
    expect(subscriptionWrites()).toEqual([]);
  });
});

// ── A price sent straight to the server ────────────────────────────────────

describe("a price edit or override sent straight to the server", () => {
  it("a typed price on a new plan is refused with a plain message, nothing written", async () => {
    await expect(newPlan({ priceCents: 3000 })).rejects.toThrow(OVERRIDE_REFUSED);
    await expect(newPlan({ priceCents: 0 })).rejects.toThrow(OVERRIDE_REFUSED);
    expect(subscriptionWrites()).toEqual([]);
  });

  it("another zone's price is refused too", async () => {
    await expect(newPlan({ zoneId: OTHER_ZONE })).rejects.toThrow(OVERRIDE_REFUSED);
    expect(subscriptionWrites()).toEqual([]);
  });

  it("billing in advance is billing, and refused", async () => {
    await expect(newPlan({ billingCadence: "prepaid" })).rejects.toThrow(PLAN_CADENCE_IS_BILLING);
    expect(subscriptionWrites()).toEqual([]);
  });

  it("editing an existing plan's price is refused with a plain message", async () => {
    await expect(
      updateSubscription({
        data: {
          subscriptionId: SUB,
          propertyId: PROPERTY,
          frequency: "weekly",
          priceCents: 1000,
        } as any,
      }),
    ).rejects.toThrow(PLAN_EDIT_IS_PRICING);
    expect(subscriptionWrites()).toEqual([]);
  });

  it("deleting a plan is refused; ending it is the way", async () => {
    await expect(deleteDraftSubscription({ data: { subscriptionId: SUB } })).rejects.toThrow(
      PLAN_DELETE_IS_PRICING,
    );
    expect(state.writes).toEqual([]);
  });

  it("the server's lifecycle writer takes no price column, whoever asks", async () => {
    const { error } = await updatePlanLifecycleAsServer("org-1", SUB, { price_cents: 1 });
    expect(error?.message).toBe("A plan change may not write price_cents");
    expect(state.writes).toEqual([]);
  });

  it("the plain messages say what to do, in words", () => {
    expect(PLAN_EDIT_IS_PRICING).toMatch(/^Only someone who sets prices/);
    expect(PLAN_DELETE_IS_PRICING).toMatch(/End it instead/);
  });
});

// ── Pause, resume, end ─────────────────────────────────────────────────────

describe("a dispatcher pauses, resumes and ends a plan", () => {
  it("pauses an active plan, through the server, in their business only, with who and when", async () => {
    await pauseSubscription({ data: { subscriptionId: SUB } });
    const [w] = subscriptionWrites("update");
    expect(w.db).toBe(ADMIN);
    expect(w.filters).toEqual({ id: SUB, organization_id: "org-1", status: "active" });
    expect(w.row).toMatchObject({ status: "paused", last_changed_by: "user-1" });
    expect(typeof w.row.paused_at).toBe("string");
    expect(typeof w.row.last_changed_at).toBe("string");
    expect(w.row).not.toHaveProperty("price_cents");
    // Upcoming visits come off with the dispatcher's own key: RLS decides.
    const visitDelete = state.writes.find((x: Write) => x.table === "visits");
    expect(visitDelete?.db).toBe(USER);
    expect(state.activity[0]).toMatchObject({ kind: "service.paused", actorUserId: "user-1" });
  });

  it("resumes a paused plan", async () => {
    state.sub.status = "paused";
    await resumeSubscription({ data: { subscriptionId: SUB } });
    const [w] = subscriptionWrites("update");
    expect(w.db).toBe(ADMIN);
    expect(w.filters).toMatchObject({ organization_id: "org-1", status: "paused" });
    expect(w.row).toMatchObject({ status: "active", paused_at: null, last_changed_by: "user-1" });
    expect(state.activity[0]).toMatchObject({ kind: "service.resumed" });
  });

  it("ends a plan, recording who ended it", async () => {
    await endSubscription({
      data: { subscriptionId: SUB, effectiveDate: "2099-01-31", reason: "Moved away" },
    });
    const [w] = subscriptionWrites("update");
    expect(w.db).toBe(ADMIN);
    expect(w.filters).toMatchObject({ id: SUB, organization_id: "org-1" });
    expect(w.row).toMatchObject({
      ends_on: "2099-01-31",
      end_reason: "Moved away",
      ended_by: "user-1",
      last_changed_by: "user-1",
    });
    expect(state.activity[0]).toMatchObject({ kind: "service.ended", actorUserId: "user-1" });
  });

  it("refuses a plan that moved underneath them rather than writing over it", async () => {
    state.sub.status = "paused";
    await expect(pauseSubscription({ data: { subscriptionId: SUB } })).rejects.toThrow(
      "Only an active service can be paused",
    );
    expect(subscriptionWrites()).toEqual([]);
  });
});

// ── Tenant isolation ───────────────────────────────────────────────────────

describe("another business", () => {
  it("another business's client gets no plan", async () => {
    state.client.organization_id = "org-2";
    await expect(newPlan()).rejects.toThrow("That client was not found.");
    expect(subscriptionWrites()).toEqual([]);
  });

  it("a property that is not this client's gets no plan", async () => {
    state.property.client_id = "someone-else";
    await expect(newPlan()).rejects.toThrow("That property is not this client's.");
    expect(subscriptionWrites()).toEqual([]);
  });

  it("another business's plan is not found, so nothing is paused, resumed or ended", async () => {
    state.sub.organization_id = "org-2";
    await expect(pauseSubscription({ data: { subscriptionId: SUB } })).rejects.toThrow();
    state.sub.status = "paused";
    await expect(resumeSubscription({ data: { subscriptionId: SUB } })).rejects.toThrow();
    await expect(
      endSubscription({
        data: { subscriptionId: SUB, effectiveDate: "2099-01-31", reason: "x" },
      }),
    ).rejects.toThrow();
    expect(subscriptionWrites()).toEqual([]);
  });

  it("the server's writer is filtered on the caller's business: another's plan matches nothing", async () => {
    state.sub.organization_id = "org-2";
    const { error } = await updatePlanLifecycleAsServer("org-1", SUB, { status: "paused" });
    expect(error?.message).toMatch(/not found/);
    expect(subscriptionWrites()).toEqual([]);
  });
});

// ── Everyone else keeps what they had ──────────────────────────────────────

describe("owners and office managers", () => {
  for (const role of ["owner", "office_manager"]) {
    it(`${role}: still types any price, with their own key, and is recorded as the author`, async () => {
      state.role = role;
      await newPlan({ priceCents: 3000, billingCadence: "prepaid" });
      const [w] = subscriptionWrites("insert");
      expect(w.db).toBe(USER);
      expect(w.row[0]).toMatchObject({
        price_cents: 3000,
        billing_cadence: "prepaid",
        created_by: "user-1",
        last_changed_by: "user-1",
      });
    });

    it(`${role}: pauses with their own key, stamped`, async () => {
      state.role = role;
      await pauseSubscription({ data: { subscriptionId: SUB } });
      const [w] = subscriptionWrites("update");
      expect(w.db).toBe(USER);
      expect(w.row).toMatchObject({ status: "paused", last_changed_by: "user-1" });
    });
  }

  it("a technician manages no plan", async () => {
    state.role = "tech";
    await expect(newPlan()).rejects.toThrow("Not authorized");
    await expect(pauseSubscription({ data: { subscriptionId: SUB } })).rejects.toThrow(
      "Not authorized",
    );
    expect(state.writes).toEqual([]);
  });
});

// ── The screen and the migration ───────────────────────────────────────────

describe("the Services tab and the migration", () => {
  const tab = read("src/components/client-detail/ServicesTab.tsx");
  const drawer = read("src/components/client-detail/PlanAtSetPriceDrawer.tsx");

  it("offers Add, Pause, Resume and End on manage_plans, and keeps Edit and Delete on pricing", () => {
    expect(tab).toMatch(/canManagePricing \|\| can\("manage_plans"\)/);
    expect(tab).toMatch(/\{canManagePlans && !ended && s\.status === "active" && \(/);
    expect(tab).toMatch(/\{canManagePlans && paused && \(/);
    expect(tab).toMatch(/\{canManagePlans && showEnd && \(/);
    expect(tab).toMatch(/properties\.length > 0 && canManagePlans && \(/);
    expect(tab).toMatch(
      /\{canManagePricing && \(\s*<Button size="sm" variant="outline" onClick=\{\(\) => openEditViaUrl/,
    );
    expect(tab).toMatch(/\{canManagePricing && showDelete && \(/);
  });

  it("the dispatcher's Add plan form has no price box: the price is shown, not typed", () => {
    expect(drawer).not.toMatch(/priceDollars|id="psp-price"/);
    expect(drawer).toMatch(/getPlanSetPrice/);
    expect(drawer).toMatch(/billingCadence: "postpaid"/);
  });

  it("the migration is the newest file, adds the audit columns and grants manage_plans", () => {
    const files = readdirSync(join(ROOT, "supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const file = "20261112020000_a-dispatcher-manages-plans-at-the-set-price.sql";
    expect(files).toContain(file);
    // After #905's 20261112010000, and the newest file in the folder.
    expect(file.slice(0, 14) > "20261112010000").toBe(true);
    expect(files.filter((f) => f > file)).toEqual([]);
    const sql = read(`supabase/migrations/${file}`);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS created_by uuid/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS last_changed_by uuid/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS last_changed_at timestamptz/);
    expect(sql).toMatch(/'dispatcher' AND _permission IN \([^)]*'manage_plans'\)/);
    // No policy is created, dropped or altered: the plan write policies stay
    // manage_pricing, so a dispatcher's own key still cannot write a price.
    expect(sql).not.toMatch(/\b(CREATE|DROP|ALTER) POLICY\b/i);
    // If #905 (per-business role permissions, #863) lands first, this file's
    // has_permission would undo its overrides on every replay. It refuses to
    // run instead, so whichever PR merges second reconciles the two.
    expect(sql).toMatch(/to_regclass\('public\.role_permission_overrides'\) IS NOT NULL/);
  });
});

// ── In a real database ─────────────────────────────────────────────────────
// Runs against the local stack when one answers; skipped, and said so, when
// none does. One transaction, rolled back: nothing is left behind.

const MIGRATION = join(
  ROOT,
  "supabase/migrations/20261112020000_a-dispatcher-manages-plans-at-the-set-price.sql",
);
const PROOF = join(ROOT, "tests/sql/a-dispatcher-manages-plans-at-the-set-price.proof.sql");
const DB_URL =
  process.env.WEBHOOKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

function findPsql(): string | null {
  for (const p of [
    "psql",
    "/opt/homebrew/opt/libpq/bin/psql",
    "/opt/homebrew/opt/postgresql@18/bin/psql",
    "/opt/homebrew/opt/postgresql@17/bin/psql",
    "/usr/local/opt/libpq/bin/psql",
  ]) {
    const r = spawnSync(p, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return p;
  }
  return null;
}

const psql = findPsql();
const reachable =
  !!psql &&
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], {
    encoding: "utf8",
    timeout: 5_000,
  }).stdout?.trim() === "1";

if (!reachable) {
  console.warn(
    `\n  SKIPPED: the plan-management proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set WEBHOOKS_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("a dispatcher's plans, in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("grants manage_plans in one business, keeps the policy, and records who and when", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
      encoding: "utf8",
      timeout: 300_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(4);
    expect(out).toMatch(/ALL PLAN-MANAGEMENT PROOFS PASSED/);
  });
});
