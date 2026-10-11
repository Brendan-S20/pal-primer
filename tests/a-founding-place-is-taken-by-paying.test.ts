// A founding place is taken by paying (owner, 2026-10-10; spec NP-2).
//
// claim_founding_place is what the platform webhook and refreshBillingStatus
// call when a LAUNCH20 subscription is first seen PAID. It is proved here
// against a real Postgres rather than read off the migration.
// tests/sql/a-founding-place-is-taken-by-paying.proof.sql applies the
// migration inside a transaction and proves that
//
//   * the first FOUNDING_SPOTS paid accounts take places 1..FOUNDING_SPOTS in
//     order, and the next one gets none (a row with place NULL, which the app
//     answers by taking the discount off that subscription in Stripe);
//   * an account is answered once: a second sighting (the webhook AND the
//     refresh) returns the same place, and a late payer stays late;
//   * `place` is unique, so not even a writer that skipped the function's
//     lock can hold a place twice;
//   * only the service role can take a place,
//
// and then ROLLS BACK, so nothing is left on a shared stack. The number of
// places is FOUNDING_SPOTS, passed in, as the app passes it.
import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FOUNDING_SPOTS } from "@/lib/founding-offer";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts),
// so on a loaded runner one can take minutes without being hung.
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const DB_URL =
  process.env.FOUNDING_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const MIGRATION = join(ROOT, "supabase/migrations/20261010120000_a-founding-place-is-taken-by-paying.sql");
const PROOF = join(ROOT, "tests/sql/a-founding-place-is-taken-by-paying.proof.sql");

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
    `\n  SKIPPED: the founding-place proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set FOUNDING_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("founding places, in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("gives places 1..20 to paid accounts in order, none after, once each, never twice", () => {
    const r = spawnSync(
      psql!,
      [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-v", `spots=${FOUNDING_SPOTS}`, "-f", PROOF],
      { encoding: "utf8", timeout: 300_000 },
    );
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(5);
    expect(out).toMatch(new RegExp(`ok: the first ${FOUNDING_SPOTS} paid accounts take places 1\\.\\.${FOUNDING_SPOTS}`));
    expect(out).toMatch(/ALL FOUNDING PLACE PROOFS PASSED/);

    const left = spawnSync(
      psql!,
      [DB_URL, "-XAtc", "select count(*) from public.organizations where name like 'Founding Proof %'"],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  });
});
