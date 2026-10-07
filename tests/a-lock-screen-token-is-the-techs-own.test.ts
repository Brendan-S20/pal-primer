// A Live Activity push token is the tech's own, in their own business.
//
// supabase/migrations/20261004120000_the-route-on-the-lock-screen.sql adds
// live_activity_tokens: the APNs token iOS gives the route on a tech's lock
// screen, which the server pushes to when the office changes that tech's day.
// A token in the wrong hands is a way to put text on somebody else's lock
// screen, so who may write one is proved here against a real Postgres:
// tests/sql/the-route-on-the-lock-screen.proof.sql applies the migration
// inside a transaction, drives it as two techs, a signed-out caller and the
// service role, and rolls everything back.
//
// When no database is reachable it says so loudly and skips. It does not run
// in an ordinary `vitest run` on a laptop with no local stack, and it must
// not be pointed at the shared stack by hand while CI is using it; CI's test
// job runs it.

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts),
// so on a loaded runner one can take minutes without being hung.
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = join(ROOT, "supabase/migrations/20261004120000_the-route-on-the-lock-screen.sql");
const PROOF = join(ROOT, "tests/sql/the-route-on-the-lock-screen.proof.sql");
const DB_URL =
  process.env.LIVE_ACTIVITY_PROOF_DB_URL ??
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
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], { encoding: "utf8", timeout: 30_000 }).stdout?.trim() ===
    "1";

if (!reachable) {
  console.warn(
    `\n  SKIPPED: the live activity token proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set LIVE_ACTIVITY_PROOF_DB_URL to run them.\n",
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
});

describe.skipIf(!reachable)("a lock screen token is the tech's own, in a real database", () => {
  it("proves every rule, and leaves nothing behind", () => {
    const r = runProof([DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF]);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    // Six groups, each announcing itself only when it passed.
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(6);
    expect(out).toMatch(/ALL LIVE ACTIVITY TOKEN PROOFS PASSED/);

    const left = spawnSync(
      psql!,
      [DB_URL, "-XAtc", "select count(*) from public.organizations where name like 'Lock Screen Proof %'"],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  }, 600_000);
});
