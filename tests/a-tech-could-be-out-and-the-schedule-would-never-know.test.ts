// There was no way to say "Jordan is away next week".
//
// `staff.routing_available` is one boolean with no dates. Set it on Friday for
// a holiday starting Monday and you take that tech off TODAY'S board too, and
// nothing turns it back on — a human has to remember, on the right morning,
// per person. It also blocks nothing: the nightly generator and every
// auto-assign happily hand next week's work to somebody who is abroad.
//
// `staff_time_off` is dated ranges, and the guard is a TRIGGER rather than a
// call added to each function. That distinction is what these mostly test.
// `assert_runs_routes` is invoked from three places by hand; a fourth writer
// added later simply would not have it. The writers that set
// `assigned_staff_id` are the nightly generator, CSV import, auto-assign,
// optimize, drag-and-drop, bulk assign and Cover's redistribution — seven and
// counting, so the guard has to live on the column.
//
// The live behaviour was probed against the real database before this was
// written: assignment onto a day off blocked, unassigning still allowed,
// rescheduling onto a day off blocked, rescheduling to a free day allowed —
// with a positive control first, because a guard that refuses EVERYTHING
// produces the same four "blocked" results as one that works.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..", "supabase/migrations");
const SQL = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(dir, f), "utf8"))
  .join("\n");

/** The LAST definition of an object wins, since a later migration replaces an
 *  earlier one. Anchored on CREATE OR REPLACE rather than the bare name —
 *  every definition here is followed by COMMENT ON, so a name-anchored search
 *  reads the docstring instead of the body. */
function lastBody(name: string) {
  const at = SQL.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(at, `${name} is not defined`).toBeGreaterThan(-1);
  const end = SQL.indexOf("$$;", SQL.indexOf("AS $$", at));
  return SQL.slice(at, end === -1 ? undefined : end);
}

describe("time off is dated, not a boolean", () => {
  it("stores a range, inclusive, and refuses one typed backwards", () => {
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS public\.staff_time_off/);
    expect(SQL).toMatch(/CONSTRAINT staff_time_off_range CHECK \(ends_on >= starts_on\)/);
  });

  it("bounds the range so a mistyped year cannot retire somebody", () => {
    // Without this, "off until 2099" takes a tech off the board permanently
    // with no visible cause and no expiry.
    expect(SQL).toMatch(/staff_time_off_bounded CHECK \(ends_on - starts_on <= 366\)/);
  });

  it("is readable by the org but writable only with manage_users", () => {
    // A tech must see their own leave and a dispatcher everyone's, or the
    // board's "off" badge is unexplainable to the person looking at it. But
    // deciding who works is the same permission as naming a field tech.
    expect(SQL).toMatch(
      /CREATE POLICY staff_time_off_read[\s\S]*?USING \(public\.is_org_member\(auth\.uid\(\), organization_id\)\)/,
    );
    expect(SQL).toMatch(
      /CREATE POLICY staff_time_off_write[\s\S]*?has_permission\(auth\.uid\(\), organization_id, 'manage_users'\)/,
    );
    expect(SQL).toMatch(/REVOKE ALL ON public\.staff_time_off FROM anon/);
  });
});

