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

import { orgLocalDay } from "./org-day";

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

/** Why a duration couldn't be computed, or null when it could.
 *
 *  BUG-9: these two cases used to look identical on screen, both reading
 *  "Not recorded", which is why the fabricated records sat unnoticed.
 *  - "missing"    — a timestamp is absent. Genuinely unknown: nobody recorded it.
 *  - "unreliable" — BOTH timestamps exist but completion doesn't follow start.
 *                   That is known-bad data, not missing data: the signature of
 *                   the old office-completion bug writing now() into start and
 *                   completion together. It needs a human, so it says so.
 *
 *  The brief's "derive duration whenever both timestamps exist" is deliberately
 *  NOT implemented: an identical pair would derive 0 and render "Under a
 *  minute", asserting that a real sub-minute service happened. For a row whose
 *  timestamps were written days after the scheduled date, that is a fabricated
 *  claim printed as fact, and it would erase the only signal these rows carry.
 *  Surfacing the doubt is the fix; inventing a number is not. */
export function visitTimestampIssue(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
): "missing" | "unreliable" | null {
  if (!startedAt || !completedAt) return "missing";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms)) return "missing";
  return ms <= 0 ? "unreliable" : null;
}

/** Humanized duration for display. "Not recorded" when a timestamp is simply
 *  absent; "Needs review" when both exist but contradict each other. A genuine
 *  sub-minute gap rounds to 0 and reads "Under a minute". */
export function formatVisitDuration(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
): string {
  const issue = visitTimestampIssue(startedAt, completedAt);
  if (issue === "unreliable") return "Needs review";
  if (issue === "missing") return "Not recorded";
  const mins = visitDurationMinutes(startedAt, completedAt);
  if (mins === 0) return "Under a minute";
  return `${mins} min`;
}

/** BUILD-11: a visit the tech started and never closed, past the point where it
 *  can still plausibly be in progress.
 *
 *  This gap exists because the nightly missed-visit job deliberately skips
 *  anything with a started_at (see isMissedVisitCandidate), so an in_progress
 *  visit is never resolved by anything — it just falls off the tech's day when
 *  the date rolls over. Nothing auto-completes it: this predicate only decides
 *  when to ASK.
 *
 *  Stale means either the org's day has moved past the visit's date, or it is
 *  still that date but the workday has ended. All comparisons are in ORG-LOCAL
 *  terms — callers pass the org-local date and time, never UTC, for the same
 *  reason the portal's "today" is org-local (BUG-12).
 *
 *  `workdayEnd` is "HH:MM" (or "HH:MM:SS"); an absent one means only the
 *  date rollover triggers, which is the conservative choice — better to ask a
 *  morning late than to interrupt a tech still working. */
export function isVisitAwaitingCloseOut(
  v: Pick<VisitLike, "status" | "scheduled_on">,
  orgLocalToday: string,
  orgLocalTime?: string | null,
  workdayEnd?: string | null,
): boolean {
  if (v.status !== "in_progress") return false;
  if (v.scheduled_on < orgLocalToday) return true;
  if (v.scheduled_on > orgLocalToday) return false;
  // Same day: only once the workday is over.
  if (!workdayEnd || !orgLocalTime) return false;
  return orgLocalTime.slice(0, 5) >= workdayEnd.slice(0, 5);
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

/** True for a missed visit that was written after its own day had passed,
 *  so it was never on anybody's route (#429).
 *
 *  generate_visits_core walks a plan from its started_on. A plan entered
 *  with a start date in the past (an import that kept the client's real
 *  start, or an office back-dating one) gets every date since then inserted
 *  at once, already behind it, and the nightly job (isMissedVisitCandidate
 *  above) moves each to 'missed' the same night. Nothing was missed: the
 *  dates did not exist until after they were over. The row is left as it is,
 *  since the office can still mark one completed if it was serviced; only
 *  how it reads changes. `tz` is the org's, the same clock scheduled_on is
 *  on. */
export function wasNeverOnARoute(
  v: { status: string; scheduled_on: string; created_at?: string | null },
  tz: string,
): boolean {
  if (v.status !== "missed" || !v.created_at) return false;
  const written = orgLocalDay(v.created_at, tz);
  return written !== "" && written > v.scheduled_on;
}

/** Statuses the office can mark completed. Mirrors office_complete_visit,
 *  which has accepted 'missed' since B6: the nightly job marks a past visit
 *  missed when nobody closed it, and the visit may still have been serviced
 *  (#455). The server function, the dispatch drawer and the client Visits tab
 *  all ask this, so none of them can disagree with the SQL again. */
export const OFFICE_COMPLETABLE_STATUSES = ["scheduled", "in_progress", "missed"] as const;

export function canOfficeComplete(status: string | null | undefined): boolean {
  return (OFFICE_COMPLETABLE_STATUSES as readonly string[]).includes(String(status));
}

/** The tail of office_complete_visit's refusal when a visit has no
 *  completion photo, or required checklist items nobody checked, and the
 *  office gave no reason (#658, F-15). The tech's complete_visit asks the
 *  same two questions; the office may still complete, by saying why. */
export const OFFICE_COMPLETE_ASKS_WHY = "Say why you are completing it from the office.";

/** The question to put to the office, when `message` is that refusal. */
export function officeCompleteOverrideAsk(message: string | null | undefined): string | null {
  if (!message || !message.includes(OFFICE_COMPLETE_ASKS_WHY)) return null;
  return message.replace(OFFICE_COMPLETE_ASKS_WHY, "").trim();
}

/** Share of the visits that reached an outcome that were completed, 0 to 1,
 *  or null when none did. Missed and skipped count against it: missed is not
 *  done. Canceled visits and ones still open (scheduled, in progress) do not
 *  count either way, so a week with today's route half run, or a visit the
 *  client canceled, does not read as work that failed (#455). */
export function completionRate(rows: Array<{ status: string }>): number | null {
  let completed = 0;
  let resolved = 0;
  for (const r of rows) {
    if (r.status === "completed") completed++;
    if (r.status === "completed" || r.status === "skipped" || r.status === "missed") resolved++;
  }
  return resolved > 0 ? completed / resolved : null;
}
