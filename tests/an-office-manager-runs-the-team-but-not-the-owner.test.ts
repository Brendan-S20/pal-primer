// An office manager runs the team, but not the owner (#659, D7 as changed by
// Brendan on 2026-11-10: "Let managers too").
//
// The rule, on every path (Settings -> Users, the server functions, the RPC,
// PATCH /rest/v1/staff):
//
//   * an office manager changes a teammate's role and turns them off or on;
//   * an office manager never changes or turns off an owner;
//   * an office manager never grants a role above their own: not owner, and
//     not platform_admin, which app_role also holds;
//   * a dispatcher or technician does neither (pinned next door, in
//     tests/only-an-owner-changes-staff.test.ts);
//   * the owner can do everything they could before.
//
// This file runs the server functions as each role, pins the migration, and
// runs tests/sql/an-office-manager-runs-the-team-but-not-the-owner.proof.sql
// against a real database when one answers (skipped, loudly, when none does).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts).
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20261111120000_an-office-manager-runs-the-team-but-not-the-owner.sql",
);
const PROOF = join(ROOT, "tests/sql/an-office-manager-runs-the-team-but-not-the-owner.proof.sql");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const ORG = "0a000000-0000-4000-8000-000000d70b00";
const STAFF = "5a000000-0000-4000-8000-000000d70b03";
const USER = "f0000000-0000-4000-8000-000000d70b03";

// ── The server functions, run as each role ────────────────────────────────
const state = vi.hoisted(() => ({
  role: "owner" as string,
  rpcs: [] as Array<{ fn: string; args: unknown }>,
  reads: [] as string[],
}));

const db = {
  from: (t: string) => {
    state.reads.push(t);
    const api: any = {
      select: () => api,
      eq: () => api,
      maybeSingle: async () => ({ data: { organization_id: ORG, active: false }, error: null }),
    };
    return api;
  },
  rpc: async (fn: string, args: unknown) => (
    state.rpcs.push({ fn, args }),
    { data: null, error: null }
  ),
};

vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    let validate: (d: unknown) => unknown = (d) => d;
    const b: any = {
      middleware: () => b,
      inputValidator: (v: (d: unknown) => unknown) => ((validate = v), b),
      handler:
        (h: (ctx: { data: unknown; context: unknown }) => unknown) =>
        (opts: { data?: unknown } = {}) =>
          h({ data: validate(opts.data), context: { supabase: db, userId: "caller-1" } }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: db }));
vi.mock("@/lib/authz.server", () => ({
  resolveCaller: async () => ({ orgId: ORG, role: state.role }),
  requirePermission: async () => ({ orgId: ORG, role: state.role }),
}));
vi.mock("@/lib/seat-sync.server", () => ({
  syncOrgSeatQuantity: async () => ({ skipped: "test" }),
}));
vi.mock("@/lib/team-size.server", () => ({ assertRoomForAnotherUser: async () => {} }));

beforeEach(() => {
  state.rpcs.length = 0;
  state.reads.length = 0;
});

describe("an office manager, through the server functions", () => {
  it("turns a tech off and back on", async () => {
    state.role = "office_manager";
    const { setStaffActive } = await import("@/lib/users.functions");
    await setStaffActive({ data: { staffId: STAFF, active: false } } as any);
    await setStaffActive({ data: { staffId: STAFF, active: true } } as any);
    expect(state.rpcs).toEqual([
      { fn: "set_staff_active", args: { _staff_id: STAFF, _active: false } },
      { fn: "set_staff_active", args: { _staff_id: STAFF, _active: true } },
    ]);
  });

  it("changes a tech's role to any role at or below their own", async () => {
    state.role = "office_manager";
    const { changeUserRole } = await import("@/lib/users.functions");
    for (const role of ["dispatcher", "office_manager", "tech"]) {
      await changeUserRole({ data: { userId: USER, role } } as any);
    }
    expect(state.rpcs.map((r) => (r.args as any)._new_role)).toEqual([
      "dispatcher",
      "office_manager",
      "tech",
    ]);
  });

  it("is refused making anybody an owner, before any RPC", async () => {
    state.role = "office_manager";
    const { changeUserRole, NOT_ABOVE_YOUR_OWN_ROLE } = await import("@/lib/users.functions");
    await expect(changeUserRole({ data: { userId: USER, role: "owner" } } as any)).rejects.toThrow(
      NOT_ABOVE_YOUR_OWN_ROLE,
    );
    expect(state.rpcs).toEqual([]);
  });

  it("is never offered a role above office manager", async () => {
    const { ROLES_A_CALLER_MAY_GRANT } = await import("@/lib/users.functions");
    expect([...ROLES_A_CALLER_MAY_GRANT.office_manager].sort()).toEqual(
      ["dispatcher", "office_manager", "tech"].sort(),
    );
    expect(ROLES_A_CALLER_MAY_GRANT.dispatcher).toBeUndefined();
    expect(ROLES_A_CALLER_MAY_GRANT.tech).toBeUndefined();
  });
});

