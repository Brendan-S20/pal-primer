// The at-a-glance facts of a technician's day: how many are done, which job is
// open, which stop is next. Pulled out of my-day.tsx so the rules can be tested
// against the SAME list the page draws, including a day whose visits carry
// queued, not-yet-synced statuses (lib/offline/queued-visit-state.ts).

type DayVisit = { id: string; status: string };

export type DayAtAGlance<V extends DayVisit> = {
  completedCount: number;
  skippedCount: number;
  missedCount: number;
  total: number;
  /** Rounded percentage of visits COMPLETED. */
  pct: number;
  /** The job already under way, if any. */
  activeVisit: V | undefined;
  /** What the bottom bar points at: the open job, else the first scheduled. */
  nextUp: V | undefined;
};

export function dayAtAGlance<V extends DayVisit>(visits: readonly V[]): DayAtAGlance<V> {
  // Done = completed only. Total = every stop on the route for the day,
  // including missed and skipped ones. Percentage = round(done / total * 100).
  // Missed and skipped are counted separately and never increase done.
  // A CANCELED visit is not a stop (gaps-r2-08): after an early return the
  // stay's last nights are canceled, and counting them left a sitter's day at
  // "0 of 2 done" for good. It is not in the total, and My Day does not draw
  // it as a card (routeStops, the lock screen's same rule).
  const stops = visits.filter((v) => v.status !== "canceled");
  const completedCount = stops.filter((v) => v.status === "completed").length;
  const skippedCount = stops.filter((v) => v.status === "skipped").length;
  const missedCount = stops.filter((v) => v.status === "missed").length;
  const total = stops.length;
  const pct = total > 0 ? Math.round((completedCount / total) * 100) : 0;
  // BUG-17: a visit the tech has already STARTED outranks anything merely
  // scheduled. The previous single `.find()` returned whichever came first in
  // sequence, so a tech who started #3 while #1 and #2 were still scheduled
  // got pointed at #1, their open job wasn't surfaced anywhere. Reloading the
  // app (or a phone dropping the tab) has to bring them back to the job in
  // hand.
  const activeVisit = visits.find((v) => v.status === "in_progress");
  const nextUp = activeVisit ?? visits.find((v) => v.status === "scheduled");
  return { completedCount, skippedCount, missedCount, total, pct, activeVisit, nextUp };
}
