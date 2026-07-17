// Visit lifecycle helpers (QA round 3, finding B6). Single source of truth for
// how the app computes a visit's actual duration from timestamps and how it
// classifies a genuinely-missed visit. The SQL side mirrors these rules: the
// Visits tab / detail drawer render duration from these helpers, and
// admin_transition_missed_visits (nightly worker) applies the same missed
// predicate server-side.

export type VisitLike = {
  status: string;
  scheduled_on: string; // YYYY-MM-DD
  started_at?: string | null;
  completed_at?: string | null;
};

/** Actual elapsed minutes between start and completion, or null when it can't
 *  be computed (a timestamp is missing, or completion precedes start). A
 *  0-minute result is a real computed value, not "unknown" — the B6 repro had
 *  an identical start and completion, which the old code blanked to
 *  "Not recorded". */
export function visitDurationMinutes(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
): number | null {
  if (!startedAt || !completedAt) return null;
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.round(ms / 60000);
}

/** Humanized duration for display. "Not recorded" only when it genuinely can't
 *  be computed; a computed 0 reads "Under a minute" so a duration the
 *  timestamps actually give us is never blanked out (B6). */
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
 *  return false and are surfaced for review rather than guessed (I5). `today`
 *  is a YYYY-MM-DD string. */
export function isMissedVisitCandidate(v: VisitLike, today: string): boolean {
  return v.status === "scheduled" && v.scheduled_on < today && !v.started_at;
}
