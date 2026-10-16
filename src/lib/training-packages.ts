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

export function holdsSession(visit: { status: string; skip_billable: boolean | null }): boolean {
  return (
    ["scheduled", "in_progress", "completed"].includes(visit.status) ||
    (visit.status === "skipped" && visit.skip_billable === true)
  );
}
