// Service lines: the database half.
//
// tests/sql/a-dog-walker-should-not-have-to-learn-about-dump-sites.proof.sql
// applies the migration inside a transaction, builds two businesses (an owner
// and a tech in one, an owner in the other) and proves that
// organizations.service_lines
//
//   * starts as {pet_waste} for a new business;
//   * stores every valid set as written;
//   * refuses an empty, unknown, duplicated, NULL-holding, nested or miscased
//     set, and NULL;
//   * is written by the owner through the ordinary org update (updateOwnOrg's
//     path), for their own business only;
//   * cannot be changed by a tech;
//   * gives anon nothing,
//
// and then ROLLS BACK.
//
// When no database is reachable it says so loudly and skips. It is NOT run
// against the shared local stack by hand: that stack is the one CI's test job
// runs every PR's proofs against (CLAUDE.md), so this runs in CI, or against
// a stack of your own via SERVICE_LINES_PROOF_DB_URL.

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
  "supabase/migrations/20261008120000_a-dog-walker-should-not-have-to-learn-about-dump-sites.sql",
);
const PROOF = join(
  ROOT,
  "tests/sql/a-dog-walker-should-not-have-to-learn-about-dump-sites.proof.sql",
);
const DB_URL =
  process.env.SERVICE_LINES_PROOF_DB_URL ??
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
    `\n  SKIPPED: the service-lines proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set SERVICE_LINES_PROOF_DB_URL to run them.\n",
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

describe.skipIf(!reachable)("service lines in a real database", () => {
  it("has the files it runs", () => {
    for (const f of [MIGRATION, PROOF]) expect(existsSync(f), f).toBe(true);
  });

  it("proves every rule, and leaves nothing behind", () => {
    const r = runProof([DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF]);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    // Seven groups, each announcing itself only when it passed.
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(7);
    expect(out).toMatch(/ALL SERVICE-LINES PROOFS PASSED/);

    const left = spawnSync(
      psql!,
      [
        DB_URL,
        "-XAtc",
        "select count(*) from public.organizations where name like 'Service Lines Proof %'",
      ],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  });
});
