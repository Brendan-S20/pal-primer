// A collection is told by the app, which pushes.
//
// 20261004150000 takes the notification out of record_field_collection (a row
// written in SQL lands in the notification centre and can never reach a
// phone) and gives app_notifications the two keys the field's notifications
// are filed under: thread_id (the item) and event_key (the event, unique per
// recipient). And app_notification_prefs a language, so a tech's push is in
// the tech's language.
//
// tests/sql/nothing-in-the-field-told-anyone.proof.sql applies the migration
// that made field collections, proves that it notified from SQL, applies this
// one, and proves that
//
//   * a collection is still recorded, and its replay still answers with the
//     same id (which the app keys its notification on), the function's rules
//     still refuse, and NO notification row is written from SQL;
//   * one event is one row per recipient, ON CONFLICT on exactly
//     (recipient_user_id, event_key) finds the index, any number of keyless
//     rows coexist, and a thread id is bounded;
//   * a person reads only their own notifications;
//   * a person sets their own language without losing their mutes, cannot
//     store a language the app has no words for, and cannot set anyone
//     else's,
//
// then ROLLS BACK. When no database is reachable it says so loudly and skips.
// It is NOT run against the shared local stack from an agent's worktree; CI's
// test job runs it.

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts).
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20261004150000_nothing-in-the-field-told-anyone.sql",
);
const CASH = join(
  ROOT,
  "supabase/migrations/20261002150000_the-cash-a-tech-took-had-nowhere-to-go.sql",
);
const METHODS = join(
  ROOT,
  "supabase/migrations/20260928030000_a-cash-payment-could-not-say-how-it-was-paid.sql",
);
const PROOF = join(ROOT, "tests/sql/nothing-in-the-field-told-anyone.proof.sql");
const DB_URL =
  process.env.FIELD_NOTIFY_PROOF_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

describe("the migration, read", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  const code = sql
    .split("\n")
    .filter((l) => !/^\s*--/.test(l))
    .join("\n");

  it("replaces record_field_collection with a body that writes no notification", () => {
    const fn = code.slice(
      code.indexOf("CREATE OR REPLACE FUNCTION public.record_field_collection("),
    );
    const body = fn.slice(0, fn.indexOf("$function$;"));
    expect(body.length).toBeGreaterThan(1000);
    expect(body).not.toMatch(/app_notifications/);
    // Everything that made it safe came across: the assigned-staff check, the
    // day window, the balance bound, both replay guards, SECURITY DEFINER.
    for (const guard of [
      "s.user_id = _uid",
      "_v.scheduled_on < _today - 3",
      "_amount_cents > _open - _waiting",
      "fc.client_key = _client_key",
      "interval '10 minutes'",
      "SECURITY DEFINER",
      "SET search_path TO 'public', 'pg_temp'",
    ]) {
      expect(body, guard).toContain(guard);
    }
  });

  it("revokes it from anon again, and the unique index is not partial", () => {
    expect(code).toMatch(
      /REVOKE ALL ON FUNCTION public\.record_field_collection\([^)]*\)\s+FROM PUBLIC, anon;/,
    );
    const idx = code.slice(
      code.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS app_notifications_recipient_event_key"),
    );
    expect(idx.slice(0, idx.indexOf(";"))).not.toMatch(/WHERE/i);
  });

  it("asserts what it establishes in a check block", () => {
    expect(code).toMatch(/DO \$check\$/);
    expect(code).toMatch(/record_field_collection still writes app_notifications/);
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
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], {
    encoding: "utf8",
    timeout: 30_000,
  }).stdout?.trim() === "1";

if (!reachable) {
  console.warn(
    `\n  SKIPPED: the field-notification proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set FIELD_NOTIFY_PROOF_DB_URL to run them.\n",
  );
}

/** Again if and only if Postgres chose it as a deadlock victim; see
 *  a-tech-records-cash-and-the-office-applies-it.test.ts. */
function runProof(args: string[]) {
  let r = spawnSync(psql!, args, { encoding: "utf8", timeout: 300_000 });
  for (let i = 0; i < 2 && /deadlock detected/.test(`${r.stdout}${r.stderr}`); i++) {
    r = spawnSync(psql!, args, { encoding: "utf8", timeout: 300_000 });
  }
  return r;
}

describe.skipIf(!reachable)("the field-notification rules hold in a real database", () => {
  it("has the files it runs", () => {
    for (const f of [MIGRATION, CASH, METHODS, PROOF]) expect(existsSync(f), f).toBe(true);
  });

  it("proves every rule, and leaves nothing behind", () => {
    const r = runProof([
      DB_URL,
      "-X",
      "-v",
      `migration=${MIGRATION}`,
      "-v",
      `cash=${CASH}`,
      "-v",
      `methods=${METHODS}`,
      "-f",
      PROOF,
    ]);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(5);
    expect(out).toMatch(/ALL FIELD NOTIFICATION PROOFS PASSED/);
    const left = spawnSync(
      psql!,
      [
        DB_URL,
        "-XAtc",
        "select count(*) from public.organizations where name like 'Field Proof %'",
      ],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  }, 600_000);
});
