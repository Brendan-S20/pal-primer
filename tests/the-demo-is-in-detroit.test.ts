// The demo moved to Detroit and the seed did not.
//
// The production demo was moved from Manhattan to the Detroit suburbs by hand
// on 2026-08-30. seed_demo_org kept writing Manhattan -- "New York", ZIPs
// 10001-10024, pins at 40.7 N, zones over Manhattan, a depot on W 34th St --
// so one press of Reseed put it all back. Owner decision 2026-10-03: the seed
// writes Detroit. This reads the migration and runs
// tests/sql/the-demo-is-in-detroit.proof.sql, which seeds a business and asks
// what a map would: every pin in Detroit and inside its own ZIP, every ZIP in
// a zone, the seed's zone the same as the matcher's, the depot near the work.
// The pre-fix seed fails the first of those on all ten properties.

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
  "supabase/migrations/20261004010000_the-demo-moved-to-detroit-and-the-seed-did-not.sql",
);
const PAID = join(ROOT, "supabase/migrations/20261001010000_the-demo-was-paid-next-week.sql");
const ROUTE = join(
  ROOT,
  "supabase/migrations/20260930010000_the-owner-who-runs-the-route-got-no-route.sql",
);
const PROOF = join(ROOT, "tests/sql/the-demo-is-in-detroit.proof.sql");
const DB_URL =
  process.env.WEBHOOKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

/** What the splice puts IN: every `$x1$ … $x1$` replacement block. */
function replacements(sql: string): string {
  return [...sql.matchAll(/\$(?<tag>[a-z])1\$([\s\S]*?)\$\k<tag>1\$/g)]
    .map((m) => m[2])
    .join("\n");
}

describe("the migration", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  const added = replacements(sql);

  it("splices by name and refuses to do nothing", () => {
    expect(sql).toMatch(/pg_get_functiondef\('public\.seed_demo_org\(uuid\)'::regprocedure\)/);
    expect(sql.match(/IF _new = _def THEN\s+RAISE EXCEPTION '[^']*re-cut it/g)).toHaveLength(4);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.seed_demo_org\(uuid\) FROM PUBLIC, anon;/);
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.seed_demo_org\(uuid\) TO authenticated, service_role;/,
    );
  });

  it("puts nothing back in New York", () => {
    expect(added.length).toBeGreaterThan(1000);
    expect(added).not.toMatch(/New York|Manhattan|, NY\b/);
    const zips = [...added.matchAll(/'(\d{5})'/g)].map((m) => m[1]);
    expect(zips.length).toBe(18);
    for (const zip of zips) expect(zip).toMatch(/^48\d{3}$/);
    for (const [n] of added.matchAll(/-?\d{2,3}\.\d{3,}/g)) {
      const v = Number(n);
      expect(
        (v >= 42.0 && v <= 42.9) || (v >= -83.6 && v <= -82.8),
        `${n} is not a metro-Detroit coordinate`,
      ).toBe(true);
    }
  });

  it("writes every property as Michigan, with the zone the matcher would pick", () => {
    expect(added).toMatch(/d\.street, d\.city, 'MI', d\.zip/);
    expect(added).toMatch(/zone_id, auto_zone_id, street, city,/);
  });

  it("asserts what it establishes about the body, not about rows", () => {
    const check = sql.slice(sql.indexOf("DO $check$"));
    expect(check).toMatch(/FROM pg_proc WHERE oid = 'public\.seed_demo_org\(uuid\)'::regprocedure/);
    expect(check).not.toMatch(/FROM public\./);
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
    `\n  SKIPPED: the demo-in-Detroit proof did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set WEBHOOKS_PROOF_DB_URL to run it.\n",
  );
}

/** Run the proof, again if and only if Postgres chose it as a deadlock victim
 *  (the-demo-was-paid-next-week.test.ts says why). Any other failure is
 *  returned as it is. */
function runProof(args: string[]) {
  let r = spawnSync(psql!, args, { encoding: "utf8", timeout: 300_000 });
  for (let i = 0; i < 2 && /deadlock detected/.test(`${r.stdout}${r.stderr}`); i++) {
    r = spawnSync(psql!, args, { encoding: "utf8", timeout: 300_000 });
  }
  return r;
}

describe.skipIf(!reachable)("a seeded demo, in a real database", () => {
  it("has the files it runs", () => {
    for (const f of [MIGRATION, PAID, ROUTE, PROOF]) expect(existsSync(f), f).toBe(true);
  });

  it("is in metro Detroit, in the zones the matcher would choose, and leaves nothing behind", () => {
    const r = runProof([
      DB_URL,
      "-X",
      "-v",
      `route=${ROUTE}`,
      "-v",
      `paid=${PAID}`,
      "-v",
      `migration=${MIGRATION}`,
      "-f",
      PROOF,
    ]);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(5);
    expect(out).toMatch(/ALL DEMO-IN-DETROIT PROOFS PASSED/);
  });
});
