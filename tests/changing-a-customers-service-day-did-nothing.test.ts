// A dispatcher moves a client from Monday to Thursday. The form saves. The
// column updates. Every future visit still lands on Monday, forever.
//
// `generate_visits_core` reads `preferred_weekdays` in exactly one place:
//
//   SELECT MAX(scheduled_on) INTO _next FROM visits WHERE subscription_id = ...
//   IF _next IS NULL THEN
//     _candidate := _sub.started_on;
//     IF _prefs IS NOT NULL AND frequency IN ('weekly','biweekly') THEN
//       ... advance to a preferred weekday ...
//     END IF;
//   ELSE
//     _candidate := _next + _step;     <-- preferences never consulted again
//   END IF;
//
// The preference is honoured on the FIRST visit a subscription ever generates
// and never again, because from then on the series chains off its own last
// date and that preserves whatever weekday it started on. A write-only column.
//
// Found by measuring, not reading: the demo org had five subscriptions
// carrying preferred_weekdays = {1} (Monday) that were generating Sunday
// visits — the preference had been changed after the series began, and the
// change did nothing.
//
// The same defect had a second face. The org's work_days is {1,2,3,4,5}, yet
// 148 of its 250 visits sat on a Sunday: a business scheduling most of its
// week on the day it is closed, with no warning anywhere.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const migration = readFileSync(
  join(root, "supabase/migrations/20260806050000_changing-a-customers-service-day-did-nothing.sql"),
  "utf8",
);

/** Comment lines stripped, so a `not.toMatch` cannot be satisfied or defeated
 *  by the prose that documents the bug. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");

describe("the preference is read on every run, not just the first", () => {
  it("snaps the chained candidate onto a preferred weekday", () => {
    expect(migration).toMatch(/snap onto a preferred weekday/);
    expect(migration).toMatch(
      /WHILE NOT \(EXTRACT\(DOW FROM _candidate\)::int = ANY\(_prefs\)\) AND _guard < 7 LOOP/,
    );
  });

  it("only moves forward", () => {
    // Moving backward could land on or before the last existing visit and
    // collide with a row that is already on the books.
    const snap = migration.slice(migration.indexOf("snap onto a preferred weekday"));
    expect(snap).toMatch(/_candidate := _candidate \+ 1;/);
    expect(codeOnly(snap)).not.toMatch(/_candidate := _candidate - /);
  });

  it("is bounded, so an impossible preference cannot spin", () => {
    // preferred_weekdays is CHECKed against 0..6, but a guard costs nothing
    // and an unbounded WHILE inside a generator is not worth the risk.
    expect(migration).toMatch(/_guard := 0;[\s\S]{0,200}_guard < 7/);
  });

  it("applies to the same frequencies as the branch above it", () => {
    // twice_weekly has its own explicit day-array loop and already honours
    // preferences every pass; the interval-driven ones have no weekday to
    // respect. Widening this would double-handle twice_weekly.
    expect(migration).toMatch(/_sub\.frequency IN \(''weekly'',''biweekly''\)/);
  });
});

describe("the splice is safe to apply and to re-apply", () => {
  it("asserts its anchor appears exactly once", () => {
    // `replace()` that matches nothing returns the original string, so an
    // unguarded splice installs an unpatched copy and reports success.
    expect(migration).toMatch(
      /IF _n <> 1 THEN\s*\n\s*RAISE EXCEPTION 'expected exactly 1 chained-step assignment/,
    );
  });

  it("is idempotent", () => {
    expect(migration).toMatch(/already honours preferences on later runs/);
    expect(migration).toMatch(/RETURN;/);
  });

  it("patches the live definition rather than restating it", () => {
    // The body carries the blackout skip, the client-hold skip, the work-days
    // fallback and the twice-weekly branch. Retyping ~120 lines to insert four
    // is how one of those silently disappears.
    expect(migration).toMatch(/pg_get_functiondef/);
    expect(codeOnly(migration)).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.generate_visits_core/,
    );
  });

  it("records what the column now means", () => {
    expect(migration).toMatch(/COMMENT ON FUNCTION public\.generate_visits_core/);
    // The comment is a concatenation of quoted SQL literals, so the sentence
    // is split across lines — match the halves rather than the seam.
    expect(migration).toMatch(/on every run, not only the first/);
    expect(migration).toMatch(/never moved the schedule/);
  });
});
