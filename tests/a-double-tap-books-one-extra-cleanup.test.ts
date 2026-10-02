// A double tap books one extra cleanup, and a wrong day books none.
//
// portal_request_one_off decides whether a customer's extra-cleanup request
// is accepted, and it is proved here against a real Postgres rather than read
// off the migration. tests/sql/a-double-tap-books-one-extra-cleanup.proof.sql
// applies the migration inside a transaction, builds two tenants, and proves
// that
//
//   * it refuses a day that is not one of the org's work_days, a day in the
//     past, the org's today, a day more than 30 out, a blackout day, a day the
//     property already has a visit, an inactive or unknown client, and any
//     property that is not this client's own live one (a neighbour's, another
//     tenant's, their own archived one) -- and writes nothing when it refuses;
//   * the last working day inside the 30 is accepted;
//   * a double tap returns the FIRST request with created = false, and the
//     partial unique index refuses a second open request even from a writer
//     that skipped the lookup, which is what two concurrent taps are;
//   * once booked (what auto-accept does: a one_time subscription whose visit
//     generate_visits_core makes as the service role, with nobody signed in),
//     another tap returns the booked request, not a refusal and not a second
//     visit, and the portal's list shows the day asked for and the day booked;
//   * a declined request does not block asking again;
//   * neither anon nor a signed-in owner can call it; only the service role,
//     exactly like portal_request_reclean,
//
// and then ROLLS BACK, so nothing is left on a shared stack.
//
// The day-offering rule the portal uses is pinned to the same SQL in
// a-customer-can-ask-for-an-extra-cleanup.test.ts.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const DB_URL =
  process.env.ONE_OFF_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20260929050000_the-schedule-lived-only-in-the-app.sql",
);
const PROOF = join(ROOT, "tests/sql/a-double-tap-books-one-extra-cleanup.proof.sql");

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
    `\n  SKIPPED: the extra-cleanup proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set ONE_OFF_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("an extra-cleanup request, in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("refuses every wrong day and address, makes one request per double tap, and leaves nothing behind", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
      encoding: "utf8",
      timeout: 300_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    // Seven groups, each announcing itself only when it passed.
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(7);
    expect(out).toMatch(/ALL ONE-OFF REQUEST PROOFS PASSED/);

    const left = spawnSync(
      psql!,
      [DB_URL, "-XAtc", "select count(*) from public.organizations where name like 'One-off Proof %'"],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  });
});
