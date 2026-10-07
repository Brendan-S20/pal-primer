// One decline counts once: the database half.
//
// tests/sql/one-decline-counts-once.proof.sql applies the migration inside a
// transaction, builds two tenants (one pausing at 3 declines, one at 5) and
// four clients, and proves that count_autopay_decline
//
//   * counts one PaymentIntent reported three times once;
//   * counts one PaymentIntent reported by the nightly run and the webhook
//     once, and the duplicate changes nothing on the client;
//   * counts two distinct PaymentIntents twice;
//   * pauses at exactly the org's threshold of distinct declines (3, and 5);
//   * after a success resets the count, ignores a redelivery of an old
//     decline and counts a new one from 1;
//   * counts a failure with no PaymentIntent (the nightly run's "never reached
//     Stripe") once per call;
//   * never lifts a pause;
//   * keeps the last fifty PaymentIntents and no more;
//   * is executable by the service role only;
//   * refuses an unknown client,
//
// and then ROLLS BACK.
//
// When no database is reachable it says so loudly and skips. It is NOT run
// against the shared local stack by hand: that stack is the one CI's test job
// runs every PR's proofs against (CLAUDE.md), so this runs in CI, or against
// a stack of your own via ONE_DECLINE_PROOF_DB_URL.

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts),
// so on a loaded runner one can take minutes without being hung.
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = join(ROOT, "supabase/migrations/20261007140000_one-decline-counts-once.sql");
const PROOF = join(ROOT, "tests/sql/one-decline-counts-once.proof.sql");
const DB_URL =
  process.env.ONE_DECLINE_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

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
    `\n  SKIPPED: the decline-count proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set ONE_DECLINE_PROOF_DB_URL to run them.\n",
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

describe.skipIf(!reachable)("one decline counts once in a real database", () => {
  it("has the files it runs", () => {
    for (const f of [MIGRATION, PROOF]) expect(existsSync(f), f).toBe(true);
  });

  it("proves every rule, and leaves nothing behind", () => {
    const r = runProof([DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF]);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    // Ten groups, each announcing itself only when it passed.
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(10);
    expect(out).toMatch(/ALL DECLINE-COUNT PROOFS PASSED/);

    const left = spawnSync(
      psql!,
      [
        DB_URL,
        "-XAtc",
        "select count(*) from public.organizations where name like 'Decline Proof %'",
      ],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  });
});
