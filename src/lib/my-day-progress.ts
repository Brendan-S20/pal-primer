// The at-a-glance facts of a technician's day: how many are done, which job is
// open, which stop is next. Pulled out of my-day.tsx so the rules can be tested
// against the SAME list the page draws — including a day whose visits carry
// queued, not-yet-synced statuses (lib/offline/queued-visit-state.ts).

type DayVisit = { id: string; status: string };

export type DayAtAGlance<V extends DayVisit> = {
  completedCount: number;
  skippedCount: number;
  total: number;
  /** Rounded percentage of visits COMPLETED. */
  pct: number;
  /** The job already under way, if any. */
  activeVisit: V | undefined;
  /** What the bottom bar points at: the open job, else the first scheduled. */
  nextUp: V | undefined;
};

export function dayAtAGlance<V extends DayVisit>(visits: readonly V[]): DayAtAGlance<V> {
  // "Done" means COMPLETED (H1): a skipped visit is not a finished job, so it
  // must not inflate the progress bar (the "2 of 7 done · 29%" with 0
  // completed bug). Skipped visits are surfaced separately.
  const completedCount = visits.filter((v) => v.status === "completed").length;
  const skippedCount = visits.filter((v) => v.status === "skipped").length;
  const total = visits.length;
  const pct = total > 0 ? Math.round((completedCount / total) * 100) : 0;
  // BUG-17: a visit the tech has already STARTED outranks anything merely
  // scheduled. The previous single `.find()` returned whichever came first in
  // sequence, so a tech who started #3 while #1 and #2 were still scheduled
  // got pointed at #1 — their open job wasn't surfaced anywhere. Reloading the
  // app (or a phone dropping the tab) has to bring them back to the job in
  // hand.
  const activeVisit = visits.find((v) => v.status === "in_progress");
  const nextUp = activeVisit ?? visits.find((v) => v.status === "scheduled");
  return { completedCount, skippedCount, total, pct, activeVisit, nextUp };
}