describe("the guard is on the column, not in the callers", () => {
  it("fires for every writer via a trigger on visits", () => {
    expect(SQL).toMatch(
      /CREATE TRIGGER visits_respect_time_off\s+BEFORE INSERT OR UPDATE OF assigned_staff_id, scheduled_on ON public\.visits/,
    );
  });

  it("watches only the two columns that can strand somebody", () => {
    // Completing a visit, writing an ETA or attaching a photo must not be
    // refused because the tech booked leave for next month. Widening this to
    // a bare `UPDATE` would do exactly that.
    const trig = SQL.slice(SQL.indexOf("CREATE TRIGGER visits_respect_time_off"));
    expect(trig.slice(0, 200)).not.toMatch(/BEFORE INSERT OR UPDATE ON/);
  });

  it("lets an unassign through, and leaves finished visits alone", () => {
    const body = lastBody("tg_visit_respects_time_off");
    // Taking work OFF someone who is away is the remedy. Refusing it would
    // strand exactly the rows the feature exists to clear.
    expect(body).toMatch(/IF NEW\.assigned_staff_id IS NULL THEN RETURN NEW/);
    // A completed visit is a record of what happened; leave entered afterwards
    // does not make it untrue.
    expect(body).toMatch(/NEW\.status IN \('completed', 'skipped'\) THEN RETURN NEW/);
  });

  it("no-ops when neither column actually moved", () => {
    // Otherwise a visit assigned BEFORE the leave was recorded becomes
    // uneditable — including unassigning it.
    const body = lastBody("tg_visit_respects_time_off");
    expect(body).toMatch(/NEW\.assigned_staff_id IS NOT DISTINCT FROM OLD\.assigned_staff_id/);
    expect(body).toMatch(/NEW\.scheduled_on\s+IS NOT DISTINCT FROM OLD\.scheduled_on/);
  });

  it("names the person and the date they are back", () => {
    // "Staff unavailable" sends the dispatcher off to look it up. The date
    // they return is what lets them reschedule without leaving the screen.
    const body = lastBody("assert_available_on");
    expect(body).toMatch(/is off on % \(back %\)/);
    expect(body).toMatch(/_until \+ 1/);
    // check_violation, deliberately: bulk_reschedule_visits catches exactly
    // this code to count the row as skipped rather than aborting the batch.
    expect(body).toMatch(/ERRCODE = 'check_violation'/);
  });

  it("stays open for a NULL staff id", () => {
    const body = lastBody("assert_available_on");
    expect(body).toMatch(/IF _staff_id IS NULL OR _day IS NULL THEN RETURN/);
  });
});

describe("recording leave does not move anybody's work", () => {
  it("offers the impact instead of acting on it", () => {
    // Silently reassigning forty visits off a date picker is a surprise, not a
    // safeguard. The count exists so the dispatcher sees it BEFORE saving;
    // moving the work is Cover, which shows the list first.
    const body = lastBody("staff_time_off_impact");
    expect(body).toMatch(/status NOT IN \('completed', 'skipped'\)/);
    expect(body).toMatch(/is_org_member\(auth\.uid\(\)/);
    expect(SQL).not.toMatch(/UPDATE public\.visits[\s\S]{0,400}FROM public\.staff_time_off/);
  });
});

describe("the badge and the guard have to agree", () => {
  // The board deciding somebody is available while the server refuses to
  // assign them is worse than either behaviour alone: the dispatcher drags a
  // visit, watches it bounce, and has no way to find out why from the screen.
  // SQL uses `_day BETWEEN starts_on AND ends_on` — inclusive both ends — so
  // the client comparison has to be `>=` and `<=`, not a half-open range.
  const routes = readFileSync(
    join(import.meta.dirname, "..", "src/routes/_authenticated/routes.tsx"),
    "utf8",
  );

  it("marks a tech away using the same inclusive bounds as is_staff_off", () => {
    expect(routes).toMatch(/day >= t\.starts_on && day <= t\.ends_on/);
    expect(lastBody("is_staff_off")).toMatch(/_day BETWEEN starts_on AND ends_on/);
  });

  it("fetches time off over the window the page is already drawing", () => {
    // Fetching only the selected day would leave week and month unable to mark
    // an absent tech at all — the same defect the visit query had before
    // `calendarWindow` became the single definition.
    expect(routes).toMatch(/queryKey: \["time-off", rangeStart, rangeEnd\]/);
    expect(routes).toMatch(/from: rangeStart, to: rangeEnd/);
  });

  it("keeps 'Away' and 'Off routes' as separate claims", () => {
    // `routing_available` is the undated same-day flag ("out sick, decide
    // later"); time off is dated and enforced. Collapsing them into one badge
    // would tell the dispatcher the server will refuse an assignment when it
    // will happily accept it, and vice versa.
    expect(routes).toMatch(/offRoutes && !offToday/);
  });
});
