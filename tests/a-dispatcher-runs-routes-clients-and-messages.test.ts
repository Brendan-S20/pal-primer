// A dispatcher runs routes, clients and messages (#728).
//
// Owner decision, 2026-11-08, verbatim: "dispatcher role with its own
// permissions for routes, clients and messaging". #636 (#616) let a dispatcher
// book a one-off and a groom at the set price. Three things were still
// refused to the front desk, each by a gate that asked for something else:
//
//   * the new-client wizard's Plan step: the subscriptions write policy is
//     manage_pricing, so the dispatcher's own key could not write the plan;
//   * Move to another day in both visit drawers: rescheduleVisitFromOffice
//     shared Complete's and Cancel's loader, which asks manage_client_billing;
//   * texting a client asked view_client_directory, a READ.
//
// This file pins the fix from three sides. The handlers run here against fakes
// (nothing reaches a real Supabase): what a dispatcher may now do, at the set
// price only, and every refusal around it. The SQL proof runs against the local
// stack when one answers: the grants, the policy that still refuses a typed
// plan price, and the tenant line. The static checks pin the screens and the
// help text to what the server allows.

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasPermission, type Permission } from "@/lib/permissions";

vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

const USER_DB_TAG = "the signed-in user's client";
const ADMIN_DB_TAG = "the service role";

type Insert = { db: string; table: string; row: any };

const state = vi.hoisted(() => ({
  role: "dispatcher" as string,
  orgId: "org-1",
  // Which business the client and property the request just wrote belong
  // to, as the service role reads them back before writing the plan.
  writtenInOrg: "org-1",
  inserts: [] as Array<{ db: string; table: string; row: any }>,
  rpcs: [] as Array<{ db: string; fn: string; args: any }>,
  set: { cents: 4000, zoneId: "zone-1", reason: null } as
    | { cents: number; zoneId: string | null; reason: null }
    | { cents: null; zoneId: null; reason: string },
  visit: {
    id: "visit-1",
    organization_id: "org-1",
    client_id: "client-1",
    property_id: "prop-1",
    scheduled_on: "2099-03-02",
    status: "scheduled",
    updated_at: null as string | null,
  },
}));

/** A chainable stand-in for the Supabase query builder. Every insert is
 *  recorded with the client it came through, so a test can say WHICH key
 *  wrote a row; a read answers from the fixture above. */
function fakeDb(tag: string): any {
  const builder = (table: string) => {
    let pendingInsert: any = null;
    const q: any = {
      select: () => q,
      eq: () => q,
      neq: () => q,
      in: () => q,
      not: () => q,
      order: () => q,
      limit: () => q,
      insert: (row: any) => {
        pendingInsert = row;
        state.inserts.push({ db: tag, table, row });
        return q;
      },
      update: () => q,
      delete: () => q,
      single: async () => {
        if (pendingInsert)
          return { data: { id: `${table}-new`, portal_token: "tok" }, error: null };
        if (table === "visits") return { data: state.visit, error: null };
        return { data: null, error: null };
      },
      maybeSingle: async () => {
        if (table === "organizations")
          return { data: { timezone: "America/Chicago" }, error: null };
        if (table === "clients")
          return { data: { id: "clients-new", organization_id: state.writtenInOrg }, error: null };
        if (table === "properties")
          return {
            data: {
              id: "properties-new",
              organization_id: state.writtenInOrg,
              client_id: "clients-new",
            },
            error: null,
          };
        if (table === "visits")
          return { data: { ...state.visit, assigned_staff_id: null }, error: null };
        return { data: null, error: null };
      },
      then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
    };
    return q;
  };
  return {
    tag,
    from: builder,
    rpc: async (fn: string, args: any) => {
      state.rpcs.push({ db: tag, fn, args });
      return { data: null, error: null };
    },
  };
}

