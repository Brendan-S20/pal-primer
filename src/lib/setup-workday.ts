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

// Step 1's Save waits for the stored hours (#797 review): see
// src/components/SetupBusinessSave.tsx.

/** The slice of the dispatch-settings query Save cares about. */
export type DispatchRead = { isSuccess: boolean; isError: boolean };

/** Whether Save is held: while saving, or while the stored hours are still
 *  being read. */
export function businessSaveBlocked(saving: boolean, dispatch: DispatchRead): boolean {
  return saving || !(dispatch.isSuccess || dispatch.isError);
}

/** The hours step 1 writes (#797 review). An hour is written only when it is
 *  the owner's answer: typed here, or read back from the database and shown.
 *  Until the read succeeds the field shows the 08:00-17:00 fallback, and
 *  writing that would replace stored hours nobody saw. */
export function workdayWriteFor(a: {
  typedStart: string | null;
  typedEnd: string | null;
  loaded: boolean;
  start: string;
  end: string;
}): { workday_start?: string; workday_end?: string } {
  return {
    ...(a.typedStart !== null || a.loaded ? { workday_start: a.start } : {}),
    ...(a.typedEnd !== null || a.loaded ? { workday_end: a.end } : {}),
  };
}

/** What the form refuses about the hours it is about to WRITE. Both written:
 *  the day has to end after it starts. One written (typed after a failed
 *  read): only its own shape, because the other side is a stored hour this
 *  page could not read, and comparing against the fallback would refuse a
 *  good answer or pass a bad one. None written: nothing to check. */
export function workdayWriteProblem(w: {
  workday_start?: string;
  workday_end?: string;
}): string | null {
  if (w.workday_start !== undefined && w.workday_end !== undefined)
    return workdayProblem(w.workday_start, w.workday_end);
  const one = w.workday_start ?? w.workday_end;
  if (one === undefined) return null;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(one) ? null : "Enter a time like 08:00.";
}
