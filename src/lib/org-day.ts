/**
 * What day is it, for this organization?
 *
 * The single definition. Every date column in this schema — `due_on`,
 * `scheduled_on`, `period_start` — is a DATE, meaning a calendar day with no
 * timezone attached. Deciding which calendar day a `timestamptz` falls on is
 * therefore a real decision, and answering it with the SERVER's clock is the
 * mistake this codebase keeps making. It has now been found seven times:
 * BUG-12, the franchise rollup, the review queue, the digest window, the
 * settlement generator, `tg_set_invoice_due_on`, and the five surfaces below.
 *
 * For an organization in America/Chicago, UTC is a day ahead from 19:00 local
 * until midnight. That is five hours of every day — 21% of the clock — in
 * which the server and the customer disagree about what day it is. Everything
 * keyed on a date is wrong during that window: an invoice reads overdue before
 * it is due, ages into the wrong bucket on an accountant's schedule, and posts
 * to QuickBooks under the wrong date.
 *
 * There were already two copies of this function — `orgLocalDay` in
 * cpa-reports.ts and `orgLocalDate` in digest.server.ts — written months apart
 * with identical bodies and different names, which is how the third caller
 * ends up writing a fourth. Both now re-export from here.
 *
 * en-CA is not an aesthetic choice: it formats as YYYY-MM-DD, which is exactly
 * the shape every date column in this schema uses, so the result can be
 * compared lexicographically against `due_on` without parsing anything.
 */

/** The organization's timezone when none is set. Matches the SQL default in
 *  `organizations.timezone` and `coalesce(timezone, 'America/Chicago')`
 *  throughout the migrations — if these two ever disagree, the same invoice
 *  gets two due dates depending on which layer computed it. */
export const DEFAULT_ORG_TIMEZONE = "America/Chicago";

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

/**
 * The calendar day an instant falls on, in the organization's timezone.
 *
 * Returns "" for an unparseable input rather than throwing or silently
 * producing "Invalid Date" — callers compare the result against date strings,
 * and "" sorts below every real date instead of matching one.
 */
export function orgLocalDay(
  instant: string | number | Date,
  tz: string = DEFAULT_ORG_TIMEZONE,
): string {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) return "";
  return formatterFor(tz || DEFAULT_ORG_TIMEZONE).format(d);
}

/** Today, for this organization. The argument is required at the call site by
 *  convention — a caller that does not know the timezone is a caller that
 *  should be fetching it, not defaulting. */
export function orgToday(tz: string = DEFAULT_ORG_TIMEZONE, now: Date = new Date()): string {
  return orgLocalDay(now, tz);
}

/** How many whole days ago `instant` was, counted in the organization's own
 *  calendar rather than in elapsed hours.
 *
 *  Aging buckets are the reason this exists. Subtracting two timestamps and
 *  dividing by 86,400,000 answers "how much time has passed", which is not the
 *  question an accountant is asking: an invoice issued at 23:00 yesterday is
 *  ONE day old on their schedule, not zero. */
export function daysBetweenOrgDays(fromDay: string, toDay: string): number {
  if (!fromDay || !toDay) return 0;
  const a = Date.parse(`${fromDay}T00:00:00Z`);
  const b = Date.parse(`${toDay}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}
