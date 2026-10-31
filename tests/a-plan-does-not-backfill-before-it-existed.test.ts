// A plan does not backfill the days before it existed (#631).
//
// generate_visits_core walked the interval, twice-weekly and one-time plans
// from started_on. A plan entered today with a start date last month got a
// month of visits inserted already behind schedule, and the nightly
// admin_transition_missed_visits marked every one Missed. The weekday and
// stay branches already started at today; 20261031120000 skips any date
// before the plan's created day in the business's timezone in the other
// three, and dates the demo seed's plans from their start so its history
// still builds.
//
// The first half reads the migration. The second runs
// tests/sql/a-plan-does-not-backfill-before-it-existed.proof.sql, which
// generates with the function as it was, applies the migration inside a
// transaction, generates again, and proves that
//
//   * no plan of any older cadence entered today has a visit before today;
//   * every date on or after a plan's created day is the date it was before;
//   * a future plan, and a plan that existed since its start, generate as before;
//   * a Missed visit already on the books is untouched;
//   * the demo seed still has completed and missed history,
//
// and then ROLLS BACK. When no database is reachable it says so and skips.

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts),
// so on a loaded runner one can take minutes without being hung.
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20261031120000_a-plan-does-not-backfill-before-it-existed.sql",
);
const PROOF = join(ROOT, "tests/sql/a-plan-does-not-backfill-before-it-existed.proof.sql");
const DB_URL =
  process.env.BACKFILL_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

describe("the migration", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it("splices both functions by name and checks every anchor", () => {
    expect(sql).toMatch(
      /pg_get_functiondef\('public\.generate_visits_core\(uuid, date, uuid\)'::regprocedure\)/,
    );
    expect(sql).toMatch(/pg_get_functiondef\('public\.seed_demo_org\(uuid\)'::regprocedure\)/);
    expect(sql).toMatch(/IF _n <> 1 THEN\s+RAISE EXCEPTION 'expected exactly 1/);
  });

  it("floors the one-time, twice-weekly and interval branches at the created day", () => {
    expect(sql).toMatch(/_floor := \(COALESCE\(_sub\.created_at, now\(\)\) AT TIME ZONE/);
    expect(sql).toContain("AND _candidate >= _floor';");
    expect(sql).toContain("AND _next >= _floor AND _next <= _stop';");
    expect(sql).toContain("IF _candidate >= _floor AND NOT EXISTS");
  });

  it("dates the demo seed's plans from their start", () => {
    expect(sql).toContain("preferred_weekdays, status, started_on, created_at)");
    expect(sql).toContain("((today - d.age) + time '08:00') AT TIME ZONE _tz");
  });

  it("leaves existing visits and the Missed sweep alone", () => {
    const code = sql.replace(/--[^\n]*/g, "");
    expect(code).not.toMatch(/\b(DELETE FROM|UPDATE)\s+public\.visits\b/i);
    expect(code).not.toMatch(/admin_transition_missed_visits/);
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
    timeout: 30_000,
  }).stdout?.trim() === "1";

if (!reachable) {
  console.warn(
    `\n  SKIPPED: the backfill proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set BACKFILL_PROOF_DB_URL to run them.\n",
  );
}

/** Run the proof, again if and only if Postgres chose it as a deadlock victim. */
function runProof(args: string[]) {
  let r = spawnSync(psql!, args, { encoding: "utf8", timeout: 300_000 });
  for (let i = 0; i < 2 && /deadlock detected/.test(`${r.stdout}${r.stderr}`); i++) {
    r = spawnSync(psql!, args, { encoding: "utf8", timeout: 300_000 });
  }
  return r;
}

describe.skipIf(!reachable)("a plan entered late, in a real database", () => {
  it("has the files it runs", () => {
    for (const f of [MIGRATION, PROOF]) expect(existsSync(f), f).toBe(true);
  });

  it("generates nothing before the plan existed, and leaves nothing behind", () => {
    const r = runProof([DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF]);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    // Five groups, each announcing itself only when it passed.
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(5);
    expect(out).toMatch(/ALL BACKFILL PROOFS PASSED/);

    const left = spawnSync(
      psql!,
      [
        DB_URL,
        "-XAtc",
        "select count(*) from public.organizations where name like 'Backfill%Proof'",
      ],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  });
});
