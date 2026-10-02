// Route plausibility checks (QA finding #10): the optimizer would happily
// schedule a stop 1,850 km / 61 h from the technician's depot with no warning,
// and could show an arrival time inconsistent with the computed drive. These
// pure helpers flag both so the dispatcher sees a warning instead of silently
// accepting an impossible route.
//
// The stored figure is `travel_km` and the message now reads miles — the
// conversion happens here, at the sentence, and nothing about the data
// changes. See src/lib/measures.ts.

import { kmToMiles } from "@/lib/measures";
import { DEFAULT_ORG_TIMEZONE, orgLocalDay, orgLocalMinutes } from "@/lib/org-day";

export const DEFAULT_MAX_DRIVE_MINUTES = 240;
export const DEFAULT_WORKDAY_START_MINUTES = 8 * 60; // 08:00
/** How far an arrival may sit "early" against its drive before it is a
 *  fault: the planner rounds each leg to a whole minute. See below. */
export const ETA_ROUNDING_TOLERANCE_MIN = 1;

export type RouteVisit = {
  id: string;
  clientName?: string | null;
  travel_km?: number | null;
  travel_min?: number | null;
  eta_start?: string | null;
  scheduled_on?: string | null;
};

export type RouteWarning = {
  visitId: string;
  clientName: string;
  reason: "excessive_drive" | "eta_inconsistent";
  travelKm: number | null;
  travelMin: number | null;
  message: string;
};

function fmtHours(min: number): string {
  const h = min / 60;
  return h >= 1 ? `${h.toFixed(1)} h` : `${Math.round(min)} min`;
}

/**
 * Flag stops whose drive exceeds the org's configured threshold, or whose
 * arrival time is earlier than departure-plus-drive would allow (an ETA not
 * actually derived from the drive time).
 */
export function findRouteWarnings(
  visits: RouteVisit[],
  opts: {
    maxDriveMinutes?: number;
    workdayStartMinutes?: number;
    /** The ORG's IANA zone. Same convention as org-day.ts: the default exists
     *  for safety, and a caller that does not know the timezone is a caller
     *  that should be fetching it — the board reads it from the same
     *  `getDispatchSettings` row the other two thresholds come from. */
    timezone?: string;
  } = {},
): RouteWarning[] {
  const limit = opts.maxDriveMinutes ?? DEFAULT_MAX_DRIVE_MINUTES;
  const workdayStart = opts.workdayStartMinutes ?? DEFAULT_WORKDAY_START_MINUTES;
  const tz = opts.timezone || DEFAULT_ORG_TIMEZONE;
  const warnings: RouteWarning[] = [];

  for (const v of visits) {
    const name = v.clientName || "a visit";
    const driveMin = v.travel_min ?? null;
    const driveKm = v.travel_km ?? null;

    if (driveMin != null && driveMin > limit) {
      warnings.push({
        visitId: v.id,
        clientName: name,
        reason: "excessive_drive",
        travelKm: driveKm,
        travelMin: driveMin,
        message:
          // `travel_km` is stored in kilometres and stays that way; only the
          // sentence a dispatcher reads is converted. Printing "1,850 km" to
          // someone who measures their patch in miles makes them do the
          // arithmetic to find out how bad the problem is.
          `${name}: ${fmtHours(driveMin)} drive` +
          (driveKm != null ? ` (${kmToMiles(driveKm).toFixed(0)} mi)` : "") +
          ` exceeds the ${fmtHours(limit)} limit. Check the technician's depot address.`,
      });
      continue; // one warning per stop is enough
    }

    // ETA must never land before the workday start plus this stop's drive. The
    // optimizer starts the day at workdayStart; even the FIRST stop can't
    // arrive sooner than workdayStart + its drive. If it does, the ETA is
    // stale/wrong (not derived from the shown drive) — the exact repro.
    //
    // Measured on the ORG's clock, because that is the clock both operands
    // live on: `workdayStart` is minutes into the org's workday (a wall-clock
    // setting), and the stored `eta_start` is a correct instant anchored at
    // `(day + workday_start) AT TIME ZONE org.timezone` by optimize_route_v2
    // (the seed's naive strings were the last exception, fixed in
    // 20260919230000). This used to subtract the DEVICE's midnight of
    // `scheduled_on` instead, so a dispatcher one zone east of the org read
    // every correct 8:xx AM first stop as an hour later into the day — or,
    // east enough, as the wrong day entirely — and the board flagged or
    // cleared ETAs based on where the laptop was, not where the truck was.
    if (v.eta_start && driveMin != null && v.scheduled_on) {
      const minutesIntoDay = orgLocalMinutes(v.eta_start, tz);
      // Only an ETA that falls ON the scheduled day is measurable against that
      // day's workday start — the role the old `minutesIntoDay >= 0` guard
      // played, now decided by the org's calendar instead of the device's.
      // (An ETA on the wrong day outright is a different fault this check has
      // never claimed to catch.) `orgLocalDay` returns YYYY-MM-DD, the shape
      // `scheduled_on` already has, so this is a string compare, no parsing.
      const sameDay = orgLocalDay(v.eta_start, tz) === v.scheduled_on;
      const elapsedSinceWorkdayStart =
        minutesIntoDay == null ? null : minutesIntoDay - workdayStart;
      // Arrival implies less elapsed time than the drive alone requires --
      // by more than the planner's own rounding. The planner advances its
      // clock by each leg rounded to a whole minute (`make_interval(mins =>
      // drive::int)`), and stores the leg to one decimal, so a first stop
      // whose 10.4-minute drive put it at 08:10 is exactly right, and was
      // flagged "Re-optimize this route" on the board straight after
      // optimizing: the routing trials found it on the first stop of about
      // half of all freshly planned routes. A stale or invented ETA -- what
      // this check is for -- misses by far more than a minute.
      if (
        sameDay &&
        elapsedSinceWorkdayStart != null &&
        elapsedSinceWorkdayStart < driveMin - ETA_ROUNDING_TOLERANCE_MIN
      ) {
        warnings.push({
          visitId: v.id,
          clientName: name,
          reason: "eta_inconsistent",
          travelKm: driveKm,
          travelMin: driveMin,
          message: `${name}: arrival time is earlier than its ${fmtHours(driveMin)} drive allows. Re-optimize this route.`,
        });
      }
    }
  }

  return warnings;
}
