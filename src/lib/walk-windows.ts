/** The time windows a client can ask for a walk in (#410). Pure, so the portal
 *  card, the server that checks the choice, and the tests read one copy.
 *
 *  The business's working hours (organizations.workday_start / workday_end)
 *  split into two-hour windows that start on the hour. A last window that
 *  would run past the end of the day is cut at the end, so 08:00 to 17:00
 *  offers 08-10, 10-12, 12-14, 14-16 and 16-17. Hours that cannot be read
 *  fall back to 08:00 to 18:00.
 *
 *  English on purpose: the portal and the client's emails speak the
 *  business's language (CLAUDE.md, "What stays English"). */

export type WalkWindow = { start: string; end: string };

export const DEFAULT_WALK_DAY = { start: "08:00", end: "18:00" } as const;
export const WALK_WINDOW_HOURS = 2;

/** Minutes since midnight for "HH:MM" or "HH:MM:SS", or null. */
function minutesOf(v: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec((v ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "HH:MM" from a time column ("10:00:00"), or null when unreadable. */
export function normalizeClock(v: string | null | undefined): string | null {
  const m = minutesOf(v);
  return m == null ? null : hhmm(m);
}

/** The windows on offer for a business's working day. */
export function walkWindows(
  workdayStart: string | null | undefined,
  workdayEnd: string | null | undefined,
): WalkWindow[] {
  let start = minutesOf(workdayStart);
  let end = minutesOf(workdayEnd);
  if (start == null || end == null || end - start < 60) {
    start = minutesOf(DEFAULT_WALK_DAY.start)!;
    end = minutesOf(DEFAULT_WALK_DAY.end)!;
  }
  // On the hour: a 07:30 start offers its first window at 08:00.
  const first = Math.ceil(start / 60) * 60;
  const out: WalkWindow[] = [];
  for (let s = first; s + 60 <= end; s += WALK_WINDOW_HOURS * 60) {
    out.push({ start: hhmm(s), end: hhmm(Math.min(s + WALK_WINDOW_HOURS * 60, end)) });
  }
  return out;
}

/** Whether a requested window is exactly one of those on offer. Both ends
 *  missing is "Any time" and always allowed; one end alone never is. */
export function isOfferedWindow(
  windows: readonly WalkWindow[],
  earliest: string | null | undefined,
  latest: string | null | undefined,
): boolean {
  if (!earliest && !latest) return true;
  const a = normalizeClock(earliest);
  const b = normalizeClock(latest);
  if (!a || !b) return false;
  return windows.some((w) => w.start === a && w.end === b);
}

export const WINDOW_NOT_OFFERED = "That time isn't one we offer. Please pick another, or Any time.";

/** "10 AM", "12:30 PM". */
export function clockLabel(v: string | null | undefined): string {
  const m = minutesOf(v);
  if (m == null) return "";
  const h24 = Math.floor(m / 60) % 24;
  const min = m % 60;
  const suffix = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return min === 0 ? `${h12} ${suffix}` : `${h12}:${String(min).padStart(2, "0")} ${suffix}`;
}

/** "10 AM to 12 PM", or null when there is no window. */
export function windowLabel(
  earliest: string | null | undefined,
  latest: string | null | undefined,
): string | null {
  const a = clockLabel(earliest);
  const b = clockLabel(latest);
  if (a && b) return `${a} to ${b}`;
  if (a) return `after ${a}`;
  if (b) return `before ${b}`;
  return null;
}