const USER_DB = fakeDb(USER_DB_TAG);
const ADMIN_DB = fakeDb(ADMIN_DB_TAG);

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
vi.mock("@/lib/plan-set-price.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/plan-set-price.server")>();
  return { ...real, planSetPriceCents: vi.fn(async () => state.set) };
});
// Side effects around the writes that this file is not about.
vi.mock("@/lib/properties.functions", () => ({ detectZoneId: async () => null }));
vi.mock("@/lib/visit-generation.server", () => ({ generateVisitHorizon: async () => 0 }));
vi.mock("@/lib/activity.server", () => ({ logActivity: async () => {} }));
vi.mock("@/lib/booking-dates.server", () => ({
  refusePastDay: async () => {},
  orgTodayFor: async () => "2000-01-01",
}));
vi.mock("@/lib/groom-clash.server", () => ({
  refuseGroomMoveClash: async () => {},
  groomWriteError: async (_db: unknown, e: { message: string }) => new Error(e.message),
}));
vi.mock("@/lib/field-notify.server", () => ({
  startRouteWatch: async () => ({ finish: async () => {} }),
}));
vi.mock("@/lib/push-liveactivity.server", () => ({
  watchRouteLiveActivities: async () => async () => {},
}));
vi.mock("@/lib/walk-notify.server", () => ({
  watchWalkSchedule: async () => ({ finish: async () => {} }),
  notifyWalksCanceled: async () => {},
}));
vi.mock("@/lib/overnight-clashes.server", () => ({ overnightClashWarning: async () => null }));
vi.mock("@/lib/training-packages.server", () => ({ lessonClashesAfterMove: async () => [] }));
vi.mock("@/lib/training-portal.server", () => ({ afterLessonSessionChange: async () => {} }));

const { onboardClient } = await import("@/lib/clients.functions");
const { rescheduleVisitFromOffice, completeVisitFromOffice, cancelVisitFromOffice } =
  await import("@/lib/visits.functions");
const { sendSmsToClient } = await import("@/lib/messages.functions");
const { PLAN_CADENCE_IS_BILLING, NO_PLAN_SET_PRICE_ZONE } =
  await import("@/lib/plan-set-price.server");

const subscriptionInserts = () => state.inserts.filter((i: Insert) => i.table === "subscriptions");
const clientInserts = () => state.inserts.filter((i: Insert) => i.table === "clients");

const newClient = (subscription: Record<string, unknown> | undefined) =>
  (onboardClient as any)({
    data: {
      displayName: "Rivera household",
      accountType: "residential",
      street: "1 Oak St",
      city: "Springfield",
      region: "IL",
      postalCode: "60614",
      ...(subscription
        ? {
            subscription: {
              frequency: "weekly",
              priceCents: 4000,
              dogCount: 2,
              startedOn: "2099-03-02",
              ...subscription,
            },
          }
        : {}),
    },
  });

beforeEach(() => {
  state.role = "dispatcher";
  state.orgId = "org-1";
  state.writtenInOrg = "org-1";
  state.inserts.length = 0;
  state.rpcs.length = 0;
  state.set = { cents: 4000, zoneId: "zone-1", reason: null };
  state.visit = { ...state.visit, status: "scheduled", organization_id: "org-1" };
});

// ── The matrix ─────────────────────────────────────────────────────────────

describe("the dispatcher's own permissions", () => {
  it("routes, clients and messaging: booking, manage_schedule, message_clients", () => {
    for (const p of ["booking", "manage_schedule", "message_clients", "view_client_directory"]) {
      expect(hasPermission("dispatcher", p as Permission), p).toBe(true);
      expect(hasPermission("owner", p as Permission), p).toBe(true);
      expect(hasPermission("office_manager", p as Permission), p).toBe(true);
    }
  });

  it("not the owner's billing, security or access administration, and no price", () => {
    for (const p of [
      "manage_pricing",
      "manage_client_billing",
      "view_financials",
      "manage_org_billing",
      "manage_users",
      "manage_settings",
      "reveal_signin_code",
      "send_campaigns",
      "manage_imports",
      "manage_franchise",
    ]) {
      expect(hasPermission("dispatcher", p as Permission), p).toBe(false);
    }
  });

  it("a technician gains none of it", () => {
    for (const p of ["booking", "manage_schedule", "message_clients"]) {
      expect(hasPermission("tech", p as Permission), p).toBe(false);
    }
  });
});

// ── Clients: a plan at the set price ───────────────────────────────────────

