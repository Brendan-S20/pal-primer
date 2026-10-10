// An account the app never locks is never deleted (owner, 2026-10-10).
//
// Accounts created before TRIAL_ENFORCEMENT_FROM (2026-08-16) keep full access
// after their plan ends, and are NEVER deletion candidates. Until 2026-10-10
// account_deletion_candidates gated only its trial_ended branch on that date,
// so a cancelled pre-cutoff account, which the app leaves open, would have had
// its data deleted at deploy + 30.
//
// Two halves:
//
//   * the date. SQL cannot import a TypeScript constant, so the migration
//     writes it once, in public.trial_enforcement_from(), and this file fails
//     if that copy stops matching TRIAL_ENFORCEMENT_FROM;
//   * the behaviour, in a real Postgres. tests/sql/a-grandfathered-account-
//     is-never-deleted.proof.sql applies the migration inside a transaction,
//     inserts the matrix below, and prints every candidate. Each row is then
//     compared with the app's own accountLockFor: an account is a candidate
//     exactly when the app locks it, for the same reason. It also proves the
//     pre-cutoff plan-ended account is refused by purge_locked_account itself
//     (dry and real, and even with a candidate list broken to list everyone),
//     and that the post-cutoff cases are still candidates and still purged.
//     Then it ROLLS BACK.
import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { accountLockFor, type LockInput } from "@/lib/account-lock";
import { TRIAL_ENFORCEMENT_FROM } from "@/lib/trial";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts),
// so on a loaded runner one can take minutes without being hung.
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const DB_URL =
  process.env.GRANDFATHER_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20261009170000_a-locked-account-is-deleted-after-thirty-days.sql",
);
const PROOF = join(ROOT, "tests/sql/a-grandfathered-account-is-never-deleted.proof.sql");
// The proof reads candidates at this moment, with this deploy date.
const NOW = new Date("2026-10-20T12:00:00Z");

describe("the grandfather date is written once in SQL, and it is the app's", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  const code = sql.replace(/--[^\n]*/g, "");

  it("trial_enforcement_from() returns midnight UTC on TRIAL_ENFORCEMENT_FROM", () => {
    const m = code.match(
      /FUNCTION public\.trial_enforcement_from\(\)[\s\S]*?AS \$\$ SELECT timestamptz '(\d{4}-\d{2}-\d{2}) 00:00:00\+00' \$\$;/,
    );
    expect(m, "trial_enforcement_from() is not defined as a single timestamptz literal").not.toBeNull();
    expect(m![1]).toBe(TRIAL_ENFORCEMENT_FROM);
  });

  it("no other line of SQL in the migration writes a date of its own", () => {
    const dates = code.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
    expect(dates).toEqual([TRIAL_ENFORCEMENT_FROM]);
  });

  it("both functions read it", () => {
    expect(code).toMatch(/org\.created_at >= public\.trial_enforcement_from\(\)/);
    expect(code).toMatch(/_created < public\.trial_enforcement_from\(\)/);
  });
});

// ── The matrix: every way an organization can look to both sides ──────────

type Fixture = LockInput & { name: string };

const CREATED = {
  "pre-cutoff": "2026-08-01T00:00:00Z",
  "a second before": "2026-08-15T23:59:59Z",
  "at the cutoff": "2026-08-16T00:00:00Z",
  "post-cutoff": "2026-09-17T00:00:00Z",
} as const;

