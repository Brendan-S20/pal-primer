// The quote rules, proved in a real Postgres.
//
// tests/a-bid-had-nothing-to-accept.test.ts reads the migration's text. Text
// can describe a lock that does not serialize, a grant that a later default
// privilege undoes, or a trigger that fires as the wrong role, and still
// match every regex. So this runs tests/sql/a-bid-had-nothing-to-accept.proof.sql
// against the local Supabase stack: it applies the migration inside a
// transaction, builds two tenants, and proves as postgres, anon, an owner and
// a technician that
//
//   * numbers come from each org's own counter,
//   * a quote cannot point at another tenant's client or lead,
//   * a line total is quantity x price, rounded as the CHECK rounds,
//   * the link shows nothing for a draft or a stranger, and expiry by date,
//   * accept needs a typed name, happens once, and a second tap returns the
//     first answer; decline likewise; neither can become the other,
//   * an expired, withdrawn, draft or unknown quote cannot be answered,
//   * anon can read neither table and call neither public function,
//   * the office cannot forge an acceptance, edit a sent quote, add a line to
//     one or delete one, and a technician sees nothing,
//
// and then ROLLS BACK, the migration included, so nothing is left on a
// shared stack.
//
// When no database is reachable (CI's unit job, a laptop without Docker) it
// says so loudly and skips. A skip that looks like a pass is the failure
// CLAUDE.md describes for migrations: "the experiment says the leak is closed"
// and "no experiment was run" must not read the same.
import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts),
// so on a loaded runner one can take minutes without being hung.
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const DB_URL =
  process.env.QUOTES_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const MIGRATION = join(ROOT, "supabase/migrations/20260928170000_a-bid-had-nothing-to-accept.sql");
const PROOF = join(ROOT, "tests/sql/a-bid-had-nothing-to-accept.proof.sql");

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
    `\n  SKIPPED: the quote proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set QUOTES_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("the quote rules hold in a real database", () => {
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
    // Ten groups of checks, each announcing itself only when it passed.
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(10);
    expect(out).toMatch(/ALL QUOTE PROOFS PASSED/);

    // And the ROLLBACK really rolled back: no quotes table unless a replay of
    // the migrations made one, and never the proof's fixture tenants.
    const left = spawnSync(
      psql!,
      [
        DB_URL,
        "-XAtc",
        "select count(*) from public.organizations where name like 'Quote Proof %'",
      ],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  });
});
