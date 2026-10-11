// A window is kept and a skill is matched (appointment routing, phase 4): the
// database half.
//
// tests/sql/a-window-is-kept-and-a-skill-is-matched.proof.sql builds one
// business with a walker and a scooper, applies 20261010200000 (and, on a
// stack that lacks them, service lines, the catalog, P2 and the durations
// first) inside a transaction, and proves that
//
//   * members read their business's skills; the owner gives and takes them;
//     a tech, another business's owner and anon cannot; a skill cannot name
//     another business's service; there is no UPDATE;
//   * route_day_inputs carries each technician's skills (null when none, so
//     a business with no skills set routes as before) and each visit's
//     service and client;
//   * apply_route_plan takes a list of stops left out on purpose, writes
//     them as unassigned (no order, no time, and no technician with
//     reassign), refuses a stop both routed and left out, and still refuses
//     a plan that leaves a stop out without saying so;
//   * apply_route_plans passes each day's list through,
//
// and then ROLLS BACK.
//
// When no database is reachable it says so loudly and skips. It is NOT run
// against the shared local stack by hand: that stack is the one CI's test job
// runs every PR's proofs against (CLAUDE.md), so this runs in CI, or against
// a stack of your own via WINDOW_SKILL_PROOF_DB_URL.

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts),
// so on a loaded runner one can take minutes without being hung.
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const M = (f: string) => join(ROOT, "supabase/migrations", f);
const LINES = M("20261008120000_a-dog-walker-should-not-have-to-learn-about-dump-sites.sql");
const P1 = M("20261009200000_a-walk-is-not-a-cleanup.sql");
const P2 = M("20261009230000_a-visit-knows-its-service.sql");
const DURATIONS = M("20261009230100_a-walk-takes-as-long-as-the-walk.sql");
const MIGRATION = M("20261010200000_a-window-is-kept-and-a-skill-is-matched.sql");
const PROOF = join(ROOT, "tests/sql/a-window-is-kept-and-a-skill-is-matched.proof.sql");
const DB_URL =
  process.env.WINDOW_SKILL_PROOF_DB_URL ??
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
    timeout: 30_000,
  }).stdout?.trim() === "1";

if (!reachable) {
  console.warn(
    `\n  SKIPPED: the window-and-skill proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set WINDOW_SKILL_PROOF_DB_URL to run them.\n",
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

describe.skipIf(!reachable)("a window is kept and a skill is matched, in a real database", () => {
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
    // Four groups, each announcing itself only when it passed.
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(4);
    expect(out).toMatch(/ALL WINDOW-AND-SKILL PROOFS PASSED/);

    const left = spawnSync(
      psql!,
      [
        DB_URL,
        "-XAtc",
        "select count(*) from public.organizations where name like 'Skills Proof %'",
      ],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  });
});
