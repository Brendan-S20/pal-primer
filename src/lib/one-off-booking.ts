// An extra cleanup a customer asks for from the portal, as rules the portal
// and the office both use.
//
// The database decides (portal_request_one_off refuses anything outside
// these rules); this decides what to OFFER. If they disagree the portal lists
// a day the server refuses, so the rule here is the SQL rule restated, and
// tests/a-customer-can-ask-for-an-extra-cleanup.test.ts pins both:
//
//   bookable(day)  <=>  org_today < day <= org_today + 30
//                       AND dow(day) IN work_days       (0 = Sunday)
//                       AND day is not a blackout date
//
// "Today" is the ORGANIZATION's, from org-day.ts: after dinner in Chicago the
// server is already on tomorrow, and a customer offered "tomorrow" then would
// be offered the day after.

import { addDaysToDay } from "@/lib/reclean";

export const ONE_OFF_MAX_DAYS_AHEAD = 30;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** 0 = Sunday, like Postgres extract(dow) and organizations.work_days. Pure
 *  date arithmetic in UTC, so no device zone can move it. */
export function dayOfWeek(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

/** Every day a customer may ask for, in order: the org's tomorrow through
 *  today + 30, on a working day, not blacked out. */
export function bookableDays(
  orgToday: string,
  workDays: number[] | null | undefined,
  blackouts: Iterable<string> = [],
): string[] {
  const work = new Set(workDays && workDays.length ? workDays : ALL_DAYS);
  const closed = new Set(blackouts);
  const out: string[] = [];
  for (let i = 1; i <= ONE_OFF_MAX_DAYS_AHEAD; i++) {
    const d = addDaysToDay(orgToday, i);
    if (!d) break;
    if (work.has(dayOfWeek(d)) && !closed.has(d)) out.push(d);
  }
  return out;
}

/** What the portal says when the server refuses, keyed by the RPC's own
 *  exception text. The codes are for logs, not for a customer. */
export function oneOffRefusalMessage(raw: string): string {
  if (/date_in_past/.test(raw)) return "That day has already passed. Please pick another.";
  if (/date_too_soon/.test(raw)) return "The earliest day you can ask for is tomorrow.";
  if (/date_too_far/.test(raw))
    return `You can ask for a day up to ${ONE_OFF_MAX_DAYS_AHEAD} days ahead.`;
  if (/not_a_working_day/.test(raw)) return "We don't work that day. Please pick another.";
  if (/blackout_day/.test(raw)) return "We're closed that day. Please pick another.";
  if (/already_scheduled/.test(raw))
    return "You already have a visit that day, so there's nothing extra to book.";
  if (/property_not_found/.test(raw)) return "We couldn't find that address on your account.";
  if (/invalid_token/.test(raw)) return "This portal link is no longer valid.";
  return raw;
}

/** The note on the client's activity timeline, so the office can see why a
 *  one-off exists. */
export function oneOffVisitNote(dayLabel: string, auto: boolean): string {
  return auto
    ? "Extra visit the client asked for from the portal (booked automatically)"
    : `Extra visit the client asked for from the portal${dayLabel ? ` for ${dayLabel}` : ""}`;
}

/** What the portal's request list says about one of these. */
export function oneOffRequestState(r: {
  status: string;
  booked_on?: string | null;
}): "booked" | "declined" | "waiting" {
  if (r.booked_on) return "booked";
  if (r.status === "resolved") return "declined";
  return "waiting";
}
