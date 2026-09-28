// The re-clean guarantee, as arithmetic the portal and the office both use.
//
// The database decides (portal_request_reclean refuses outside the window);
// this decides what to OFFER. They have to agree, or the portal draws a
// button the server refuses — so the rule here is the SQL rule restated, and
// the tests pin it:
//
//   inside  ⇔  completed_at IS NOT NULL
//              AND window > 0
//              AND completed_at >= now() - window hours
//
// The window runs from when the visit was FINISHED, not the day it was
// scheduled, so it is instant arithmetic and needs no timezone. The timezone
// matters only for how the deadline and the default booking day are SHOWN,
// and those go through org-day.ts on the organization's clock.

import { DEFAULT_ORG_TIMEZONE, orgLocalDayTime, orgToday } from "@/lib/org-day";

export const RECLEAN_WINDOW_DEFAULT_HOURS = 48;
export const RECLEAN_WINDOW_MAX_HOURS = 168;

const HOUR_MS = 3_600_000;

/** When the customer's chance to ask closes, or null when there is none:
 *  the guarantee is off, the window is garbage, or the visit has no
 *  completion time to measure from. */
export function recleanWindowClosesAt(
  completedAt: string | Date | null | undefined,
  windowHours: number | null | undefined,
): Date | null {
  if (completedAt == null || completedAt === "") return null;
  const hours = Number(windowHours ?? 0);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  const done = completedAt instanceof Date ? completedAt : new Date(completedAt);
  if (Number.isNaN(done.getTime())) return null;
  return new Date(done.getTime() + hours * HOUR_MS);
}

/** Whether the portal should offer "Request a re-clean" for this visit. */
export function isInsideRecleanWindow(
  visit: { status?: string | null; completed_at?: string | null },
  windowHours: number | null | undefined,
  now: Date = new Date(),
): boolean {
  if (visit.status !== "completed") return false;
  const closes = recleanWindowClosesAt(visit.completed_at, windowHours);
  if (!closes) return false;
  return now.getTime() <= closes.getTime();
}

/** "Sat, 3:42 PM", on the organization's clock, for "you can ask until …". */
export function recleanDeadlineLabel(
  completedAt: string | Date | null | undefined,
  windowHours: number | null | undefined,
  tz: string = DEFAULT_ORG_TIMEZONE,
): string {
  const closes = recleanWindowClosesAt(completedAt, windowHours);
  return closes ? orgLocalDayTime(closes, tz) : "";
}

/** A calendar day plus n days. Pure date arithmetic on YYYY-MM-DD, done in
 *  UTC so no device timezone can move it; "" for garbage. */
export function addDaysToDay(day: string, n: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
  const t = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(t)) return "";
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

/** The day the office's "Schedule re-clean" dialog opens on: the ORG's
 *  tomorrow. A re-clean booked for today is usually too late to route, and
 *  "tomorrow" on the office laptop's clock is the wrong tomorrow for a
 *  business in another zone after dinner. */
export function defaultRecleanDay(
  tz: string = DEFAULT_ORG_TIMEZONE,
  now: Date = new Date(),
): string {
  return addDaysToDay(orgToday(tz, now), 1);
}

/** Why the free visit exists, on the client's activity timeline. */
export function recleanVisitNote(originalDayLabel: string): string {
  return originalDayLabel
    ? `Re-clean for the visit on ${originalDayLabel}`
    : "Re-clean for a recent visit";
}

/** What the portal says when the server refuses, keyed by the RPC's own
 *  exception text. The raw codes are for logs, not for a customer. */
export function recleanRefusalMessage(raw: string): string {
  if (/reclean_window_closed/.test(raw))
    return "The re-clean window for this visit has closed. You can still report a concern.";
  if (/reclean_off/.test(raw)) return "Re-clean requests aren't available right now.";
  if (/visit_not_completed/.test(raw)) return "That visit hasn't been completed yet.";
  if (/visit_is_a_reclean/.test(raw))
    return "This visit was already a re-clean. Please report a concern instead.";
  if (/visit_not_found|invalid_token/.test(raw))
    return "We couldn't find that visit on your account.";
  return raw;
}
