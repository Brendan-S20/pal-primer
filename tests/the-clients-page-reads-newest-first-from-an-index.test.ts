// The /clients page reads newest-first from an index (#900). Pins 20261118050000 and runs
// its proof against a real database when one answers.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// A proof waits its turn behind others (tests/the-proofs-take-turns.test.ts).
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(__dirname, "..");
const NAME = "the-clients-page-reads-newest-first-from-an-index";
const VERSION = "20261118050000";
const MIGRATION = join(ROOT, `supabase/migrations/${VERSION}_${NAME}.sql`);
const PROOF = join(ROOT, "tests/sql/the-clients-page-reads-newest-first-from-an-index.proof.sql");

describe("the clients index migration, as a file", () => {
  const sql = existsSync(MIGRATION) ? readFileSync(MIGRATION, "utf8") : "";

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

  it("matches the page read's order, and is additive and non-concurrent", () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS clients_org_newest_idx\s+ON public.clients \(organization_id, created_at DESC, id\)/,
    );
    const code = sql.replace(/^--.*$/gm, "");
    expect(code).not.toMatch(/CONCURRENTLY\s+\w|DROP |ALTER /);
    const fn = readFileSync(join(ROOT, "src/lib/clients.functions.ts"), "utf8");
    expect(fn).toMatch(/\.order\("created_at", \{ ascending: false \}\)\s*\.order\("id"\)/);
  });
});

const DB_URL =
  process.env.WEBHOOKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

function findPsql(): string | null {
  for (const p of [
    "psql",
    "/opt/homebrew/opt/libpq/bin/psql",
    "/opt/homebrew/opt/postgresql@17/bin/psql",
  ]) {
    if (spawnSync(p, ["--version"], { encoding: "utf8" }).status === 0) return p;
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
  console.warn(`\n  SKIPPED: the ${NAME} proof did NOT run (no database at ${DB_URL}).\n`);
}

describe.skipIf(!reachable)("the clients index migration, in a real database", () => {
  it("serves the page read from the index, in order", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-f", PROOF], { encoding: "utf8", timeout: 300_000 });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED|PROOF INCONCLUSIVE/);
    expect(out).toMatch(/ALL CLIENTS-INDEX PROOFS PASSED/);
  });
});
