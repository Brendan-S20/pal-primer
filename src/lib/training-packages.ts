import { addDaysToDay } from "@/lib/reclean";

export type TrainingPackage = {
  sessions_count: number;
  sessions_used: number;
  expires_on: string | null;
  status: "active" | "canceled";
};

/** Remaining entitlement includes sessions already booked for later. */
export function sessionsLeft(
  pkg: Pick<TrainingPackage, "sessions_count" | "sessions_used">,
): number {
  return Math.max(0, pkg.sessions_count - pkg.sessions_used);
}

export function packageState(pkg: TrainingPackage, today: string) {
  if (pkg.status === "canceled") return "canceled" as const;
  if (pkg.expires_on && today > pkg.expires_on) return "expired" as const;
  if (sessionsLeft(pkg) === 0) return "used_up" as const;
  return "active" as const;
}

/** Days before expiry when a package counts as running low: the same 14 the
 *  expiry notice uses (dueNotices in training-portal.ts). */
export const RUNNING_LOW_DAYS = 14;

/** An active package the office should look at: one session or none left to
 *  book, or expiring within RUNNING_LOW_DAYS. */
export function runningLow(pkg: TrainingPackage, today: string): boolean {
  if (packageState(pkg, today) !== "active") return false;
  if (sessionsLeft(pkg) <= 1) return true;
  return !!pkg.expires_on && pkg.expires_on <= addDaysToDay(today, RUNNING_LOW_DAYS);
}

export function expiresOnFor(purchasedOn: string, days: number | null): string | null {
  return days == null ? null : addDaysToDay(purchasedOn, days);
}

export function sessionLabel(n: number, total: number): string {
  return `Session ${n} of ${total}`;
}

/** ISO calendar days, calculated in UTC so daylight saving never moves a lesson. */
export function weeklySessionDates(
  startOn: string,
  weekday: number,
  count: number,
  expiresOn: string | null,
): string[] {
  if (
    !Number.isInteger(weekday) ||
    weekday < 0 ||
    weekday > 6 ||
    !Number.isInteger(count) ||
    count < 0 ||
    count > 100
  )
    throw new Error("Choose a weekday and up to 100 sessions.");
  const day = new Date(`${startOn}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== startOn)
    throw new Error("Choose a valid first date.");
  day.setUTCDate(day.getUTCDate() + ((weekday - day.getUTCDay() + 7) % 7));
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const date = day.toISOString().slice(0, 10);
    if (expiresOn && date > expiresOn) break;
    out.push(date);
    day.setUTCDate(day.getUTCDate() + 7);
  }
  return out;
}

/** Null means bookable. The database uses the same refusal sentences. */
export function canBook(pkg: TrainingPackage, holdingCount: number, date: string): string | null {
  if (pkg.status === "canceled") return "This package was canceled.";
  if (pkg.expires_on && date > pkg.expires_on) return `This package expired on ${pkg.expires_on}.`;
  if (holdingCount >= pkg.sessions_count)
    return `No sessions left in this package: ${holdingCount} of ${pkg.sessions_count} are booked or used.`;
  return null;
}

export const CHOOSE_DOG = "Choose which dog this package is for.";
/** The booking dialog looks for this sentence to offer "book anyway". */
export const TRAINER_BUSY = "The trainer already has a lesson at that time";

type LessonUse = { status: string; skip_billable: boolean | null };

/** On a package lesson skip_billable means "uses a session". The database
 * sets it from the business's no-show and late-cancel rule, and the office
 * can override it. Mirrors public.training_visit_uses_session. */
export function usesSession(visit: LessonUse): boolean {
  return (
    visit.status === "completed" ||
    ((visit.status === "skipped" || visit.status === "missed") && visit.skip_billable === true)
  );
}

/** The business's own reasons. A lesson skipped or missed for one of these
 * never uses a session. Mirrors public.training_lesson_session_rule. */
export const BUSINESS_REASONS = ["our_fault", "weather", "unsafe_conditions"] as const;

export function isBusinessReason(code: string | null | undefined): boolean {
  return (BUSINESS_REASONS as readonly string[]).includes(code ?? "");
}

/** Mirrors public.training_visit_holds_session. */
export function holdsSession(visit: LessonUse): boolean {
  return visit.status === "scheduled" || visit.status === "in_progress" || usesSession(visit);
}

/** "HH:MM" plus minutes, or null when the lesson would run past midnight. */
export function lessonEnd(start: string, minutes: number): string | null {
  const [h, m] = start.split(":").map(Number);
  const total = h * 60 + m + minutes;
  if (!Number.isFinite(total) || total > 24 * 60 - 1) return null;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** Two half-open times on the same day overlap. "HH:MM" strings compare in order. */
export function timesOverlap(
  a: { start: string; end: string },
  b: { start: string; end: string },
): boolean {
  return a.start < b.end && b.start < a.end;
}