describe("the owner, through the server functions, is unchanged", () => {
  it("turns people off and on and grants any role, owner included", async () => {
    state.role = "owner";
    const { setStaffActive, changeUserRole } = await import("@/lib/users.functions");
    await setStaffActive({ data: { staffId: STAFF, active: false } } as any);
    for (const role of ["owner", "office_manager", "dispatcher", "tech"]) {
      await changeUserRole({ data: { userId: USER, role } } as any);
    }
    expect(state.rpcs.map((r) => r.fn)).toEqual([
      "set_staff_active",
      "change_user_role",
      "change_user_role",
      "change_user_role",
      "change_user_role",
    ]);
  });
});

// ── The screen ────────────────────────────────────────────────────────────
describe("Settings -> Users", () => {
  const page = read("src/routes/_authenticated/settings.users.tsx");

  it("gives an office manager the controls on every row but an owner's", () => {
    expect(page).toMatch(
      /const canManageRow = canManageStaff && \(myRole === "owner" \|\| u\.role !== "owner"\);/,
    );
    expect(page).toMatch(/\{canManageRow \? \(\s*<Select/);
    expect(page).toMatch(/\{canManageRow && u\.staff_id && \(/);
  });

  it("offers only the roles the caller may grant", () => {
    expect(page).toMatch(/ROLES_A_CALLER_MAY_GRANT\[myRole \?\? ""\]/);
    expect(page).toMatch(/\{grantableRoles\.map\(\(r\) => \(/);
    expect(page).not.toMatch(/\{ROLES\.map\(\(r\) => \(/);
  });
});

// ── The migration ─────────────────────────────────────────────────────────
describe("the migration", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  const fn = (name: string) =>
    sql.match(
      new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}[\\s\\S]*?\\$function\\$;`),
    )?.[0] ?? "";

  it("set_staff_active lets an office manager in, but never onto an owner", () => {
    const body = fn("set_staff_active");
    expect(body).toMatch(/has_role\(auth\.uid\(\), _org, 'owner'::app_role\)/);
    expect(body).toMatch(
      /ELSIF public\.has_role\(auth\.uid\(\), _org, 'office_manager'::app_role\)/,
    );
    expect(body).toMatch(/IF public\.staff_row_is_an_owner\(_staff_id\) THEN/);
    expect(body).not.toMatch(/'dispatcher'|'tech'/);
  });

  it("change_user_role holds an office manager to their own rank, off the owner, and on the team", () => {
    const body = fn("change_user_role");
    expect(body).toMatch(
      /_new_role NOT IN \('office_manager'::app_role, 'dispatcher'::app_role, 'tech'::app_role\)/,
    );
    expect(body).toMatch(/An office manager cannot change the owner''s role\./);
    expect(body).toMatch(/That person is not on your team\./);
    // The owner's own path, last-owner check included, is still there.
    expect(body).toMatch(/RAISE EXCEPTION 'Cannot demote the last owner';/);
  });

  it("replaces the owner-only UPDATE policy with one that lets an office manager in, never above or onto an owner", () => {
    expect(sql).toMatch(
      /DROP POLICY IF EXISTS "Only an owner changes who is on or their role" ON public\.staff;/,
    );
    const policies = sql.match(/CREATE POLICY[\s\S]*?;\n/g) ?? [];
    expect(policies).toHaveLength(1);
    const p = policies[0];
    expect(p).toMatch(/AS RESTRICTIVE FOR UPDATE TO authenticated/);
    expect(p).toMatch(/staff_authority_unchanged\(id, active, role\)/);
    expect(p).toMatch(/'office_manager'::public\.app_role/);
    expect(p).toMatch(/NOT public\.staff_row_is_an_owner\(id\)/);
    expect(p).not.toMatch(/'owner'::public\.staff_role/);
    // INSERT of an owner and DELETE stay owner-only: not touched here.
    expect(sql).not.toMatch(
      /DROP POLICY IF EXISTS "Only an owner (adds an owner|removes a person)"/,
    );
  });

  it("the helper it adds asks who is calling, and is closed to anon", () => {
    const body = fn("staff_row_is_an_owner");
    expect(body).toMatch(/SECURITY DEFINER/);
    expect(body).toMatch(/public\.is_org_member\(auth\.uid\(\), s\.organization_id\)/);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.staff_row_is_an_owner\(uuid\) FROM PUBLIC, anon;/,
    );
  });

  it("enables no RLS of its own and counts restrictive policies only", () => {
    expect(sql).not.toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/permissive = 'RESTRICTIVE'/);
  });
});

// ── The proof, in a real database ─────────────────────────────────────────
const DB_URL =
  process.env.WEBHOOKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

function findPsql(): string | null {
  for (const p of [
    "psql",
    "/opt/homebrew/opt/libpq/bin/psql",
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
    `\n  SKIPPED: the an-office-manager-runs-the-team-but-not-the-owner proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set WEBHOOKS_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)(
  "an office manager runs the team but not the owner, in a real database",
  () => {
    it("has the files it runs", () => {
      expect(existsSync(MIGRATION)).toBe(true);
      expect(existsSync(PROOF)).toBe(true);
    });

    it("by RPC and REST: an office manager changes a tech, never the owner, never above their own role", () => {
      const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
        encoding: "utf8",
        timeout: 300_000,
      });
      const out = `${r.stdout}\n${r.stderr}`;
      expect(r.status, out).toBe(0);
      expect(out).not.toMatch(/PROOF FAILED/);
      expect(out).toMatch(/ALL AN-OFFICE-MANAGER-RUNS-THE-TEAM PROOFS PASSED/);
    });
  },
);
