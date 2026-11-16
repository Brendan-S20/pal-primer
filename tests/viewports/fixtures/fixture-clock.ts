import type { BrowserContext, Page } from "@playwright/test";

import { zonedTimeToUtc } from "../../../src/lib/route-window";
import { orgToday } from "../../../src/lib/org-day";
import { FIXTURE_TIMEZONE, TODAY } from "./dataset";

/**
 * One clock for the fixture and the page.
 *
 * ── THE FAULT (#941, 2026-11-16) ─────────────────────────────────────────
 *
 * `the-technician-who-could-not-see-thursday.spec.ts` failed in a required job
 * with "the fixture's first day is not the page's today": the fixture's first
 * day was Sun Nov 15, the page's today was already Mon Nov 16. Both sides were
 * already on the org's timezone (the 2026-10-09 fix). What they were not on is
 * the same INSTANT. The fixture read the clock once, when the worker imported
 * dataset.ts; the browser read it live, at render. A worker that started
 * before midnight in Chicago and opened the page after it served yesterday as
 * today. The app was right — /my-schedule asks `useOrgToday()`, which is the
 * date in the org's zone, and the server builds its window the same way — and
 * the test was asking whether two clocks happened to agree.
 *
 * ── THE FIX ──────────────────────────────────────────────────────────────
 *
 * Pin the browser's `Date` to an instant on the fixture's own day. By default
 * that is NOON, in the org's zone, on TODAY — twelve hours from either
 * midnight, so no run length and no start time can carry it across one. A
 * spec that wants to stand at a boundary passes the instant and builds its
 * fixture from the same instant (`myUpcomingDays(at)` in stub-backend.ts).
 *
 * `setFixedTime`, not `install`: only `Date.now()` / `new Date()` are held.
 * Timers, `requestAnimationFrame` and `performance.now()` keep running on real
 * time, so skeleton delays and pollers behave as they do unpinned. And the
 * browser's own zone is irrelevant to the result, which is the point: the
 * midnight cases also run with the device in a zone other than the org's.
 */

/** Noon in the org's zone on the fixture's TODAY. */
export const FIXTURE_NOON = zonedTimeToUtc(TODAY, "12:00", FIXTURE_TIMEZONE);

/** An org-local wall time on an org-local date, as an instant. */
export const orgInstant = (dateISO: string, hhmm: string) =>
  zonedTimeToUtc(dateISO, hhmm, FIXTURE_TIMEZONE);

/** Hold the browser's clock at `at` (default: noon on the fixture's day).
 *  Call before the first navigation. Returns the org-local day the page will
 *  treat as today, so a spec can assert against the same value. */
export async function pinTheBrowserToTheFixtureDay(
  target: Page | BrowserContext,
  at: Date = FIXTURE_NOON,
): Promise<string> {
  await target.clock.setFixedTime(at);
  return orgToday(FIXTURE_TIMEZONE, at);
}
