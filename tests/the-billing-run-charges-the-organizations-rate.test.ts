// Sales tax, proved in a real Postgres.
//
// The other sales-tax tests read the migration's text and exercise the
// TypeScript twin. Text can describe a splice that did not take, a trigger
// that does not fire, or a settlement whose arithmetic does not close, and
// still match every regex. So this runs
// tests/sql/tax-was-always-zero-and-could-not-be-anything-else.proof.sql
// against the local Supabase stack: it applies the migration inside a
// transaction, builds a taxed business, an exempt client, a business at zero
// and a franchise, and proves that
//
//   * the billing run taxes the whole subtotal once at the org's rate,
//   * an exempt client's invoice carries rate 0 and no tax,
//   * at a zero rate the invoice is exactly its subtotal,
//   * a later rate or exemption change does not re-price an issued invoice,
//   * each payment carries its pro-rata tax share, filled by the database,
//   * the royalty is on revenue excluding tax, and the franchise passes the
//     tax it collected to the location,
//   * a portal top-up is taxed, grants the pre-tax credit, and a full refund
//     takes back exactly that,
//   * nobody signed in can call the writer,
//
// and then ROLLS BACK, the migration included, so nothing is left on a
// shared stack.
//
// When no database is reachable (CI's unit job, a laptop without Docker) it
// says so loudly and skips: "the proof passed" and "no proof was run" must not
// read the same.
import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts),
// so on a loaded runner one can take minutes without being hung.
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const DB_URL =
  process.env.SALES_TAX_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20260929110000_tax-was-always-zero-and-could-not-be-anything-else.sql",
);
const PROOF = join(ROOT, "tests/sql/tax-was-always-zero-and-could-not-be-anything-else.proof.sql");

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
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], { encoding: "utf8", timeout: 5_000 }).stdout?.trim() ===
    "1";

if (!reachable) {
  console.warn(
    `\n  SKIPPED: the sales-tax proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set SALES_TAX_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("sales tax holds in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("proves every rule, and leaves nothing behind", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
      encoding: "utf8",
      timeout: 300_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    // Eight groups of checks, each announcing itself only when it passed.
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(8);
    expect(out).toMatch(/ALL SALES TAX PROOFS PASSED/);

    const left = spawnSync(
      psql!,
      [DB_URL, "-XAtc", "select count(*) from public.organizations where name like 'Tax Proof %'"],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  });
});
