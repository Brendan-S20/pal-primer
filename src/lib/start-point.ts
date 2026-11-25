/**
 * Does the drive line on a visit mean anything yet (#1011-2)?
 *
 * Drive distance and ETA are measured from where the technician's day starts:
 * their own start address, else the business address, else the nearest dump
 * site, else (last resort) the edge of the day's own stops. Until one of the
 * first three exists the figure is measured from a guessed point, so a stop in
 * Royal Oak read "56.9 mi · 198 min drive". Hide that line until a real start
 * point is set. `known` is undefined while it is still loading or failed to
 * load: hidden too, so the line never flashes and then vanishes.
 */
export type StartPoints = {
  orgHasLocation: boolean;
  staffWithStart: number;
  disposalSites: number;
};

export function hasStartPoint(p: StartPoints | null | undefined): boolean {
  if (!p) return false;
  return p.orgHasLocation || p.staffWithStart > 0 || p.disposalSites > 0;
}

/** Show "N mi · M min drive" only when there is a start point to measure from. */
export function showDriveLine(
  p: StartPoints | null | undefined,
  visit: { travel_km?: number | null; travel_min?: number | null },
): boolean {
  return hasStartPoint(p) && (visit.travel_km != null || visit.travel_min != null);
}