describe("a dispatcher's new client with a plan (gaps-r2-02)", () => {
  it("starts the plan at the set price, written past the pricing policy by the server", async () => {
    await newClient({});
    const [sub] = subscriptionInserts();
    expect(sub.db).toBe(ADMIN_DB_TAG);
    expect(sub.row).toMatchObject({
      organization_id: "org-1",
      price_cents: 4000,
      zone_id: "zone-1",
      billing_cadence: "postpaid",
    });
    // The household itself is written with the dispatcher's own key, so RLS
    // still decides which business it lands in.
    expect(clientInserts()[0].db).toBe(USER_DB_TAG);
  });

  it("the service role writes no plan onto a client that is not the caller's business's", async () => {
    state.writtenInOrg = "org-2";
    await expect(newClient({})).rejects.toThrow("That client is not in your organization");
    expect(subscriptionInserts()).toEqual([]);
  });

  it("is refused a price that is not the set price, before anything is written", async () => {
    await expect(newClient({ priceCents: 100 })).rejects.toThrow(
      "Only someone who sets prices can change this price. The set price is $40.00.",
    );
    await expect(newClient({ priceCents: 0 })).rejects.toThrow("The set price is $40.00");
    expect(state.inserts).toEqual([]);
  });

  it("is refused a zone that is not the quote's", async () => {
    await expect(newClient({ zoneId: "99999999-9999-4999-8999-999999999999" })).rejects.toThrow(
      "Only someone who sets prices can change this price.",
    );
    expect(state.inserts).toEqual([]);
  });

  it("is refused, and told why, when the business has no set price", async () => {
    state.set = { cents: null, zoneId: null, reason: NO_PLAN_SET_PRICE_ZONE };
    await expect(newClient({})).rejects.toThrow(NO_PLAN_SET_PRICE_ZONE);
    expect(state.inserts).toEqual([]);
  });

  it("is refused billing in advance, which is a billing decision", async () => {
    await expect(newClient({ billingCadence: "prepaid" })).rejects.toThrow(PLAN_CADENCE_IS_BILLING);
    expect(state.inserts).toEqual([]);
  });

  it("saves a client with the plan skipped exactly as before", async () => {
    await newClient(undefined);
    expect(clientInserts()).toHaveLength(1);
    expect(subscriptionInserts()).toEqual([]);
  });

  it("a technician is refused a plan before anything is written", async () => {
    state.role = "tech";
    await expect(newClient({})).rejects.toThrow("Not authorized");
    expect(state.inserts).toEqual([]);
  });
});

describe("an owner's and an office manager's plan, as before", () => {
  it.each(["owner", "office_manager"])(
    "%s types any price and billing, with their own key",
    async (role) => {
      state.role = role;
      await newClient({ priceCents: 1234, billingCadence: "prepaid" });
      const [sub] = subscriptionInserts();
      expect(sub.db).toBe(USER_DB_TAG);
      expect(sub.row).toMatchObject({ price_cents: 1234, billing_cadence: "prepaid" });
    },
  );
});

// ── Routes: moving a visit ─────────────────────────────────────────────────

describe("moving a visit to another day (visit drawer)", () => {
  const move = () =>
    (rescheduleVisitFromOffice as any)({
      data: { visitId: "11111111-1111-4111-8111-111111111111", newDate: "2099-03-04" },
    });

  it("a dispatcher moves it, through reschedule_visit with their own key", async () => {
    await move();
    expect(state.rpcs).toContainEqual({
      db: USER_DB_TAG,
      fn: "reschedule_visit",
      args: { _visit_id: "11111111-1111-4111-8111-111111111111", _new_date: "2099-03-04" },
    });
  });

  it("a technician is refused before the RPC", async () => {
    state.role = "tech";
    await expect(move()).rejects.toThrow("Not authorized");
    expect(state.rpcs).toEqual([]);
  });

  it("completing and canceling, which can bill, still refuse a dispatcher", async () => {
    await expect(
      (completeVisitFromOffice as any)({
        data: { visitId: "11111111-1111-4111-8111-111111111111", confirmedEarly: true },
      }),
    ).rejects.toThrow("Not authorized");
    await expect(
      (cancelVisitFromOffice as any)({
        data: { visitId: "11111111-1111-4111-8111-111111111111", reason: "rain" },
      }),
    ).rejects.toThrow("Not authorized");
    expect(state.rpcs).toEqual([]);
  });
});

