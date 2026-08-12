// The setting said 18 hours. The database had never heard of it.
//
// Settings → Customer portal offers "Allow customers to reschedule
// themselves" and a change cutoff in hours before the visit. `VisitRow` in
// src/lib/portal-ui.tsx honoured both: the Reschedule button was hidden when
// the toggle was off, Skip was disabled past the cutoff, and a line underneath
// said when changes stopped being allowed.
//
// `portal_reschedule_visit` and `portal_request_skip` read neither. Probed on
// the live database in a rolled-back transaction on 2026-08-12:
//
//   skip of an IN_PROGRESS visit:                              ACCEPTED
//   skip 1 day PAST the 18h cutoff:                            ACCEPTED
//   reschedule with self-reschedule OFF and 1 day past cutoff: ACCEPTED
//
// The buttons were the enforcement, and the RPCs sit behind a session-gated
// server function reachable with the token already in the customer's URL bar.
//
// ── WHY THIS FILE READS SQL RATHER THAN RUNNING IT ────────────────────────
//
// The proof that the rule now holds lives in the migration itself: a $post$
// block that re-runs those three probes inside a subtransaction and rolls it
// back by raising and catching, and fails the migration if any of them is
// still accepted. That is a better test than anything here could be, because
// it runs against the real database with the real data — but it runs once, at
// apply time, and nothing re-runs it when someone later edits the function.
//
// So this file guards the shape rather than the behaviour, and is honest about
// the difference. Its subject is the property that was actually missing: that
// there is ONE definition of the cutoff and every path that needs it calls
// that one — because the bug was not a wrong number, it was two systems each
// believing the other was checking.
//
// ── THE REPLAY, AND WHY IT IS NOT A GREP ──────────────────────────────────
//
// Every migration that ever wrote these functions is still in the directory
// and always will be; history is not edited here. A grep for
// `IN ('scheduled','in_progress')` finds the 2026-07 file that introduced it
// and reports a bug that was fixed. So the rule replays the directory in
// filename order, folds CREATE OR REPLACE FUNCTION statements into a map keyed
// by function name, last write winning, and asks its questions of the
// EFFECTIVE definition — the same thing the database ends up with. The replay
// is checked against a floor first, so a parser that quietly stopped matching
// fails loudly instead of finding nothing to complain about.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  migrationFiles,
  readMigration,
  statements,
  stripLineComments,
} from "./support/sql-migrations";

const ROOT = new URL("..", import.meta.url).pathname;
// Lazy. A read resolved in a describe body turns a missing file into an
// import-time throw, and vitest reports that as "no tests" — which reads as a
// pass. The mutation test for this file stashes src/ and supabase/.
const portalUi = () => readFileSync(ROOT + "src/lib/portal-ui.tsx", "utf8");

/** Whole-line `//` comments dropped. The comment left where the old
 *  computation was quotes the strings this file bans, so a raw match finds the
 *  explanation as readily as a relapse. Only whole lines, so a `https://` in a
 *  string is untouched. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
const visitsRoute = () => readFileSync(ROOT + "src/routes/portal.$slug.$token.visits.tsx", "utf8");

const THIS_MIGRATION = "20260812120000_the-portal-cutoff-was-only-a-hidden-button.sql";

/** The last CREATE [OR REPLACE] FUNCTION statement for every function in the
 *  directory: what the database actually has after the migrations run. */
