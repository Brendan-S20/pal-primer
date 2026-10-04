// Auto-routing runs in the background: the database half.
//
// tests/sql/routing-runs-in-the-background.proof.sql applies the migration
// inside a transaction, builds two tenants (an owner, a dispatcher and a
// technician who runs routes in one; an owner in the other) and two days of
// stops, and proves that
//
//   * a press records a queued run, a retried press attaches to itself, and a
//     second press -- another person's, another range -- attaches to the
//     active run instead of starting a second planner over the same visits;
//   * only the person who started a run can move, save or finish it, and a
//     technician, another organization and anon can see or start none of it;
//   * the table is read-only to the API: every write is a function;
//   * the write is WHOLE: a call refused part-way through (a day outside the
//     run, after a valid day apply_route_plan had already written) leaves
//     nothing behind and does not stamp the run saved; a day apply_route_plan
//     itself refuses is reported and the other days stand; and a run saves
//     once;
//   * a run finishes once, carries watched_at for the push decision, and is
//     listed until its starter has looked at it -- and only the starter can
//     clear it;
//   * "succeeded" requires the save;
//   * a run whose heartbeat stopped is declared abandoned by the next press
//     and by the poll, frees the organization's slot, and can write nothing
//     afterwards,
//
// and then ROLLS BACK.
//
// When no database is reachable it says so loudly and skips. It is NOT run
// against the shared local stack by hand: that stack is the one CI's test job
// runs every PR's proofs against (CLAUDE.md), so this runs in CI, or against
// a stack of your own via ROUTING_RUNS_PROOF_DB_URL.

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts),
// so on a loaded runner one can take minutes without being hung.
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = join(ROOT, "supabase/migrations/20261004160000_routing-runs-in-the-background.sql");
const PROOF = join(ROOT, "tests/sql/routing-runs-in-the-background.proof.sql");
const DB_URL =
  process.env.ROUTING_RUNS_PROOF_DB_URL ??
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
    `\n  SKIPPED: the routing-run proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set ROUTING_RUNS_PROOF_DB_URL to run them.\n",
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

describe.skipIf(!reachable)("routing runs hold in a real database", () => {
  it("has the files it runs", () => {
    for (const f of [MIGRATION, PROOF]) expect(existsSync(f), f).toBe(true);
  });

  it("proves every rule, and leaves nothing behind", () => {
    const r = runProof([DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF]);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    // Twelve groups, each announcing itself only when it passed.
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(12);
    expect(out).toMatch(/ALL ROUTING RUN PROOFS PASSED/);

    const left = spawnSync(
      psql!,
      [DB_URL, "-XAtc", "select count(*) from public.organizations where name like 'Runs Proof %'"],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  });
});