const STATES: Record<string, Omit<LockInput, "created_at">> = {
  "trial ended": { plan_status: "trialing", billing_status: "trialing", trial_ends_at: "2026-10-01T00:00:00Z", stripe_subscription_id: null },
  "trial ended, free": { plan_status: "free", billing_status: "free", trial_ends_at: "2026-10-01T00:00:00Z", stripe_subscription_id: null },
  "trial running": { plan_status: "trialing", billing_status: "trialing", trial_ends_at: "2026-10-25T00:00:00Z", stripe_subscription_id: null },
  "plan ended": { plan_status: "canceled", billing_status: "canceled", trial_ends_at: "2026-09-01T00:00:00Z", stripe_subscription_id: "sub_old", current_period_end: "2026-10-10T00:00:00Z" },
  "plan ended, billing only": { plan_status: "free", billing_status: "canceled", trial_ends_at: null, stripe_subscription_id: "sub_old", current_period_end: "2026-10-10T00:00:00Z" },
  "plan ended, plan only": { plan_status: "canceled", billing_status: "active", trial_ends_at: null, stripe_subscription_id: "sub_old", current_period_end: "2026-10-10T00:00:00Z" },
  "plan ended, no end date": { plan_status: "canceled", billing_status: "canceled", trial_ends_at: null, stripe_subscription_id: null, current_period_end: null },
  paying: { plan_status: "active", billing_status: "active", trial_ends_at: "2026-09-01T00:00:00Z", stripe_subscription_id: "sub_live" },
  "past due": { plan_status: "past_due", billing_status: "past_due", trial_ends_at: "2026-09-01T00:00:00Z", stripe_subscription_id: "sub_live" },
  grace: { plan_status: "free", billing_status: "grace", trial_ends_at: "2026-09-01T00:00:00Z", stripe_subscription_id: null },
  "trial ended, subscription id": { plan_status: "trialing", billing_status: "trialing", trial_ends_at: "2026-10-01T00:00:00Z", stripe_subscription_id: "sub_pending" },
  "no trial clock": { plan_status: "free", billing_status: "free", trial_ends_at: null, stripe_subscription_id: null },
  "comped, plan ended": { plan_status: "canceled", billing_status: "canceled", trial_ends_at: null, stripe_subscription_id: "sub_old", current_period_end: "2026-10-10T00:00:00Z", is_comped: true },
  "suspended, plan ended": { plan_status: "canceled", billing_status: "suspended", trial_ends_at: null, stripe_subscription_id: "sub_old", current_period_end: "2026-10-10T00:00:00Z" },
  "suspended_at, plan ended": { plan_status: "canceled", billing_status: "canceled", trial_ends_at: null, stripe_subscription_id: "sub_old", current_period_end: "2026-10-10T00:00:00Z", suspended_at: "2026-10-12T00:00:00Z" },
};

const MATRIX: Fixture[] = Object.entries(CREATED).flatMap(([when, created_at], i) =>
  Object.entries(STATES).map(([state, s], j) => ({
    name: `${when} ${state}`,
    created_at,
    is_comped: false,
    current_period_end: null,
    suspended_at: null,
    ...s,
    // organizations.stripe_subscription_id is unique.
    stripe_subscription_id: s.stripe_subscription_id ? `${s.stripe_subscription_id}_${i}_${j}` : null,
  })),
);

describe("the matrix, on the app's side alone", () => {
  it("a pre-cutoff account whose plan has ended keeps full access", () => {
    const f = MATRIX.find((m) => m.name === "pre-cutoff plan ended")!;
    expect(accountLockFor(f, NOW)).toEqual({ locked: false });
    expect(accountLockFor(MATRIX.find((m) => m.name === "post-cutoff plan ended")!, NOW)).toMatchObject({
      locked: true,
      reason: "plan_ended",
    });
  });
});

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
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], { encoding: "utf8", timeout: 5_000 }).stdout?.trim() ===
    "1";

if (!reachable) {
  console.warn(
    `\n  SKIPPED: the grandfather proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set GRANDFATHER_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("deletion candidates, in a real database, against the app's lock", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("is a candidate exactly when the app locks it, and never before the cutoff", () => {
    const r = spawnSync(
      psql!,
      [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-v", `fixtures=${JSON.stringify(MATRIX)}`, "-f", PROOF],
      { encoding: "utf8", timeout: 300_000 },
    );
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(5);
    expect(out).toMatch(/ALL GRANDFATHER PROOFS PASSED/);

    const sqlSays = new Map(
      [...out.matchAll(/NOTICE:\s+cand\|([^|\n]+)\|(\w+)/g)].map((m) => [m[1], m[2]]),
    );
    expect(sqlSays.size).toBe(MATRIX.length);
    const disagreements: string[] = [];
    for (const f of MATRIX) {
      const lock = accountLockFor(f, NOW);
      const app = lock.locked ? lock.reason : "none";
      if (sqlSays.get(f.name) !== app) disagreements.push(`${f.name}: app ${app}, sql ${sqlSays.get(f.name)}`);
      if (Date.parse(f.created_at!) < Date.parse(`${TRIAL_ENFORCEMENT_FROM}T00:00:00Z`)) {
        expect(sqlSays.get(f.name), f.name).toBe("none");
      }
    }
    expect(disagreements).toEqual([]);
    // The matrix is not vacuous: both reasons appear on both sides.
    expect([...sqlSays.values()]).toEqual(expect.arrayContaining(["trial_ended", "plan_ended", "none"]));

    const left = spawnSync(
      psql!,
      [DB_URL, "-XAtc", "select count(*) from public.organizations where name like 'Grandfather Proof %'"],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  });
});