function effectiveFunctions(): Map<string, { file: string; sql: string }> {
  const map = new Map<string, { file: string; sql: string }>();
  for (const file of migrationFiles()) {
    for (const st of statements(stripLineComments(readMigration(file)))) {
      const m = /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.([a-z0-9_]+)\s*\(/i.exec(st);
      if (m) map.set(m[1].toLowerCase(), { file, sql: st });
      const d = /^DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?public\.([a-z0-9_]+)\s*\(/i.exec(st);
      // A DROP followed by a CREATE in the same file is a re-signature, not a
      // removal — the CREATE below it puts the entry back on the next
      // iteration of this loop, which is why the delete is safe to do here.
      if (d) map.delete(d[1].toLowerCase());
    }
  }
  return map;
}

const effective = (name: string) => {
  const f = effectiveFunctions().get(name);
  if (!f) throw new Error(`${name} has no CREATE FUNCTION anywhere in supabase/migrations`);
  return f.sql;
};

describe("the portal cutoff is one rule, and the writers refuse against it", () => {
  it("reconstructs the function surface rather than passing on an empty set", () => {
    // A parser that stopped matching would find no violations and look green.
    // 186 the day this was written: 195 functions have a CREATE somewhere in
    // this directory and nine of them were later dropped and never recreated.
    // The live catalog holds more than either number, because the 2026-07-09
    // consolidated bootstrap arrived under names the filenames do not match.
    // The floor catches a parser that broke; it is not a census of the schema.
    const all = effectiveFunctions();
    expect(all.size).toBeGreaterThanOrEqual(186);
    for (const fn of [
      "portal_change_deadline",
      "portal_reschedule_visit",
      "portal_request_skip",
      "portal_request_vacation_hold",
      "portal_list_upcoming_visits",
    ]) {
      expect(all.has(fn), `${fn} was not found by the replay`).toBe(true);
    }
  });

  it("computes the deadline from the ORG's timezone, not the server's or the browser's", () => {
    const sql = effective("portal_change_deadline");
    // scheduled_on is a `date`. Which midnight it means is a question about a
    // timezone, and the only defensible answer is the one the route is driven
    // in. A bare `::timestamptz` cast would silently use the server's.
    expect(sql).toMatch(/at time zone\s+coalesce\(nullif\(_timezone/i);
    expect(sql).toMatch(/_cutoff_hours/);
    // Clamped: a negative cutoff would mean "changes allowed after the visit".
    expect(sql).toMatch(/greatest\(coalesce\(_cutoff_hours, 0\), 0\)/i);
  });

  it("refuses a reschedule past the cutoff, and one the owner switched off", () => {
    const sql = effective("portal_reschedule_visit");
    expect(sql).toMatch(/portal_allow_self_reschedule/);
    expect(sql, "the toggle must be a refusal, not a variable that is read and ignored").toMatch(
      /IF NOT COALESCE\(_allow, false\) THEN\s*\n\s*RAISE EXCEPTION/i,
    );
    expect(sql).toMatch(/now\(\) > public\.portal_change_deadline\(/);
    expect(sql).toMatch(/past the change cutoff/i);
  });

  it("refuses a skip past the cutoff, and no longer cancels a visit already begun", () => {
    const sql = effective("portal_request_skip");
    expect(sql).toMatch(/now\(\) > public\.portal_change_deadline\(/);
    expect(sql).toMatch(/past the change cutoff/i);
    // The tech is standing in the yard. The whole point of the status filter.
    const code = sql.replace(/--[^\n]*/g, "");
    expect(
      code,
      "portal_request_skip must not accept an in_progress visit: the customer " +
        "cancels work the technician has already started, and it lands unbilled",
    ).not.toMatch(/in_progress/);
    expect(code).toMatch(/v\.status = 'scheduled'/);
  });

  it("closes the vacation hold, which would otherwise be the way round it", () => {
    // It sets skip_billable = false, so a customer past the cutoff got a
    // BETTER outcome through the hold than through the Skip button.
    const sql = effective("portal_request_vacation_hold");
    expect(sql).toMatch(/now\(\) <= public\.portal_change_deadline\(/);
    const auto = sql.slice(sql.indexOf("IF _auto THEN"), sql.indexOf("GET DIAGNOSTICS"));
    expect(auto.replace(/--[^\n]*/g, "")).not.toMatch(/in_progress/);
    // What it could not apply is surfaced rather than dropped.
    expect(sql).toMatch(/past the change cutoff and left on the schedule/);
    expect(sql).toMatch(/INSERT INTO public\.qc_tickets/i);
  });

  it("hands the deadline to the browser instead of letting it derive one", () => {
    const sql = effective("portal_list_upcoming_visits");
    expect(sql).toMatch(/changes_allowed_until timestamp with time zone/i);
    expect(sql).toMatch(/public\.portal_change_deadline\(v\.scheduled_on, o\.timezone/);
  });

  it("has exactly one definition of the rule — every caller goes through it", () => {
    // The point of the whole change. Four callers, one arithmetic.
    const callers = [
      "portal_reschedule_visit",
      "portal_request_skip",
      "portal_request_vacation_hold",
      "portal_list_upcoming_visits",
    ];
    for (const fn of callers) {
      expect(effective(fn), `${fn} does not call portal_change_deadline`).toMatch(
        /public\.portal_change_deadline\(/,
      );
      // …and none of them re-derives it inline alongside.
      expect(
        effective(fn).replace(/--[^\n]*/g, ""),
        `${fn} re-derives the cutoff instead of calling portal_change_deadline`,
      ).not.toMatch(/interval '1 hour'/i);
    }
  });

  it("counts the reschedule window in the org's day, not UTC's", () => {
    // CURRENT_DATE is UTC. At 21:59 in New York it is already tomorrow there,
    // so the picker offered a date the server then rejected as not one day in
    // the future — four hours a day, every day, for eastern orgs.
    const sql = effective("portal_reschedule_visit");
    expect(sql).toMatch(/_today := \(now\(\) AT TIME ZONE COALESCE\(NULLIF\(_tz/i);
    expect(sql).not.toMatch(/CURRENT_DATE \+ 1/);
    expect(sql).not.toMatch(/CURRENT_DATE \+ 60/);
  });
});

describe("the portal reads the deadline rather than recomputing it", () => {
  it("compares two instants, and gets one of them from the server", () => {
    const src = portalUi();
    expect(src).toMatch(/v\.changes_allowed_until\s*\?\s*new Date\(v\.changes_allowed_until\)/);
    expect(src).toMatch(/const pastCutoff = cutoff \? Date\.now\(\) > cutoff\.getTime\(\) : false/);
  });

  it("no longer takes a cutoff in hours, which it could only get wrong", () => {
    // `toDate(scheduled_on)` parses a bare date at the BROWSER's midnight, so
    // the same visit had a different deadline for a customer who travelled.
    const src = codeOnly(portalUi());
    expect(src).not.toMatch(/cutoffHours/);
    expect(src).not.toMatch(/cutoffHours \* 3600/);
    expect(visitsRoute()).not.toMatch(/cutoffHours=/);
    expect(visitsRoute()).not.toMatch(/reschedule_cutoff_hours/);
  });

  it("says nothing rather than inventing a deadline it was not given", () => {
    // The old fallback printed "Changes allowed until 24h before." when it had
    // no date — a number no setting anywhere produced.
    expect(codeOnly(portalUi())).not.toMatch(/24h before/);
    expect(portalUi()).toMatch(/const cutoffCopy = cutoff/);
  });

  it("still gates both actions on it", () => {
    const src = portalUi();
    expect(src).toMatch(/\{allowReschedule && !pastCutoff && \(/);
    expect(src).toMatch(/disabled=\{pastCutoff\}/);
  });
});

describe("the migration is a record of what was done", () => {
  it("asserts the broken state before changing it", () => {
    const sql = readMigration(THIS_MIGRATION);
    expect(sql).toMatch(/do \$pre\$/i);
    expect(sql).toMatch(/already reads the portal settings/);
    expect(sql).toMatch(/no longer accepts in_progress/);
  });

  it("proves the arithmetic outright, including across a DST boundary", () => {
    const post = readMigration(THIS_MIGRATION).slice(
      readMigration(THIS_MIGRATION).indexOf("do $post$"),
    );
    expect(post).toMatch(/2026-08-13 06:00:00-04/);
    expect(post).toMatch(/2026-03-07 06:00:00-05/); // spring forward
    expect(post).toMatch(/does not follow the org timezone/);
    expect(post).toMatch(/does not fall back to UTC/);
    expect(post).toMatch(/negative cutoff extended the window/);
  });

  it("re-runs the three probes and rolls them back, rather than asserting", () => {
    const post = readMigration(THIS_MIGRATION).slice(
      readMigration(THIS_MIGRATION).indexOf("do $post$"),
    );
    expect(post).toMatch(/ROLLBACK-PROBE/);
    expect(post).toMatch(/skip past the cutoff was still accepted/);
    expect(post).toMatch(/reschedule was accepted with self-reschedule off/);
    expect(post).toMatch(/reschedule past the cutoff was still accepted/);
    // A refusal for the WRONG reason is a failure too — otherwise a function
    // that raised 'Invalid portal token' at the top would pass this proof.
    expect(post).toMatch(/refused for the wrong reason/);
    // And it says so when there is nothing to probe, instead of passing quietly.
    expect(post).toMatch(/the behavioural half of this proof did not run/);
  });

  it("does not leave its new functions executable by the browser's key", () => {
    // Both migrations in this pair, because the first one missed
    // `authenticated` on the two functions it created and the second is the
    // record of that. Anything reachable one hop before requirePortalSession
    // is a portal RPC authorizing on a token alone.
    const first = stripLineComments(readMigration(THIS_MIGRATION));
    for (const fn of ["portal_change_deadline", "portal_list_upcoming_visits"]) {
      expect(first).toMatch(new RegExp(`revoke all on function public\\.${fn}\\(`, "i"));
    }
    const second = stripLineComments(
      readMigration("20260812130000_two-new-portal-functions-arrived-granted-to-authenticated.sql"),
    );
    expect(second).toMatch(
      /revoke execute on function public\.portal_change_deadline\(.*\) from authenticated/i,
    );
    expect(second).toMatch(
      /revoke execute on function public\.portal_list_upcoming_visits\(uuid\) from authenticated/i,
    );
    expect(second).toMatch(/still reachable without service_role/);
  });
});
