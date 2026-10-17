/**
 * Calendar days for tests that write dates the database reads as a business's
 * day. The database reads "today" as (now() AT TIME ZONE organizations.timezone),
 * so a test builds its dates in that zone, never in the machine's zone.
 *
 * Today comes from orgToday in src/lib/org-day.ts, the same answer the app
 * gives. Days are YYYY-MM-DD strings, the shape of a Postgres date column.
 */
import { orgToday } from "@/lib/org-day";

/** `day` moved by `n` days. Plain calendar math, so no zone can shift it. */
export function addDays(day: string, n: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

/** Today in `timeZone`, moved by `offsetDays`. */
export function orgDay(timeZone: string, offsetDays = 0, now: Date = new Date()): string {
  return addDays(orgToday(timeZone, now), offsetDays);
}

/**
 * The first `weekday` (0 is Sunday) at least `minDaysAhead` days after today
 * in `timeZone`.
 */
export function nextOrgWeekday(
  timeZone: string,
  weekday: number,
  minDaysAhead = 0,
  now: Date = new Date(),
): string {
  const start = orgDay(timeZone, minDaysAhead, now);
  const current = new Date(`${start}T00:00:00Z`).getUTCDay();
  return addDays(start, (weekday - current + 7) % 7);
}
