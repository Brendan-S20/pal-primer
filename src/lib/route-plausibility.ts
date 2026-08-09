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

export const DEFAULT_MAX_DRIVE_MINUTES = 240;
export const DEFAULT_WORKDAY_START_MINUTES = 8 * 60; // 08:00

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
  opts: { maxDriveMinutes?: number; workdayStartMinutes?: number } = {},
): RouteWarning[] {
  const limit = opts.maxDriveMinutes ?? DEFAULT_MAX_DRIVE_MINUTES;
  const workdayStart = opts.workdayStartMinutes ?? DEFAULT_WORKDAY_START_MINUTES;
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
    if (v.eta_start && driveMin != null && v.scheduled_on) {
      const eta = new Date(v.eta_start).getTime();
      const dayStart = new Date(`${v.scheduled_on}T00:00:00`).getTime();
      const minutesIntoDay = (eta - dayStart) / 60000;
      const elapsedSinceWorkdayStart = minutesIntoDay - workdayStart;
      // Arrival implies less elapsed time than the drive alone requires.
      if (minutesIntoDay >= 0 && elapsedSinceWorkdayStart < driveMin) {
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
