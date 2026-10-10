// A visit knows its service: the database half.
//
// tests/sql/a-visit-knows-its-service.proof.sql builds three businesses BEFORE
// it applies the migrations (one that runs pet waste with a plan and three
// visits, one that only walks dogs, one created after P1's seed with no
// service at all), applies 20261009230000 and 20261009230100 (and, on a stack that
// lacks them, service lines and P1 first) inside a transaction, and proves that
//
//   * the backfill points every plan and visit at its business's "Pet waste
//     removal", and gives the business that had none its default;
//   * a business created now gets exactly one default service, active only if
//     it runs pet waste; a plan saved without a service gets it; a renamed
//     pet-waste service is not duplicated;
//   * a visit generated from a plan (generate_visits_core) carries the plan's
//     service;
//   * changing a plan's service moves its upcoming scheduled visits and
//     leaves past and canceled ones alone;
//   * another business's service is refused on a plan and a visit, on insert
//     and on update;
//   * a tech cannot change what a visit is, but reads it; the owner can;
//   * route_day_inputs and apply_route_plan give a walk its service's minutes
//     and a cleanup its yard's;
//   * a sold service cannot be deleted, and deleting a whole business still
//     cascades,
//
// and then ROLLS BACK. Every group was mutation-tested: removing the plan
// copy, the cross-org check, the tech guard, the organizations trigger, the
// plan-change propagation or the service duration each fails its group.
//
// When no database is reachable it says so loudly and skips. It is NOT run
// against the shared local stack by hand: that stack is the one CI's test job
// runs every PR's proofs against (CLAUDE.md), so this runs in CI, or against
// a stack of your own via VISIT_SERVICE_PROOF_DB_URL.

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts),
// so on a loaded runner one can take minutes without being hung.
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
// The two bases the proof applies first, each only on a stack built before it
// (CI's shared stack follows main): service lines (#358), then the catalog
// itself (#381).
const LINES = join(
  ROOT,
  "supabase/migrations/20261008120000_a-dog-walker-should-not-have-to-learn-about-dump-sites.sql",
);
const P1 = join(ROOT, "supabase/migrations/20261009200000_a-walk-is-not-a-cleanup.sql");
const MIGRATION = join(ROOT, "supabase/migrations/20261009230000_a-visit-knows-its-service.sql");
const DURATIONS = join(
  ROOT,
  "supabase/migrations/20261009230100_a-walk-takes-as-long-as-the-walk.sql",
);
const PROOF = join(ROOT, "tests/sql/a-visit-knows-its-service.proof.sql");
const DB_URL =
  process.env.VISIT_SERVICE_PROOF_DB_URL ??
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
    `\n  SKIPPED: the visit-service proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set VISIT_SERVICE_PROOF_DB_URL to run them.\n",
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

describe.skipIf(!reachable)("a visit knows its service, in a real database", () => {
  it("has the files it runs", () => {
    for (const f of [LINES, P1, MIGRATION, DURATIONS, PROOF]) expect(existsSync(f), f).toBe(true);
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
      `migration=${MIGRATION}`,
      "-v",
      `durations=${DURATIONS}`,
      "-f",
      PROOF,
    ]);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    // Eight groups, each announcing itself only when it passed.
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(8);
    expect(out).toMatch(/ALL VISIT-SERVICE PROOFS PASSED/);

    const left = spawnSync(
      psql!,
      [
        DB_URL,
        "-XAtc",
        "select count(*) from public.organizations where name like 'Visit Service Proof %'",
      ],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  });
});
