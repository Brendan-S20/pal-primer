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

// ── WHAT /review IS ALLOWED TO SHOW ────────────────────────────────────────
//
// `review_items` stopped being the visit detector's private table. Four other
// features now file into it — refunds, chargebacks, dispute inquiries, failed
// billing runs, AI allowance warnings — because it is the one place a human
// looks, and that was the right call for each of them individually. What was
// never done is the other half: telling /review which of those it OWNS.
//
// It read the whole table. The damage was not cosmetic:
//
//   1. A chargeback rendered as the literal string `payment_chargeback`, with
//      no label and no guidance, because REVIEW_KIND_COPY has no entry for it.
//   2. Worse, it rendered with a "Record a decision" button. /disputes derives
//      a dispute's state from the reversal ledger and never looks at
//      `review_items.status`, so an office manager marking a live chargeback
//      "resolved" here changed nothing about the dispute and made the two
//      screens disagree about money that is still with the bank.
//   3. The nav badge counted every open row of every kind, so "7 needs review"
//      led to a list of three.
//
// So the queue names its kinds. An allowlist and not a denylist: a kind added
// to the CHECK constraint by some future migration cannot appear on this page
// until someone puts it here on purpose, which is the safe direction — the
// failure mode is a new alert nobody sees yet, not a new alert everybody can
// resolve with a button that does nothing.
//
// Adding to this list is deliberate in the compiler's eyes too: REVIEW_KIND_COPY
// is keyed on it, so a new kind does not typecheck until its label, its
// explanation and its "what do I do" have been written. That is the whole
// point — an item nobody understands is an item nobody resolves.
export const REVIEW_QUEUE_KINDS = [
  // Spread rather than relisted: the three visit kinds are the detector's own
  // output and dropping one here while it kept being filed would hide it
  // silently. They cannot fall off this list by editing accident.
  ...REVIEW_KINDS,
  // Filed by run_billing_cycles when a client's invoicing throws. The queue is
  // its ONLY reader — before it, the failure was a RAISE WARNING in a log
  // nobody read, and fifteen days of failed invoicing looked like a clean run.
  "billing_run_failed",
  // Filed by recordAiUsage at 80% of the included allowance. Also read nowhere
  // else: BUILD-2 chose this queue precisely so the warning would not need a
  // second notification surface of its own.
  "ai_allowance_warning",
] as const;
export type ReviewQueueKind = (typeof REVIEW_QUEUE_KINDS)[number];

/**
 * Does this row belong on /review?
 *
 * Deliberately NOT the inverse of DISPUTE_KINDS. Testing "is it a dispute" and
 * showing everything else is how `payment_refunded` — which is neither a
 * dispute nor anything /review can act on — ended up on the page, and how the
 * next money kind would too. The question this page has to answer is "is this
 * mine", and only the list above can answer it.
 */
export function isReviewQueueKind(kind: string): kind is ReviewQueueKind {
  return (REVIEW_QUEUE_KINDS as readonly string[]).includes(kind);
}

/** What a reader needs to understand an item without opening the record. */
export const REVIEW_KIND_COPY: Record<
  ReviewQueueKind,
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
  // The two below were filed into this queue by their own features and then
  // rendered here as their raw kind strings, because nobody wrote them copy.
  // A card headed `billing_run_failed` with no explanation is not meaningfully
  // better than the log line it replaced.
  billing_run_failed: {
    label: "This client could not be invoiced",
    whatItMeans:
      "The nightly invoicing run reached this client and the invoice failed to generate. The run itself finished — one client's failure is caught so it cannot stop everyone else's — which means nothing else anywhere will tell you this happened. Work is still being recorded; it is only the bill that did not get made.",
    howToFix:
      "Open the client and check their billing setup and unbilled work. Invoicing them by hand clears the backlog; the run retries on its own each night, so if the cause is fixed it will simply succeed and this stops re-filing.",
  },
  ai_allowance_warning: {
    label: "AI usage is near this month's allowance",
    whatItMeans:
      "You have used most of the AI actions included in your plan for this month. Nothing is paused and nothing is broken — this is here so the overage on the next invoice is not the first you hear of it.",
    howToFix:
      "Nothing, if the spend is expected. If it is not, the monthly ceiling and which tools may spend against it are in Settings → AI Tools.",
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
