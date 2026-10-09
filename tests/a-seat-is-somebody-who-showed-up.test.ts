// A seat is somebody who showed up.
//
// The owner's decision (2026-10-09): an active employee for billing is anyone
// who used their login at least once during the billing period, in any role.
// supabase/migrations/20261009130000_a-seat-is-somebody-who-showed-up.sql adds
// the ledger that records a sighting and the count Stripe is told, and
// tests/sql/a-seat-is-somebody-who-showed-up.proof.sql drives it as an owner,
// techs, a leaver, a never-signed-in hire, an impersonation session, a
// platform admin and a half-signed-in two-step user, then rolls it all back.
//
// It was mutation-tested when it landed: dropping the impersonation check, or
// filtering the count on `staff.active` (which would let a leaver drop off the
// bill for a period they worked), each fails it.
//
// When no database is reachable it says so loudly and skips. It does not run
// in an ordinary `vitest run` on a laptop with no local stack, and it must not
// be pointed at the shared stack by hand while CI is using it; CI's test job
// runs it.

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts),
// so on a loaded runner one can take minutes without being hung.
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20261009130000_a-seat-is-somebody-who-showed-up.sql",
);
const PROOF = join(ROOT, "tests/sql/a-seat-is-somebody-who-showed-up.proof.sql");
const DB_URL =
  process.env.SEATS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

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
    `\n  SKIPPED: the seat proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set SEATS_PROOF_DB_URL to run them.\n",
  );
}

/** Run the proof, again if and only if Postgres chose it as a deadlock victim. */
function runProof(args: string[]) {
  let r = spawnSync(psql!, args, { encoding: "utf8", timeout: 300_000 });
  for (let i = 0; i < 2 && /deadlock detected/.test(`${r.stdout}${r.stderr}`); i++) {
    r = spawnSync(psql!, args, { encoding: "utf8", timeout: 300_000 });
  }
  return r;
}

describe("the files the proof runs", () => {
  it("exist", () => {
    for (const f of [MIGRATION, PROOF]) expect(existsSync(f), f).toBe(true);
  });

  it("writes every decision down where the next person will read it", () => {
    // The edges are decisions, not accidents, and the migration is where
    // somebody changing the rule will look first.
    const sql = readFileSync(MIGRATION, "utf8");
    for (const edge of [
      /then deactivated: COUNTS for this period/,
      /brand-new hire/,
      /The owner: counts like anybody else/,
      /impersonation session/i,
      /demo org/,
      /offline tech/i,
    ]) {
      expect(sql, String(edge)).toMatch(edge);
    }
  });
});

describe.skipIf(!reachable)("who counts as a seat, in a real database", () => {
  it("proves every rule, and leaves nothing behind", () => {
    const r = runProof([DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF]);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    // Fourteen groups, each announcing itself only when it passed.
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(14);
    expect(out).toMatch(/ALL SEAT PROOFS PASSED/);

    const left = spawnSync(
      psql!,
      [
        DB_URL,
        "-XAtc",
        "select count(*) from public.organizations where name like 'Seats Proof %'",
      ],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  }, 600_000);
});
