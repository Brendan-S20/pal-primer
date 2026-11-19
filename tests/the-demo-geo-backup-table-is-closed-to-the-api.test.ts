// The demo-geo backup table is closed to the API (#977).
//
// Pins 20261118020000: guarded (to_regclass / pg_namespace), idempotent, no
// DROP and no DELETE of any kind (dropping production data is Brendan's call),
// RLS enabled with no policy, anon and authenticated revoked, no transaction
// control (the proof applies it inside its own). Runs
// tests/sql/the-demo-geo-backup-table-is-closed-to-the-api.proof.sql against a
// real database when one answers (skipped, loudly, when none does).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// A proof waits its turn behind others (tests/the-proofs-take-turns.test.ts).
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(__dirname, "..");
const NAME = "the-demo-geo-backup-table-is-closed-to-the-api";
const VERSION = "20261118020000";
const MIGRATION = join(ROOT, `supabase/migrations/${VERSION}_${NAME}.sql`);
const PROOF = join(ROOT, "tests/sql/the-demo-geo-backup-table-is-closed-to-the-api.proof.sql");

describe("the backup-table migration, as a file", () => {
  const sql = existsSync(MIGRATION) ? readFileSync(MIGRATION, "utf8") : "";
  const code = sql.replace(/^\s*--.*$/gm, "");

  it("has its migration, rollback, proof and CI wrapper", () => {
    for (const f of [
      MIGRATION,
      join(ROOT, `supabase/rollback/${VERSION}_${NAME}.down.sql`),
      PROOF,
      join(ROOT, `supabase/proofs/${VERSION}-${NAME}.sql`),
    ]) {
      expect(existsSync(f), f).toBe(true);
    }
  });

  it("holds its version alone", () => {
    const files = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql"));
    expect(files.filter((f) => f.startsWith(VERSION))).toEqual([`${VERSION}_${NAME}.sql`]);
  });

  it("is guarded, so an empty database is a no-op", () => {
    expect(code).toMatch(/IF to_regclass\('backup\.demo_geo_20260830'\) IS NOT NULL THEN\s+ALTER TABLE backup\.demo_geo_20260830 ENABLE ROW LEVEL SECURITY;/);
    expect(code).toMatch(/IF EXISTS \(SELECT 1 FROM pg_namespace WHERE nspname = 'backup'\) THEN\s+REVOKE USAGE ON SCHEMA backup/);
    // The only unguarded statement is the DO block itself.
    expect(code.replace(/DO \$closed\$[\s\S]*\$closed\$;/, "").trim()).toBe("");
  });

  it("closes the table and does not delete anything", () => {
    expect(code).toMatch(/REVOKE ALL ON TABLE backup\.demo_geo_20260830 FROM anon, authenticated;/);
    expect(code).not.toMatch(/\b(DROP|DELETE|TRUNCATE)\b/i);
    expect(code).not.toMatch(/CREATE POLICY/i);
    expect(code).not.toMatch(/^(BEGIN|COMMIT);/m);
  });
});

const DB_URL =
  process.env.WEBHOOKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

function findPsql(): string | null {
  for (const p of ["psql", "/opt/homebrew/opt/libpq/bin/psql", "/opt/homebrew/opt/postgresql@17/bin/psql"]) {
    if (spawnSync(p, ["--version"], { encoding: "utf8" }).status === 0) return p;
  }
  return null;
}
const psql = findPsql();
const reachable =
  !!psql &&
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], { encoding: "utf8", timeout: 5_000 }).stdout?.trim() === "1";
if (!reachable) {
  console.warn(`\n  SKIPPED: the ${NAME} proof did NOT run (no database at ${DB_URL}).\n`);
}

describe.skipIf(!reachable)("the backup-table migration, in a real database", () => {
  it("is a no-op when empty, closes the table, twice, leaves the row, and the mutation reproduces", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-f", PROOF], { encoding: "utf8", timeout: 300_000 });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED|PROOF INCONCLUSIVE/);
    expect((out.match(/ok:/g) ?? []).length).toBe(6);
  });
});
