// Off means off.
//
// Turning somebody off on Settings -> Users (staff.active = false) took them
// off the seat count and left every door open: the permission primitives, the
// RLS helpers and the server functions all read user_roles, which turning off
// never touched. This file:
//
//   * runs tests/sql/off-means-off.proof.sql against the local stack: a
//     technician and an office manager who are off read nothing of their
//     business and write nothing; turning the technician back on restores
//     their route; another business is untouched; the last owner who is on
//     cannot be turned off or demoted; an accepted invitation joins on;
//   * pins the server side: resolveCaller, and so requirePermission and every
//     server function that goes through either, refuses a person who is off;
//   * pins the app side: the shell sends that person to /access-off before it
//     loads the business.

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCESS_TURNED_OFF,
  isAccessTurnedOff,
  requirePermission,
  resolveCaller,
} from "@/lib/authz.server";

vi.mock("@/lib/impersonation-session.server", () => ({
  assertImpersonationSessionActive: async () => {},
}));

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts),
// so on a loaded runner one can take minutes without being hung.
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = join(ROOT, "supabase/migrations/20261009180000_off-means-off.sql");
const PROOF = join(ROOT, "tests/sql/off-means-off.proof.sql");
const DB_URL =
  process.env.WEBHOOKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

const ORG = "0a000000-0000-4000-8000-000000000001";

/** The two reads resolveCaller makes: the membership, and access_turned_off(). */
function client(opts: {
  role?: string | null;
  turnedOff?: Array<{ organization_id: string; organization_name: string }>;
  rpcError?: { message: string; code?: string };
}) {
  return {
    from: (table: string) => {
      expect(table).toBe("user_roles");
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: opts.role === null ? null : { organization_id: ORG, role: opts.role ?? "tech" },
              error: null,
            }),
          }),
        }),
      };
    },
    rpc: async (fn: string) => {
      expect(fn).toBe("access_turned_off");
      return opts.rpcError
        ? { data: null, error: opts.rpcError }
        : { data: opts.turnedOff ?? [], error: null };
    },
  };
}

describe("the server-side gate", () => {
  it("lets a person who is on through, as before", async () => {
    await expect(resolveCaller(client({ role: "tech" }), "u1")).resolves.toEqual({
      orgId: ORG,
      role: "tech",
    });
  });

  it("refuses a person who is off, before any permission is asked", async () => {
    const off = client({
      role: "owner",
      turnedOff: [{ organization_id: ORG, organization_name: "Acme Scoop" }],
    });
    await expect(resolveCaller(off, "u1")).rejects.toThrow(ACCESS_TURNED_OFF);
    await expect(requirePermission(off, "u1", "manage_settings")).rejects.toThrow(
      ACCESS_TURNED_OFF,
    );
  });

  it("fails closed when it cannot tell", async () => {
    await expect(
      resolveCaller(client({ role: "tech", rpcError: { message: "connection reset" } }), "u1"),
    ).rejects.toThrow("connection reset");
  });

  it("does not stop the app between a deploy and its migration", async () => {
    // PostgREST's "no such function": the database does not have the gate
    // yet, so the database is not enforcing it either. Treated as nobody off.
    await expect(
      resolveCaller(
        client({ role: "tech", rpcError: { message: "Could not find the function", code: "PGRST202" } }),
        "u1",
      ),
    ).resolves.toEqual({ orgId: ORG, role: "tech" });
  });

  it("names the refusal so the app can tell it from any other error", () => {
    expect(isAccessTurnedOff(new Error(ACCESS_TURNED_OFF))).toBe(true);
    expect(isAccessTurnedOff(new Error("Not authorized"))).toBe(false);
    expect(isAccessTurnedOff("nope")).toBe(false);
  });
});

describe("the server functions that found the org on their own", () => {
  // Each of these had a private resolveOrgId reading user_roles and nothing
  // else. They go through resolveCaller now, so the gate above covers them.
  const FILES = [
    "stations",
    "referrals",
    "weather",
    "weather-day",
    "blackouts",
    "users",
    "demo",
    "email-settings",
    "routing-runs",
    "visits",
    "clients",
    "skip-rules",
  ];
  it.each(FILES)("%s.functions.ts asks resolveCaller", (f) => {
    const src = readFileSync(join(ROOT, `src/lib/${f}.functions.ts`), "utf8");
    expect(src).toMatch(/resolveCaller\(/);
    expect(src).not.toMatch(/\.from\("user_roles"\)/);
  });
});

describe("the app", () => {
  const shell = readFileSync(join(ROOT, "src/routes/_authenticated/route.tsx"), "utf8");
  const org = readFileSync(join(ROOT, "src/lib/org.functions.ts"), "utf8");

  it("getMyOrg says the person is off rather than loading the business", () => {
    const fn = org.slice(org.indexOf("export const getMyOrg"));
    const off = fn.indexOf("accessTurnedOff(");
    expect(off).toBeGreaterThan(-1);
    expect(off).toBeLessThan(fn.indexOf('.from("organizations")'));
  });

  it("the shell sends a person who is off to /access-off before it draws anything", () => {
    expect(shell).toMatch(/accessTurnedOff/);
    expect(shell).toMatch(/redirect\(\{\s*to: "\/access-off"/);
  });
});

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
    `\n  SKIPPED: the off-means-off proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set WEBHOOKS_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("off means off, in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("a person who is off reads and writes nothing of the business, and on again restores it", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
      encoding: "utf8",
      timeout: 300_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(8);
    expect(out).toMatch(/ALL OFF-MEANS-OFF PROOFS PASSED/);
  });
});
