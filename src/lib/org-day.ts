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

/**
 * The same question one unit finer: what does this instant READ AS, on the
 * organization's own clock?
 *
 * Until 2026-09-19 every visit-time label in the product answered it with the
 * DEVICE's clock — three private copies of the same `toLocaleTimeString([])`
 * helper plus several inline calls, none passing a timeZone. A Chicago org
 * viewed from an Eastern-time browser showed every ETA an hour late, and the
 * demo org (whose seed compounded it by writing workday times as UTC) showed
 * 3:30 AM. Production STORES the right instant — optimize_route_v2 anchors
 * `(day + workday_start) AT TIME ZONE org.timezone`, mirrored by
 * `zonedTimeToUtc` in route-window.ts — so rendering is the only side that
 * was wrong, and these are the one place it is decided now.
 *
 * Same conventions as `orgLocalDay` above: the tz default exists for safety
 * and every caller should pass one (`useOrgTimezone()` makes that one line);
 * unparseable input returns "" (or null for the minutes form), because every
 * caller branches on falsiness rather than rendering "Invalid Date".
 *
 * NOT for Postgres `time` columns ("08:00:00" strings — arrival windows,
 * workday bounds). Those are wall clock with no zone: `formatClock` in
 * format.ts handles them and needs no timezone. Conflating the two is the
 * easiest mistake here.
 */
const timeFormatters = new Map<string, Intl.DateTimeFormat>();

function timeFormatterFor(tz: string, style: "time" | "daytime" | "parts"): Intl.DateTimeFormat {
  const key = `${tz}|${style}`;
  let f = timeFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(
      style === "parts" ? "en-GB" : undefined,
      style === "time"
        ? { timeZone: tz, hour: "numeric", minute: "2-digit" }
        : style === "daytime"
          ? { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" }
          : { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false },
    );
    timeFormatters.set(key, f);
  }
  return f;
}

/** "3:42 PM", on the organization's clock. */
export function orgLocalTime(
  instant: string | number | Date | null | undefined,
  tz: string = DEFAULT_ORG_TIMEZONE,
): string {
  if (instant == null || instant === "") return "";
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) return "";
  return timeFormatterFor(tz || DEFAULT_ORG_TIMEZONE, "time").format(d);
}

/** "Sat, 3:42 PM", on the organization's clock. */
export function orgLocalDayTime(
  instant: string | number | Date | null | undefined,
  tz: string = DEFAULT_ORG_TIMEZONE,
): string {
  if (instant == null || instant === "") return "";
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) return "";
  return timeFormatterFor(tz || DEFAULT_ORG_TIMEZONE, "daytime").format(d);
}

/**
 * Minutes past midnight on the organization's clock, or null.
 *
 * For code that BUCKETS by time rather than printing it — ScheduleCalendar's
 * row grouping and sort order use this, so getting it wrong moves visits
 * between rows rather than mislabeling them. en-GB with hour12:false because
 * "24" is what some locales print for midnight under hour12:false ("24:05");
 * normalized below so midnight is 0.
 */
export function orgLocalMinutes(
  instant: string | number | Date | null | undefined,
  tz: string = DEFAULT_ORG_TIMEZONE,
): number | null {
  if (instant == null || instant === "") return null;
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) return null;
  const parts = timeFormatterFor(tz || DEFAULT_ORG_TIMEZONE, "parts").formatToParts(d);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? NaN);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? NaN);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  return (hour % 24) * 60 + minute;
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
