// Does the day the planner just wrote fit inside the day people work?
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────
//
// The planner never asks. plan_visits reads `workday_start` to anchor the
// first arrival and never reads `workday_end` at all; daily_capacity_minutes
// sizes each technician's SHARE of the day but nothing refuses or reports a
// share that does not fit. So a day with more work than hours is planned
// anyway -- every stop gets an ETA, the last ones after dark or past
// midnight -- and auto-routing reported "Routed 40 stops" and nothing else.
//
// Measured by the routing trials (scripts/routing-trials): one technician,
// 40 stops of 15 minutes on an 8-5 day, planned to finish at 02:51 the next
// morning; a 200-stop Phoenix day with six trucks had every truck working
// until about 7 PM; a part-timer set to 120 minutes was given 154. None of it
// reached the screen.
//
// Planning it anyway is the right call -- the dispatcher may well choose to
// run late, or move stops by hand -- but it has to be SAID. This is the pure
// half of saying it: given the visits as written, which technician-days run
// past the end of the workday or past their capacity, and which stops have no
// location at all (so their place in the order, last, is a guess).

import { daysBetweenOrgDays, orgLocalDay, orgLocalMinutes } from "@/lib/org-day";

export type PlannedVisit = {
  staffId: string | null;
  day: string;
  etaEnd: string | null;
  travelMin: number | null;
  serviceMin: number | null;
  latitude: number | null;
  longitude: number | null;
};

export type DayOverrun = {
  staffId: string;
  day: string;
  /** The last stop's finish, as an instant; render with orgLocalTime. */
  endsAt: string | null;
  /** Minutes the last stop finishes after workday_end (0 when it does not). */
  minutesPastEnd: number;
  /** Drive plus service planned, against the technician's capacity. */
  plannedMin: number;
  capacityMin: number;
};

/** The default capacity the planner itself assumes (COALESCE(..., 480)). */
export const DEFAULT_CAPACITY_MIN = 480;

const clockMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

export function measureDayFit(
  visits: PlannedVisit[],
  opts: {
    timezone: string;
    workdayEnd: string | null | undefined;
    capacityByStaff?: Record<string, number | null | undefined>;
  },
): { overruns: DayOverrun[]; unlocated: Array<{ day: string; count: number }> } {
  const byTechDay = new Map<string, PlannedVisit[]>();
  const unlocated = new Map<string, number>();
  for (const v of visits) {
    if (v.latitude == null || v.longitude == null) {
      unlocated.set(v.day, (unlocated.get(v.day) ?? 0) + 1);
    }
    if (!v.staffId) continue;
    const k = `${v.staffId}|${v.day}`;
    const list = byTechDay.get(k) ?? [];
    list.push(v);
    byTechDay.set(k, list);
  }

  const endMin = opts.workdayEnd ? clockMinutes(opts.workdayEnd) : null;
  const overruns: DayOverrun[] = [];
  for (const [k, list] of byTechDay) {
    const [staffId, day] = k.split("|");
    const last = list
      .filter((v) => v.etaEnd)
      .sort((a, b) => Date.parse(a.etaEnd!) - Date.parse(b.etaEnd!))
      .pop();
    let minutesPastEnd = 0;
    if (last?.etaEnd && endMin != null) {
      // On the org's clock, and counting whole days for a route that runs
      // past midnight -- 02:51 tomorrow is 591 minutes past 17:00, not "early".
      const at = orgLocalMinutes(last.etaEnd, opts.timezone);
      const dayOfEnd = orgLocalDay(last.etaEnd, opts.timezone);
      if (at != null && dayOfEnd) {
        const absolute = at + 1440 * daysBetweenOrgDays(day, dayOfEnd);
        minutesPastEnd = Math.max(0, absolute - endMin);
      }
    }
    const plannedMin = list.reduce(
      (s, v) => s + Number(v.travelMin ?? 0) + Number(v.serviceMin ?? 8),
      0,
    );
    const capacityMin = opts.capacityByStaff?.[staffId] ?? DEFAULT_CAPACITY_MIN;
    if (minutesPastEnd > 0 || plannedMin > capacityMin) {
      overruns.push({
        staffId,
        day,
        endsAt: last?.etaEnd ?? null,
        minutesPastEnd,
        plannedMin: Math.round(plannedMin),
        capacityMin,
      });
    }
  }
  overruns.sort((a, b) => b.minutesPastEnd - a.minutesPastEnd || a.day.localeCompare(b.day));
  return {
    overruns,
    unlocated: [...unlocated.entries()]
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => a.day.localeCompare(b.day)),
  };
}
