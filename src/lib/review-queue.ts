// BUILD-10 — the review queue's shared vocabulary and its detection rules.
//
// Guardrail 10.5: "Ambiguous records go to a review queue — never silently
// guessed." The guardrail was written as though the queue existed; it did not.
//
// These predicates MIRROR public.detect_review_items(). Both decide the same
// question — is this record ambiguous — and tests/review-queue.test.ts replays
// the same fixtures against both, the guard IMP-3 put on permissions and
// BUILD-1 on entitlements. A detector that disagrees with the UI about what
// counts as ambiguous is worse than no detector: the list says three, the page
// shows two, and nobody trusts either again.
//
// Pure, so it can be tested without a database and reused client-side.

export const REVIEW_KINDS = [
  "visit_timestamps_unreliable",
  "visit_started_never_finished",
  "visit_stuck_in_progress",
] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const REVIEW_STATUSES = ["open", "resolved", "dismissed"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** What a reader needs to understand an item without opening the record. */
export const REVIEW_KIND_COPY: Record<
  ReviewKind,
  { label: string; whatItMeans: string; howToFix: string }
> = {
  visit_timestamps_unreliable: {
    label: "Visit duration can't be trusted",
    whatItMeans:
      "Start and completion were recorded as the same moment, so the real duration is unknown. This is the signature of the old office-completion bug, where a visit was closed out without a tech ever starting it.",
    howToFix:
      "Open the visit and either correct the times if you know them, or dismiss this if the visit is fine as recorded.",
  },
  visit_started_never_finished: {
    label: "Started but never finished",
    whatItMeans:
      "A tech began this visit, so it isn't a simple no-show, but it was never completed and its day has passed. Whether the work actually happened is not recoverable from the data.",
    howToFix: "Confirm it was completed, or mark it missed.",
  },
  visit_stuck_in_progress: {
    label: "Left in progress",
    whatItMeans:
      "This visit is still marked in progress after its scheduled day ended. The end-of-day close-out normally catches these while the tech is still in the app.",
    howToFix: "Confirm whether it was completed.",
  },
};

/** The subset of a visit these rules read. Deliberately minimal. */
export interface ReviewableVisit {
  status: string;
  scheduled_on: string; // YYYY-MM-DD
  started_at: string | null;
  completed_at: string | null;
}

/**
 * Which review kind a visit qualifies for, or null.
 *
 * `orgLocalToday` is the org's own date, NOT UTC. Passing a UTC date here would
 * flag visits as overdue for review hours before the org's day had ended — the
 * BUG-12 mistake, which has now surfaced three separate times in this codebase
 * (the portal, the weekly digest, and the missed-visit sweep). The parameter is
 * required rather than defaulted for exactly that reason: there is no safe
 * default, so the caller has to have thought about it.
 */
export function visitReviewKind(
  visit: ReviewableVisit,
  orgLocalToday: string,
): ReviewKind | null {
  const { status, scheduled_on, started_at, completed_at } = visit;

  // Checked first, and independently of status: a completed visit whose
  // timestamps contradict each other is ambiguous no matter what else is true
  // of it.
  if (started_at && completed_at) {
    const start = Date.parse(started_at);
    const end = Date.parse(completed_at);
    // Unparseable timestamps are NOT reported as unreliable — that would be
    // claiming to know they contradict when we can't read them at all.
    if (Number.isFinite(start) && Number.isFinite(end) && end <= start) {
      return "visit_timestamps_unreliable";
    }
  }

  const dayHasPassed = scheduled_on < orgLocalToday;
  if (!dayHasPassed) return null;

  if (status === "scheduled" && started_at) return "visit_started_never_finished";
  if (status === "in_progress") return "visit_stuck_in_progress";

  return null;
}

/** True when an item is still someone's work. */
export function isOpen(status: ReviewStatus): boolean {
  return status === "open";
}

/**
 * Leaving 'open' requires saying what was decided.
 *
 * A resolution with no account of it is the same silence this queue exists to
 * end — "resolved" with an empty note tells the next reader nothing about
 * whether the visit happened.
 */
export function resolutionNoteRequired(next: ReviewStatus): boolean {
  return next !== "open";
}