// ── Messaging ──────────────────────────────────────────────────────────────

describe("texting a client", () => {
  const text = () =>
    (sendSmsToClient as any)({
      data: { clientId: "22222222-2222-4222-8222-222222222222", body: "See you Thursday" },
    });

  it("asks for message_clients, which a dispatcher holds", async () => {
    // The fake has no client row, so a caller who passes the gate fails on
    // the read that comes next; a caller who does not is refused first.
    await expect(text()).rejects.not.toThrow("Not authorized");
  });

  it("refuses a technician before reading anything or calling the provider", async () => {
    state.role = "tech";
    await expect(text()).rejects.toThrow("Not authorized");
    expect(state.rpcs).toEqual([]);
  });

  it("is gated on message_clients in the source, not on a read permission", () => {
    const src = read("src/lib/messages.functions.ts");
    const send = src.slice(src.indexOf("export const sendSmsToClient"));
    expect(send.slice(0, 1500)).toMatch(/requirePermission\(supabase, userId, "message_clients"\)/);
  });
});

// ── The screens say what the server allows ─────────────────────────────────

describe("the screens and the help text", () => {
  it("the routes drawer offers Move to a dispatcher, and Complete/Cancel only to billing roles", () => {
    const src = read("src/components/VisitDetailDrawer.tsx");
    expect(src).toContain('const canMoveDay = can("manage_schedule");');
    expect(src).toMatch(/\{canMoveDay && \(\s*<form/);
    expect(src).toContain('const canActFromOffice = can("manage_client_billing");');
  });

  it("the client's Visits tab offers Reschedule and Reassign on manage_schedule, Cancel on billing", () => {
    const src = read("src/components/client-detail/VisitsTab.tsx");
    expect(src).toContain('const canSchedule = canDo("manage_schedule");');
    expect(src).toMatch(/\{canSchedule && canReschedule && \(/);
    expect(src).toMatch(/\{scheduled && canSchedule && \(/);
    expect(src).toMatch(/\{scheduled && canCorrect && \(/);
    expect(src).toMatch(/action === "cancel" && scheduled && canCorrect/);
    expect(src).toMatch(/\{canCorrect && canComplete && \(/);
  });

  it("the wizard shows a dispatcher the set price and no box to change it", () => {
    const src = read("src/routes/_authenticated/clients.new.tsx");
    expect(src).toContain('const setsPrices = canPlan("manage_pricing");');
    expect(src).toContain("if (!setsPrices) return suggestedCents;");
    expect(src).toContain('billingCadence: billsClients ? billingCadence : "postpaid"');
  });

  it("the Roles help page says what a dispatcher can do now, and what stays with the owner", () => {
    const help = read("src/lib/help-content.ts");
    expect(help).toContain("**Dispatcher:** the schedule, routes, weather, clients, and messages.");
    expect(help).toContain(
      "A dispatcher can add a client and start their plan at the set price, move a visit to another day or another technician, and text a client.",
    );
    expect(help).toContain(
      "Completing or canceling a visit from the office, invoices and payments, prices, settings, and who has access stay with the owner and office manager.",
    );
  });

  it("the migration changes no policy", () => {
    const sql = read(
      "supabase/migrations/20261108152800_a-dispatcher-runs-routes-clients-and-messages.sql",
    );
    expect(sql).not.toMatch(/CREATE POLICY|ALTER POLICY|DROP POLICY/i);
  });
});

// ── In a real database ─────────────────────────────────────────────────────

const MIGRATION = join(
  ROOT,
  "supabase/migrations/20261108152800_a-dispatcher-runs-routes-clients-and-messages.sql",
);
const PROOF = join(ROOT, "tests/sql/a-dispatcher-runs-routes-clients-and-messages.proof.sql");
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
    `\n  SKIPPED: the dispatcher-permission proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set WEBHOOKS_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("a dispatcher's permissions, in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("grants routes, clients and messages, refuses a typed plan price, and stays in its business", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
      encoding: "utf8",
      timeout: 300_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(7);
    expect(out).toMatch(/ALL DISPATCHER-PERMISSION PROOFS PASSED/);
  });
});
