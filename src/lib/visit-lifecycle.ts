// Visit lifecycle helpers (QA round 3, finding B6).
//
// Duration (visitDurationMinutes / formatVisitDuration) is the SINGLE source of
// truth used by the Visits tab and detail drawer — no SQL equivalent renders
// duration, so these are authoritative for the app.
//
// The missed predicate (isMissedVisitCandidate) is a PURE MIRROR of the
// authoritative SQL routine admin_transition_missed_visits (the nightly
// worker). The SQL is the writer of record; this exists so the rule is
// executable and regression-tested. Keep the two in sync: any change to the
// SQL predicate (e.g. the timezone-aware cutoff) must be reflected here, and
// callers must pass the same `today` the SQL uses (the ORG-LOCAL date, not UTC).

export type VisitLike = {
  status: string;
  scheduled_on: string; // YYYY-MM-DD
  started_at?: string | null;
  completed_at?: string | null;
};

/** Actual elapsed minutes between start and completion, or null when it can't
 *  be computed. Null when a timestamp is missing, completion precedes start,
 *  OR the two are the identical instant — an equal start and completion is the
 *  signature of the old fabrication bug (office-completed with started_at =
 *  now() = completed_at), never a real service, so it is treated as unknown
 *  rather than a genuine zero (B6 finding 4). A real sub-minute visit has a
 *  positive gap and still rounds to 0 (see formatVisitDuration). */
export function visitDurationMinutes(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
): number | null {
  if (!startedAt || !completedAt) return null;
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.round(ms / 60000);
}

/** Humanized duration for display. "Not recorded" when it can't be computed
 *  (missing timestamps, or the fabricated identical start/completion). A
 *  genuine sub-minute gap rounds to 0 and reads "Under a minute". */
export function formatVisitDuration(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
): string {
  const mins = visitDurationMinutes(startedAt, completedAt);
  if (mins == null) return "Not recorded";
  if (mins === 0) return "Under a minute";
  return `${mins} min`;
}

/** True when a scheduled visit is genuinely past and never serviced, so the
 *  nightly job may move it to 'missed'. Mirrors admin_transition_missed_visits:
 *  only pre-service 'scheduled' rows strictly before today, with no partial
 *  start. Ambiguous rows (scheduled today, a partial start, or in_progress)
 *  return false and are surfaced for review rather than guessed (I5).
 *  `today` MUST be the ORG-LOCAL calendar date (YYYY-MM-DD) — the SQL cutoff
 *  uses (now() AT TIME ZONE org.timezone)::date, not UTC, so a visit is missed
 *  only once the org's own day has moved past it. */
export function isMissedVisitCandidate(v: VisitLike, today: string): boolean {
  return v.status === "scheduled" && v.scheduled_on < today && !v.started_at;
}
