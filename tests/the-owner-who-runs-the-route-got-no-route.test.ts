// The owner who runs the route got no route.
//
// seed_demo_org refuses a business with no active field technician, then
// handed visits out by ROLE — never to the owner — and read "today" off the
// UTC clock. An owner-operator's evening Reseed came back with every visit
// belonging to nobody, and CI's re-clean E2E failed on exactly that at
// 21:40 Central: "107 completed visits (0 assigned)".
//
// This file reads the migration, then runs
// tests/sql/the-owner-who-runs-the-route-got-no-route.proof.sql, which seeds a
// one-person business as its owner and requires every visit to be assigned.
// The pre-fix functions fail it at any hour (history never went to the
// owner); the migration passes it.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20260930010000_the-owner-who-runs-the-route-got-no-route.sql",
);
const PROOF = join(ROOT, "tests/sql/the-owner-who-runs-the-route-got-no-route.proof.sql");
const DB_URL =
  process.env.WEBHOOKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

describe("the migration", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it("hands every pool to the field technicians, not a list of roles", () => {
    expect(sql).toMatch(/AND active AND is_field_tech;/);
    expect(sql).toMatch(/ORDER BY \(role = ''tech''\) DESC, created_at LIMIT 1/);
    expect(sql).toMatch(/AND active AND is_field_tech\);/);
  });

  it("reads today off the organization's clock", () => {
    const assign = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.assign_demo_visits_to_staff"),
      sql.indexOf("REVOKE ALL ON FUNCTION public.assign_demo_visits_to_staff"),
    );
    expect(assign).toMatch(/now\(\) AT TIME ZONE COALESCE\(o\.timezone/);
    expect(assign).toMatch(/scheduled_on >= today/);
    expect(assign).not.toMatch(/current_date/);
  });

  it("splices by name and refuses to do nothing", () => {
    expect(sql).toMatch(/pg_get_functiondef\('public\.seed_demo_org\(uuid\)'::regprocedure\)/);
    expect(sql.match(/IF _new = _def THEN\s+RAISE EXCEPTION/g)).toHaveLength(3);
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
    `\n  SKIPPED: the owner-operator seed proof did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set WEBHOOKS_PROOF_DB_URL to run it.\n",
  );
}

describe.skipIf(!reachable)("an owner-operator's demo, in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("assigns every visit to the owner who runs the route, and leaves nothing behind", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
      encoding: "utf8",
      timeout: 180_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(1);
    expect(out).toMatch(/ALL ROUTE PROOFS PASSED/);
  });
});
