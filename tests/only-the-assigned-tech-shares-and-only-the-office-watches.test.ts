// Only the assigned tech shares, and only the office watches.
//
// The live-tracking rules, proved in a real Postgres. Reading the migration's
// text is not enough: a policy can name the right function and still let the
// wrong row through, a trigger can be attached to the wrong column, and a
// grant can be undone by a default privilege. So this runs
// tests/sql/nobody-could-see-the-truck-coming.proof.sql against the local
// Supabase stack: it applies the migration inside a transaction, builds two
// tenants, and proves as postgres, anon, an owner and three technicians that
//
//   * the assigned tech writes one latest row, inside the window only, with
//     recorded_at on the database's clock,
//   * a colleague in the same org cannot read, write, move or delete it, and
//     cannot write it under the assigned tech's staff id,
//   * a tech in another org can do none of that either,
//   * the office reads its own org's rows and cannot forge a position,
//   * anon can neither read the table nor call the public function,
//   * the link refuses an unknown token and one whose message never went,
//     and shows a position rounded to 3 places while en route,
//   * Stop deletes the position and refuses the next,
//   * starting the visit deletes it, and the link then says "arrived" with
//     nobody's location on it, and after completion nothing,
//   * turning tracking off and the nightly prune leave nothing behind,
//   * a new organization starts with tracking off,
//
// and then ROLLS BACK, the migration included, so nothing is left on a shared
// stack.
//
// When no database is reachable (CI's unit job, a laptop without Docker) it
// says so loudly and skips. A skip that looks like a pass is the failure
// CLAUDE.md describes for migrations.
import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts),
// so on a loaded runner one can take minutes without being hung.
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const DB_URL =
  process.env.LIVE_TRACKING_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const MIGRATION = join(ROOT, "supabase/migrations/20260929100000_nobody-could-see-the-truck-coming.sql");
const PROOF = join(ROOT, "tests/sql/nobody-could-see-the-truck-coming.proof.sql");

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
    `\n  SKIPPED: the live-tracking proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set LIVE_TRACKING_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("the live-tracking rules hold in a real database", () => {
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
    expect(out).toMatch(/ALL LIVE TRACKING PROOFS PASSED/);

    const left = spawnSync(
      psql!,
      [
        DB_URL,
        "-XAtc",
        "select count(*) from public.organizations where name like 'Track Proof %'",
      ],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  });
});
