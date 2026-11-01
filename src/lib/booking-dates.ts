/**
 * Two date rules for visits (#654, F-23), in one place so the office, the
 * groomer, the tech and the server all say the same thing.
 *
 *   1. A visit is not booked or moved onto a day that is already over. "Over"
 *      is the BUSINESS's calendar (`orgToday(tz)`), not the device's or the
 *      server's: today is still bookable, yesterday is not.
 *   2. Completing a visit before its day is allowed (a tech who got ahead),
 *      but never by one stray tap. It takes a confirm, and the office server
 *      function refuses it without one.
 *
 * Pure: the caller supplies `today`, which keeps this testable and keeps the
 * one definition of "today" in org-day.ts.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const PAST_DAY_REFUSAL = "That day has already passed. Choose today or a later day.";

export const FUTURE_COMPLETE_REFUSAL =
  "This visit is scheduled for a later day. Confirm that it was done early to complete it.";

/** The refusal for booking or moving a visit onto `day`, or null when `day` is
 *  today or later. A malformed day is left to the caller's own validation. */
export function pastDayRefusal(day: string | null | undefined, today: string): string | null {
  if (!day || !DAY.test(day) || !DAY.test(today)) return null;
  return day < today ? PAST_DAY_REFUSAL : null;
}

/** True when the visit's day is after the business's today. */
export function isFutureVisit(scheduledOn: string | null | undefined, today: string): boolean {
  if (!scheduledOn || !DAY.test(scheduledOn) || !DAY.test(today)) return false;
  return scheduledOn > today;
}

/** The earliest day a picker should offer: the later of `floor` and today. */
export function notBeforeToday(floor: string | null | undefined, today: string): string {
  return floor && DAY.test(floor) && floor > today ? floor : today;
}

/** `day` moved by `n` calendar days: "2026-11-01", 1 -> "2026-11-02". Done on
 *  the date itself, so no clock or time zone can move it. */
export function shiftDay(day: string, n: number): string {
  if (!DAY.test(day)) return day;
  const ms = Date.parse(`${day}T00:00:00Z`) + n * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** The office's confirm for completing a visit before its day. The tech's
 *  wording is in lib/i18n (`visit.earlyComplete*`), in the tech's language. */
export function earlyCompleteConfirm(dayLabel: string) {
  return {
    title: "Complete this visit early?",
    description: `This visit is scheduled for ${dayLabel}. Completing it now marks it done today.`,
    confirmLabel: "Complete early",
  };
}
