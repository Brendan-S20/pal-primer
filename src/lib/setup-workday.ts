// /setup step 1 asks the workday (#769). organizations.workday_start/end
// default to 08:00-17:00, and nothing in setup ever showed them: arrival
// windows, a walk's window in the portal and "this day runs late" were all
// computed from hours the owner had never been asked. The business step now
// shows both, prefilled with what is stored, and saves them with the rest.

import { DEFAULT_WORKDAY_END, DEFAULT_WORKDAY_START } from "@/lib/route-window";

/** "08:00:00" (as Postgres returns a time) or "08:00" → "08:00"; anything
 *  else → the default, so the field never starts blank. */
export function workdayField(stored: unknown, fallback: string): string {
  return typeof stored === "string" && /^\d{2}:\d{2}/.test(stored) ? stored.slice(0, 5) : fallback;
}

export const SETUP_WORKDAY_DEFAULTS = {
  start: DEFAULT_WORKDAY_START.slice(0, 5),
  end: DEFAULT_WORKDAY_END.slice(0, 5),
} as const;

/** What the form refuses, or null. Both are HH:MM; the day has to end after
 *  it starts (an overnight business sets that in Settings, Scheduling). */
export function workdayProblem(start: string, end: string): string | null {
  const ok = (t: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
  if (!ok(start) || !ok(end)) return "Enter when your workday starts and ends.";
  if (end <= start) return "Your workday has to end after it starts.";
  return null;
}
