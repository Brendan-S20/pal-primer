// Only an owner changes staff (#659: R2-18, F-31, R2-19; decision D7).
//
// D7 CHANGED on 2026-11-10: an office manager may now change roles and turn
// people on or off too, never the owner's and never above their own role.
// That half lives in tests/an-office-manager-runs-the-team-but-not-the-owner
// .test.ts. What stays here: dispatchers and technicians are refused, the
// owner keeps both abilities, the 20261102140000 file as it shipped, and
// R2-19.
//
// An office manager could turn any teammate off through setStaffActive (no
// permission check at all) and through PATCH /rest/v1/staff, and could write
// their own staff.role = 'owner'. The screen said owner-only. This file:
//
//   * runs the server functions as each role: setStaffActive and
//     changeUserRole refuse anyone but an owner BEFORE any RPC or read;
//   * pins the migration: set_staff_active owner-only, three restrictive
//     policies on staff, and the activity_log trigger that names the actor;
//   * runs tests/sql/only-an-owner-changes-staff.proof.sql against a real
//     database when one answers (skipped, loudly, when none does);
//   * pins R2-19: a save that finds the session gone says "You've been signed
//     out", keeps the typed addresses, and /auth returns to the page.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts).
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = join(ROOT, "supabase/migrations/20261102140000_only-an-owner-changes-staff.sql");
const PROOF = join(ROOT, "tests/sql/only-an-owner-changes-staff.proof.sql");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const ORG = "0a000000-0000-4000-8000-000000d70a00";
const STAFF = "5a000000-0000-4000-8000-000000d70a03";
const USER = "f0000000-0000-4000-8000-000000d70a03";

// ── The server functions, run as each role ────────────────────────────────
const state = vi.hoisted(() => ({
  role: "owner" as string,
  rpcs: [] as string[],
  reads: [] as string[],
}));

