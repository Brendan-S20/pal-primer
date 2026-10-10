// Five walks a week (the service catalog, phase 3): the database half.
//
// tests/sql/five-walks-a-week.proof.sql builds one business that scoops and
// walks, generates seven pet-waste plans of every older cadence with the
// generator as it was, applies 20261010010000 (and, on a stack that lacks
// them, service lines, the catalog and P2 first) inside a transaction, and
// proves that
//
//   * every older cadence generates exactly what it did before, date for date,
//     and the weekly plan's dates also match a hand-written list;
//   * a Monday-to-Friday plan generates five walks a week, none on a weekend,
//     each carrying the plan's walk service (P2's trigger);
//   * generating again inserts nothing;
//   * a blackout and a client hold are skipped, not shifted;
//   * a plan with a past start walks from the business's today, never before;
//   * a walk moved to another day does not grow back on its old day;
//   * changing the days removes upcoming walks only on days that went, keeps
//     the rest, and adds new days on the next run; clearing the set makes the
//     plan weekly again;
//   * an empty, repeated, out-of-range or NULL day is refused, and so is a set
//     on anything but plain weekly;
//   * a completed walk is stamped with the plan's per-visit price,
//
// and then ROLLS BACK.
//
// When no database is reachable it says so loudly and skips. It is NOT run
// against the shared local stack by hand: that stack is the one CI's test job
// runs every PR's proofs against (CLAUDE.md), so this runs in CI, or against
// a stack of your own via FIVE_WALKS_PROOF_DB_URL.

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts),
// so on a loaded runner one can take minutes without being hung.
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const M = (f: string) => join(ROOT, "supabase/migrations", f);
// The bases the proof applies first, each only on a stack built before it
// (CI's shared stack follows main): service lines (#358), the catalog (#381),
// then service_id on plans and visits and its durations (#384).
const LINES = M("20261008120000_a-dog-walker-should-not-have-to-learn-about-dump-sites.sql");
const P1 = M("20261009200000_a-walk-is-not-a-cleanup.sql");
const P2 = M("20261009230000_a-visit-knows-its-service.sql");
const DURATIONS = M("20261009230100_a-walk-takes-as-long-as-the-walk.sql");
const MIGRATION = M("20261010010000_five-walks-a-week.sql");
const PROOF = join(ROOT, "tests/sql/five-walks-a-week.proof.sql");
const DB_URL =
  process.env.FIVE_WALKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

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
    `\n  SKIPPED: the five-walks proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set FIVE_WALKS_PROOF_DB_URL to run them.\n",
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

describe.skipIf(!reachable)("five walks a week, in a real database", () => {
  it("has the files it runs", () => {
    for (const f of [LINES, P1, P2, DURATIONS, MIGRATION, PROOF])
      expect(existsSync(f), f).toBe(true);
  });

  it("proves every rule, and leaves nothing behind", () => {
    const r = runProof([
      DB_URL,
      "-X",
      "-v",
      `lines=${LINES}`,
      "-v",
      `p1=${P1}`,
      "-v",
      `p2=${P2}`,
      "-v",
      `durations=${DURATIONS}`,
      "-v",
      `migration=${MIGRATION}`,
      "-f",
      PROOF,
    ]);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    // Ten groups, each announcing itself only when it passed.
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(10);
    expect(out).toMatch(/ALL FIVE-WALKS PROOFS PASSED/);

    const left = spawnSync(
      psql!,
      [
        DB_URL,
        "-XAtc",
        "select count(*) from public.organizations where name like 'Five Walks Proof %'",
      ],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  });
});
