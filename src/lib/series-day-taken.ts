// A plan holds one visit a day: visits are unique on (subscription_id,
// scheduled_on), and a canceled or skipped visit still holds its day. Moving a
// lesson onto the day of a late-canceled one used to show the office the raw
// constraint, `duplicate key value violates unique constraint
// "visits_subscription_id_scheduled_on_key"`, and nothing moved (R2-30,
// train-r2-04).
//
// The rule stays. What changes is the sentence: it says what is in the way
// and how to get the make-up anyway, which is a one-off visit (a one-off is
// its own plan, so it never collides with the series).

/** The unique constraint that holds one visit per plan per day. */
export const SERIES_DAY_CONSTRAINT = "visits_subscription_id_scheduled_on_key";

/** True for the database's refusal of a second visit of one plan on one day. */
export function isSeriesDayTaken(error: { code?: string; message?: string } | null | undefined) {
  if (!error) return false;
  return (error.message ?? "").includes(SERIES_DAY_CONSTRAINT);
}

/** "Fri, Oct 30" for an org-calendar day (YYYY-MM-DD). Read at noon UTC so no
 *  zone moves it to a neighbouring day. */
function dayLabel(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** The office's sentence when a move lands on a day the plan already holds. */
export function seriesDayTakenMessage(toDate?: string | null): string {
  const on = toDate ? ` on ${dayLabel(toDate)}` : " on that day";
  return (
    `This plan already has a visit${on}. A canceled or skipped visit still holds its day, ` +
    `and a plan has one visit a day. Pick another day, or book a one-off visit${on} for the make-up.`
  );
}
