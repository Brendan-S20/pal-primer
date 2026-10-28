// #569: a trial with four or more people could not add a client, because
// assign_billing_tier_for_org wrote plan_id under a tenant's insert.
import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts).
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const DB_URL =
  process.env.TRIAL_SEATS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20261028140000_a-trial-with-four-people-could-not-add-a-client.sql",
);
const PROOF = join(ROOT, "tests/sql/a-trial-with-four-people-could-not-add-a-client.proof.sql");

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
    `\n  SKIPPED: the trial-seat proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set TRIAL_SEATS_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)(
  "a trial with four or more people adds a client, in a real database",
  () => {
    it("has the files it runs", () => {
      expect(existsSync(MIGRATION)).toBe(true);
      expect(existsSync(PROOF)).toBe(true);
    });

    it("adds, archives and unarchives a client at 4 and 15 people, moves the tier, and leaves nothing behind", () => {
      const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
        encoding: "utf8",
        timeout: 300_000,
      });
      const out = `${r.stdout}\n${r.stderr}`;
      expect(r.status, out).toBe(0);
      expect(out).not.toMatch(/PROOF FAILED/);
      for (const ok of [
        "ok: the migration moves a trial with four people off Launch",
        "ok: a trial with four people adds a client and moves to Growth",
        "ok: the protected columns are still protected after the tier moved",
        "ok: a trial with four people archives and unarchives a client",
        "ok: fifteen people add a client, and the tier follows the team down to Launch",
      ]) {
        expect(out, out).toContain(ok);
      }
      // The bug is reproduced first wherever the stack does not carry the fix
      // yet; where it does, the proof says it skipped that step.
      expect(out).toMatch(/ok: before the fix|SKIPPED \[before\]/);

      const left = spawnSync(
        psql!,
        [
          DB_URL,
          "-XAtc",
          "select count(*) from public.organizations where name = 'Trial Four Proof'",
        ],
        { encoding: "utf8" },
      );
      expect(left.stdout.trim()).toBe("0");
    });
  },
);
