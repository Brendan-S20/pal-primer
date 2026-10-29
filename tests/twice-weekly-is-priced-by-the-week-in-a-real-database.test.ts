// Twice-weekly is priced by the week (#572, F-07): the database half.
//
// tests/sql/twice-weekly-is-priced-by-the-week.proof.sql builds a business on
// the shipped multipliers and one with a hand-set twice-weekly, measures the
// fault through public_quote ($45 a visit, $90 a week against a $25 weekly
// plan), applies 20261029120000 inside a transaction, and proves that
//
//   * public_quote now prices twice-weekly at $22.50 a visit, $45 a week,
//     1.8x the weekly plan, and biweekly and monthly as before;
//   * the shipped 1.8 is 0.9, a hand-set value is left alone, and a new
//     business starts at 0.9;
//   * the owner can set each cadence and the public quote follows it, a
//     twice-weekly visit above the weekly price is refused, and nobody but
//     that business's owner or office manager can write,
//
// and then ROLLS BACK.
//
// When no database is reachable it says so loudly and skips. It is NOT run
// against the shared local stack by hand: that stack is the one CI's test job
// runs every PR's proofs against (CLAUDE.md), so this runs in CI, or against
// a stack of your own via TWICE_WEEKLY_PROOF_DB_URL.

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts),
// so on a loaded runner one can take minutes without being hung.
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20261029120000_twice-weekly-is-priced-by-the-week.sql",
);
const PROOF = join(ROOT, "tests/sql/twice-weekly-is-priced-by-the-week.proof.sql");
const DB_URL =
  process.env.TWICE_WEEKLY_PROOF_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

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
    // Generous: a shared local stack busy with other proofs has been measured
    // taking 3-20 seconds to accept a connection.
    timeout: 30_000,
  }).stdout?.trim() === "1";

if (!reachable) {
  console.warn(
    `\n  SKIPPED: the twice-weekly proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set TWICE_WEEKLY_PROOF_DB_URL to run them.\n",
  );
}

/** Run the proof, again if and only if Postgres chose it as a deadlock victim
 *  (another proof re-applying a migration can cross it). */
function runProof(args: string[]) {
  let r = spawnSync(psql!, args, { encoding: "utf8", timeout: 300_000 });
  for (let i = 0; i < 2 && /deadlock detected/.test(`${r.stdout}${r.stderr}`); i++) {
    r = spawnSync(psql!, args, { encoding: "utf8", timeout: 300_000 });
  }
  return r;
}

describe.skipIf(!reachable)("twice-weekly is priced by the week, in a real database", () => {
  it("has the files it runs", () => {
    for (const f of [MIGRATION, PROOF]) expect(existsSync(f), f).toBe(true);
  });

  it("proves every rule, and leaves nothing behind", () => {
    const r = runProof([DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF]);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    // Four groups, each announcing itself only when it passed.
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(4);
    expect(out).toMatch(/ALL TWICE-WEEKLY PROOFS PASSED/);

    const left = spawnSync(
      psql!,
      [
        DB_URL,
        "-XAtc",
        "select count(*) from public.organizations where name like 'Twice Weekly Proof %'",
      ],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  });
});
