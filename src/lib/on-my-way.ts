import { orgLocalTime } from "@/lib/org-day";

/** "On my way": what it says, and when the automatic path may send it.
 *
 *  Pure, so the wording and the once-per-visit rule are tested without a
 *  database or a phone. The sender is on-my-way.server.ts. */

/** The first word of a staff member's display name, which is what a customer
 *  calls the person at their gate. Null for a blank name. */
export function techFirstName(displayName: string | null | undefined): string | null {
  const first = (displayName ?? "").trim().split(/\s+/)[0];
  return first ? first : null;
}

/** When the tech will arrive, in words, on the organization's clock, or null
 *  when there is nothing honest to say.
 *
 *  A window whose end has already passed is not stated: telling a customer
 *  "arriving between 9:00 and 9:30" at 9:50 is worse than telling them
 *  nothing. A window already under way becomes "by" its end. */
export function etaPhrase(
  etaStart: string | null | undefined,
  etaEnd: string | null | undefined,
  tz: string,
  now: Date = new Date(),
): string | null {
  const start = etaStart ? new Date(etaStart) : null;
  const end = etaEnd ? new Date(etaEnd) : null;
  const valid = (d: Date | null): d is Date => !!d && !Number.isNaN(d.getTime());
  if (valid(end) && end > now) {
    if (valid(start) && start > now) {
      return `between ${orgLocalTime(start, tz)} and ${orgLocalTime(end, tz)}`;
    }
    return `by ${orgLocalTime(end, tz)}`;
  }
  if (!valid(end) && valid(start) && start > now) return `around ${orgLocalTime(start, tz)}`;
  return null;
}

/** The text. The org name is in it because automated texts go from the
 *  platform's number, which the customer has never seen before. */
export function onMyWayText(p: {
  customerName: string;
  orgName: string;
  techName: string | null;
  eta: string | null;
}): string {
  const who = p.techName ? `${p.techName} from ${p.orgName}` : `your ${p.orgName} tech`;
  const when = p.eta ? `, arriving ${p.eta}` : "";
  return `Hi ${p.customerName}, ${who} is on the way for today's visit${when}. Reply STOP to opt out.`;
}

export type NavigateCheck =
  | { send: true }
  | { send: false; reason: "turned_off" | "not_today" | "not_scheduled" | "already_sent" };

/** Whether tapping Navigate should send it. Once per visit: a tech taps
 *  Navigate again after a wrong turn, or reopens the map at a light, and
 *  the customer should hear it once. Only for a stop that is today and not
 *  yet started, because Navigate on tomorrow's stop is a tech looking ahead,
 *  not a tech leaving. */
export function shouldSendOnNavigate(v: {
  enabled: boolean;
  status: string;
  scheduledOn: string;
  orgToday: string;
  sentAt: string | null | undefined;
}): NavigateCheck {
  if (!v.enabled) return { send: false, reason: "turned_off" };
  if (v.sentAt) return { send: false, reason: "already_sent" };
  if (v.scheduledOn !== v.orgToday) return { send: false, reason: "not_today" };
  if (v.status !== "scheduled") return { send: false, reason: "not_scheduled" };
  return { send: true };
}