const db = {
  from: (t: string) => {
    state.reads.push(t);
    const api: any = {
      select: () => api,
      eq: () => api,
      maybeSingle: async () => ({ data: { organization_id: ORG, active: true }, error: null }),
    };
    return api;
  },
  rpc: async (fn: string) => (state.rpcs.push(fn), { data: null, error: null }),
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

describe("D7: a dispatcher or a technician never turns people on or off, or changes a role", () => {
  for (const role of ["dispatcher", "tech"]) {
    it(`refuses ${role} on setStaffActive, both directions, before any read or RPC`, async () => {
      state.role = role;
      const { setStaffActive, ONLY_AN_OWNER_OR_OFFICE_MANAGER_TURNS_PEOPLE_ON_OR_OFF } =
        await import("@/lib/users.functions");
      for (const active of [false, true]) {
        await expect(setStaffActive({ data: { staffId: STAFF, active } } as any)).rejects.toThrow(
          ONLY_AN_OWNER_OR_OFFICE_MANAGER_TURNS_PEOPLE_ON_OR_OFF,
        );
      }
      expect(state.rpcs).toEqual([]);
      expect(state.reads).toEqual([]);
    });

    it(`refuses ${role} on changeUserRole, including making somebody an owner`, async () => {
      state.role = role;
      const { changeUserRole, ONLY_AN_OWNER_OR_OFFICE_MANAGER_CHANGES_ROLES } = await import(
        "@/lib/users.functions"
      );
      for (const newRole of ["owner", "office_manager", "tech"]) {
        await expect(
          changeUserRole({ data: { userId: USER, role: newRole } } as any),
        ).rejects.toThrow(ONLY_AN_OWNER_OR_OFFICE_MANAGER_CHANGES_ROLES);
      }
      expect(state.rpcs).toEqual([]);
    });
  }

  it("lets an owner do both", async () => {
    state.role = "owner";
    const { setStaffActive, changeUserRole } = await import("@/lib/users.functions");
    await setStaffActive({ data: { staffId: STAFF, active: false } } as any);
    await changeUserRole({ data: { userId: USER, role: "owner" } } as any);
    expect(state.rpcs).toEqual(["set_staff_active", "change_user_role"]);
  });

  it("the screen shows the controls to the owner and whoever holds manage_users as configured (#863)", () => {
    const page = read("src/routes/_authenticated/settings.users.tsx");
    expect(page).toMatch(/const canManageStaff = myRole === "owner" \|\| can\("manage_users"\);/);
    expect(page).toMatch(/\{canManageRow \? \(\s*<Select/);
    expect(page).toMatch(/\{canManageRow && u\.staff_id && \(/);
  });
});

// ── The migration ─────────────────────────────────────────────────────────
describe("D7 in the database", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  const policies = sql.match(/CREATE POLICY[\s\S]*?;/g) ?? [];

  it("set_staff_active asks for an owner and no longer names office_manager", () => {
    const fn = sql.match(
      /CREATE OR REPLACE FUNCTION public\.set_staff_active[\s\S]*?\$function\$;/,
    )?.[0];
    expect(fn).toBeTruthy();
    expect(fn).toMatch(/has_role\(auth\.uid\(\), _org, 'owner'::app_role\)/);
    expect(fn).not.toMatch(/office_manager/);
  });

  it("adds restrictive owner-only policies for UPDATE of active/role, INSERT of an owner, and DELETE", () => {
    expect(policies).toHaveLength(3);
    for (const p of policies) {
      expect(p).toMatch(/ON public\.staff\s+AS RESTRICTIVE/);
      expect(p).toMatch(
        /has_role\(\(SELECT auth\.uid\(\)\), organization_id, 'owner'::public\.app_role\)/,
      );
    }
    expect(policies.find((p) => /FOR UPDATE/.test(p))).toMatch(
      /staff_authority_unchanged\(id, active, role\)/,
    );
    expect(policies.find((p) => /FOR INSERT/.test(p))).toMatch(/role IS DISTINCT FROM 'owner'/);
    expect(policies.find((p) => /FOR DELETE/.test(p))).toBeTruthy();
  });

  it("enables no RLS of its own (so needs no require_mfa_policy) and counts restrictive policies only", () => {
    expect(sql).not.toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/permissive = 'RESTRICTIVE'/);
  });

  it("logs the actor on every change of active or role", () => {
    expect(sql).toMatch(/AFTER UPDATE OF active, role ON public\.staff/);
    expect(sql).toMatch(/_actor uuid := auth\.uid\(\)/);
    expect(sql).toMatch(/'staff\.active_changed'/);
    expect(sql).toMatch(/'staff\.role_changed'/);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.tg_log_staff_authority_change\(\) FROM PUBLIC, anon, authenticated;/,
    );
  });
});

// ── R2-19: signed out mid-save ────────────────────────────────────────────
describe("a save that finds the session gone", () => {
  it("is told apart from any other failure", async () => {
    const { isSignedOutError } = await import("@/lib/signed-out");
    expect(isSignedOutError(new Error("Unauthorized: No authorization header provided"))).toBe(
      true,
    );
    expect(isSignedOutError(new Error("Unauthorized: Invalid token"))).toBe(true);
    expect(isSignedOutError(new Error("Only an owner can change roles."))).toBe(false);
    expect(isSignedOutError(null)).toBe(false);
  });

  it("says so in words", async () => {
    const { SIGNED_OUT_MESSAGE } = await import("@/lib/signed-out");
    expect(SIGNED_OUT_MESSAGE).toMatch(/^You've been signed out\./);
  });

  it("keeps the draft through a sign-in and forgets it after a save", async () => {
    const mem = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => void mem.set(k, v),
        removeItem: (k: string) => void mem.delete(k),
      },
    });
    try {
      const { keepDraft, readDraft, forgetDraft } = await import("@/lib/signed-out");
      keepDraft("staff-addresses:x", { start: "1 Depot Rd", end: "" });
      expect(readDraft("staff-addresses:x")).toEqual({ start: "1 Depot Rd", end: "" });
      forgetDraft("staff-addresses:x");
      expect(readDraft("staff-addresses:x")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("holds the page, and /auth delivers it after sign-in", async () => {
    const { returnHereAfterSignIn } = await import("@/lib/signed-out");
    const { takeLinkForLanding, __resetDeepLinkForTests } = await import(
      "@/lib/pending-deep-link"
    );
    __resetDeepLinkForTests();
    returnHereAfterSignIn("/settings/users");
    // The function /auth's land() calls (#700), so this is the real delivery.
    expect(takeLinkForLanding()).toBe("/settings/users");
    expect(takeLinkForLanding()).toBeNull();
    expect(read("src/routes/auth.tsx")).toMatch(
      /const link = takeLinkForLanding\(\);\s*if \(link\) router\.history\.push\(link\);/,
    );
  });

  it("the guard holds the page before it sends a signed-out reload to /auth", () => {
    const guard = read("src/routes/_authenticated/route.tsx");
    expect(guard).toMatch(
      /returnHereAfterSignIn\(location\.href\);\s*throw redirect\(\{ to: "\/auth" \}\);/,
    );
  });

  it("Settings -> Users uses it on every staff save", () => {
    const page = read("src/routes/_authenticated/settings.users.tsx");
    // changeRole, toggleActive, routingMut: each onError goes through it.
    expect(page.match(/if \(!signedOut\(e\)\) toast\.error/g)?.length).toBeGreaterThanOrEqual(4);
    expect(page).toMatch(
      /if \(isSignedOutError\(e\)\) keepDraft\(addressDraftKey\(staff\.id\), \{ start, end \}\);/,
    );
    expect(page).toMatch(/readDraft<AddressDraft>\(addressDraftKey\(staff\.id\)\)/);
    expect(page).toMatch(/forgetDraft\(addressDraftKey\(staff\.id\)\);/);
  });

  it("the invite panel's send, revoke and resend say so too, not a raw 'Unauthorized'", () => {
    // Acceptance audit of #659 at a2d7e9d: the four staff saves used the
    // signed-out toast, but the three invite mutations on the same page still
    // showed the server's raw message ("Unauthorized: ...") when the session
    // had gone, with no way back to sign in.
    const page = read("src/routes/_authenticated/settings.users.tsx");
    const start = page.indexOf("function InvitePanel()");
    const end = page.indexOf("function StaffAddressEditor(");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const panel = page.slice(start, end);
    expect(panel).toMatch(/const signedOut = useSignedOutToast\(\);/);
    const onErrors = panel.match(/onError: \(e\) => \{\n[^\n]*\n[^\n]*/g) ?? [];
    expect(onErrors).toHaveLength(3);
    for (const line of onErrors) expect(line).toMatch(/if \(!signedOut\(e\)\)|signedOut\(e\) \|\|/);
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
    `\n  SKIPPED: the only-an-owner-changes-staff proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set WEBHOOKS_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("only an owner changes staff, in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("an office manager is refused by RPC and REST, the owner is not, and the owner is logged", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
      encoding: "utf8",
      timeout: 300_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    expect(out).toMatch(/ALL ONLY-AN-OWNER-CHANGES-STAFF PROOFS PASSED/);
  });
});
