// The demo was paid next week.
//
// seed_demo_org dated history from calendar days plus fixed hours, so in the
// first days of a month it paid last month's invoices on days that had not
// happened yet, and it issued the current period's invoice next month. CI's
// accountant-CSV E2E caught it on 2026-10-01 (27 payments in Postgres, 26 in
// the report). This reads the migration and runs
// tests/sql/the-demo-was-paid-next-week.proof.sql, which seeds a business and
// requires that nothing it wrote is dated after now. The pre-fix seed fails it
// on any day of the month (6 future-dated invoices on 2026-10-01).

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = join(ROOT, "supabase/migrations/20261001010000_the-demo-was-paid-next-week.sql");
const ROUTE = join(
  ROOT,
  "supabase/migrations/20260930010000_the-owner-who-runs-the-route-got-no-route.sql",
);
const PROOF = join(ROOT, "tests/sql/the-demo-was-paid-next-week.proof.sql");
const DB_URL =
  process.env.WEBHOOKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

describe("the migration", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it("clamps every seeded timestamp to now", () => {
    expect(sql).toMatch(/'LEAST\(' \|\| _topup \|\| ', now\(\)\)'/);
    expect(
      sql.match(/LEAST\(\(period_end \+ 1\)::timestamptz \+ interval ''9 hours'', now\(\)\)/g),
    ).toHaveLength(3);
    expect(sql).toMatch(/\(i\.period_end \+ 4\)::timestamptz \+ interval ''14 hours'' <= now\(\)/);
    expect(sql).toMatch(
      /LEAST\(GREATEST\(mtd_day::timestamptz \+ interval ''11 hours'', issued_at\), now\(\)\)/,
    );
  });

  it("splices by name and refuses to do nothing", () => {
    expect(sql).toMatch(/pg_get_functiondef\('public\.seed_demo_org\(uuid\)'::regprocedure\)/);
    expect(sql.match(/IF _new = _def THEN\s+RAISE EXCEPTION/g)).toHaveLength(4);
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
    `\n  SKIPPED: the seed-date proof did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set WEBHOOKS_PROOF_DB_URL to run it.\n",
  );
}

describe.skipIf(!reachable)("a seeded demo, in a real database", () => {
  it("has the files it runs", () => {
    for (const f of [MIGRATION, ROUTE, PROOF]) expect(existsSync(f), f).toBe(true);
  });

  it("dates nothing after now, and leaves nothing behind", () => {
    const r = spawnSync(
      psql!,
      [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-v", `route=${ROUTE}`, "-f", PROOF],
      { encoding: "utf8", timeout: 180_000 },
    );
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(1);
    expect(out).toMatch(/ALL SEED-DATE PROOFS PASSED/);
  });
});
