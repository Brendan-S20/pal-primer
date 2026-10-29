// #571 (F-08): a tech or dispatcher could read every imported client's gate
// code from import_rows. The import tables now answer to manage_imports.
import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts).
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const DB_URL =
  process.env.IMPORT_ROWS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20261029090000_a-tech-could-read-every-imported-gate-code.sql",
);
const PROOF = join(ROOT, "tests/sql/a-tech-could-read-every-imported-gate-code.proof.sql");

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
    `\n  SKIPPED: the import-row proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set IMPORT_ROWS_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("import rows answer to manage_imports, in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("keeps techs, dispatchers and other businesses out, and lets the office in", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
      encoding: "utf8",
      timeout: 300_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    for (const ok of [
      "ok: a tech, a dispatcher and another business read, change and delete no import rows or batches",
      "ok: the owner and the office manager read, start, change and delete their imports",
      "ok: a turned-off office manager reads no import rows",
    ]) {
      expect(out, out).toContain(ok);
    }
  });
});
