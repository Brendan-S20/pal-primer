// A business's QuickBooks data is shown only to that business, by RLS, and a
// browser session can neither read the tokens nor write the log.
//
// Runs tests/sql/quickbooks-for-real.proof.sql against the local stack, with
// the migration applied inside a transaction that is rolled back. Skips
// loudly when no database answers.

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts).
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = join(ROOT, "supabase/migrations/20261009161500_quickbooks-for-real.sql");
const PROOF = join(ROOT, "tests/sql/quickbooks-for-real.proof.sql");
const DB_URL =
  process.env.WEBHOOKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

function findPsql(): string | null {
  for (const p of [
    "psql",
    "/opt/homebrew/opt/libpq/bin/psql",
    "/opt/homebrew/opt/postgresql@18/bin/psql",
    "/opt/homebrew/opt/postgresql@17/bin/psql",
    "/usr/local/opt/libpq/bin/psql",
  ]) {
    if (spawnSync(p, ["--version"], { encoding: "utf8" }).status === 0) return p;
  }
  return null;
}

const psql = findPsql();
const reachable =
  !!psql &&
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], { encoding: "utf8", timeout: 5_000 }).stdout?.trim() === "1";

if (!reachable) {
  console.warn(
    `\n  SKIPPED: the QuickBooks isolation proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n`,
  );
}

describe.skipIf(!reachable)("QuickBooks data, in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("shows each business only its own connection and log, and no browser session the tokens", () => {
    let r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
      encoding: "utf8",
      timeout: 300_000,
    });
    for (let i = 0; i < 2 && /deadlock detected/.test(`${r.stdout}${r.stderr}`); i++) {
      r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
        encoding: "utf8",
        timeout: 300_000,
      });
    }
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(4);
    expect(out).toMatch(/ALL QUICKBOOKS PROOFS PASSED/);
  });
});
