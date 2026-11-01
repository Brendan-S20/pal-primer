/**
 * When is this visit expected? One answer for every surface (#654, F-13).
 *
 * A visit can carry two times. `eta_start` / `eta_end` are what the route
 * planner wrote: the clock replayed from the start of the workday, one drive
 * and one service duration at a time. `start_time` is what the customer was
 * BOOKED for: a groom at 09:00 is a promise, not an estimate. The planner does
 * not read `start_time`, so a 09:00 groom routed behind a few stops came back
 * as "Arriving 8:15 to 9:45", and a 2:00 PM groom showed "ETA 8:05" beside
 * "Starts 2:00 PM" on the same card.
 *
 * So: a booked start wins. The window is the booked start through the booked
 * duration on the business's clock (`zonedTimeToUtc`, the same anchor the SQL
 * uses with `AT TIME ZONE`). Without a booked start the planner's ETA is the
 * best answer there is and is returned untouched.
 *
 * Instants come back as ISO strings so a caller passes them straight to
 * `orgLocalTime` / `orgLocalMinutes` exactly as it passed `eta_start` before.
 */
import { DEFAULT_ORG_TIMEZONE } from "@/lib/org-day";
import { zonedTimeToUtc } from "@/lib/route-window";

export type VisitEtaSource = {
  scheduled_on?: string | null;
  /** Postgres `time`: "09:00:00" or "09:00". */
  start_time?: string | null;
  duration_min?: number | null;
  eta_start?: string | null;
  eta_end?: string | null;
};

export type VisitEta = {
  start: string | null;
  end: string | null;
  /** True when the window is the booked appointment, not a routing estimate. */
  booked: boolean;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^(\d{1,2}):(\d{2})/;

/** The booked start as an instant, or null when the visit has no booked time. */
export function bookedStartInstant(
  v: Pick<VisitEtaSource, "scheduled_on" | "start_time">,
  tz: string = DEFAULT_ORG_TIMEZONE,
): Date | null {
  const day = v.scheduled_on ?? "";
  const m = CLOCK.exec(String(v.start_time ?? ""));
  if (!DAY.test(day) || !m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  const at = zonedTimeToUtc(
    day,
    `${String(hh).padStart(2, "0")}:${m[2]}`,
    tz || DEFAULT_ORG_TIMEZONE,
  );
  return Number.isNaN(at.getTime()) ? null : at;
}

export function visitEta(
  v: VisitEtaSource | null | undefined,
  tz: string = DEFAULT_ORG_TIMEZONE,
): VisitEta {
  if (!v) return { start: null, end: null, booked: false };
  const start = bookedStartInstant(v, tz);
  if (start) {
    const minutes = Number(v.duration_min ?? 0);
    const end =
      Number.isFinite(minutes) && minutes > 0
        ? new Date(start.getTime() + minutes * 60_000).toISOString()
        : null;
    return { start: start.toISOString(), end, booked: true };
  }
  return { start: v.eta_start ?? null, end: v.eta_end ?? null, booked: false };
}
