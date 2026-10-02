// A calendar link opens one person's visits, and nothing else.
//
// The link is a bearer credential that Google, Apple or Microsoft will hold
// and poll for months, so what it can open is decided in the database, by
// calendar_feed_events, and proved here against a real Postgres rather than
// read off the migration's text. tests/sql/a-calendar-link-opens-one-persons
// -visits-and-nothing-else.proof.sql applies the migration inside a
// transaction, builds two tenants, and proves as postgres, anon, a
// technician, a dispatcher and the service role that
//
//   * a technician mints only their own link, never an all-visits one, and a
//     dispatcher with no staff record gets an all-visits link and no other;
//   * nobody but the service role can read the table or call the feed, and
//     the database never holds anything but a SHA-256 digest;
//   * a technician's link serves exactly their visits from 7 days back to 60
//     ahead on the org's calendar, the skipped one included, nobody else's
//     and nothing from the other tenant;
//   * an unknown, raw or empty token is refused, and a rotated link stops the
//     moment the new one is made, leaving one row, not two;
//   * access codes appear only on a technician's own feed and only with the
//     owner's switch on, and NEVER on the all-visits feed, switch or not;
//   * a link stops serving when its holder is demoted, deactivated or removed,
//     and when it is turned off,
//
// and then ROLLS BACK, so nothing is left on a shared stack.
//
// The .ics writer and the visit mapping are proved separately and without a
// database in a-calendar-reads-exactly-what-rfc-5545-says.test.ts.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const DB_URL =
  process.env.FEED_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20260929050000_the-schedule-lived-only-in-the-app.sql",
);
const PROOF = join(ROOT, "tests/sql/a-calendar-link-opens-one-persons-visits-and-nothing-else.proof.sql");

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
    `\n  SKIPPED: the calendar feed proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set FEED_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("a calendar link, in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("opens one person's visits, and nothing else, and leaves nothing behind", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
      encoding: "utf8",
      timeout: 300_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    // Nine groups, each announcing itself only when it passed.
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(9);
    expect(out).toMatch(/ALL CALENDAR FEED PROOFS PASSED/);

    const left = spawnSync(
      psql!,
      [DB_URL, "-XAtc", "select count(*) from public.organizations where name like 'Feed Proof %'"],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  });
});
