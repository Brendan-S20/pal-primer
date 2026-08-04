// BUILD-12 — what a dispute IS, derived from the reversal ledger.
//
// Owner: "If the invoice is disputed, it should end-up in a dispute queue; then
// that can either be toggled into the analytics or toggled out, it should
// definitely show as an issue/lost."
//
// ── WHY THE STATE HAS TO BE DERIVED ────────────────────────────────────────
//
// There is no `disputes` table and there should not be one. Stripe is the
// system of record for a dispute; what HoundStack holds is the sequence of
// events it was told about, filed as review items against a payment:
//
//   payment_dispute_inquiry         the bank asked a question   (no money moves)
//   payment_dispute_inquiry_closed  it was dropped             (no money moves)
//   payment_chargeback              the bank pulled the money  (money moved)
//   payment_chargeback_won          we won it back             (money moved)
//   payment_chargeback_lost         it closed against us       (no money moves)
//
// Each of those rows belongs to ONE Stripe dispute id, not to a payment: a
// payment can be disputed more than once over its life.
//
// A second table would be a copy of that sequence with its own opportunities to
// disagree with it. Deriving instead means the queue and the money can never
// tell different stories — which is the failure mode this codebase keeps
// finding (BUG-21, BUG-24, IMP-10 all reduce to "one fact, two implementations").
//
// ── WHY `lost` IS RECORDED RATHER THAN INFERRED ────────────────────────────
//
// The obvious shortcut is "open for more than N days, call it lost". That is a
// guess, and guessing is precisely what the review queue exists to prevent —
// guardrail 10.5. A dispute genuinely can run months. So a loss is a fact we
// are told, or it is not a fact at all: until Stripe closes it, the honest
// answer is "still open", however long that has been.
//
// Pure, so both the queue and the analytics gate read one implementation.

// ── AN INQUIRY IS NOT A CHARGEBACK ─────────────────────────────────────────
//
// BUILD-12 fix. Stripe uses ONE object and ONE pair of events
// (`charge.dispute.created` / `charge.dispute.closed`) for two different
// things, and only the `status` field tells them apart:
//
//   warning_needs_response / warning_under_review / warning_closed
//       An INQUIRY (a retrieval request). The cardholder's bank is asking a
//       question. NO FUNDS ARE WITHDRAWN — `dispute.balance_transactions` is
//       empty, which is Stripe's own documented signal for "money moved".
//       `warning_closed` means the inquiry ended WITHOUT becoming a chargeback:
//       nothing was ever taken and nothing is owed.
//
//   needs_response / under_review / won / lost
//       A real chargeback. The money left the account when it was created.
//
//   prevented
//       The dispute was stopped before it became a chargeback (Rapid Dispute
//       Resolution / Order Insight). Nothing moves down the DISPUTE path — if
//       the customer got their money it arrived as a refund, and
//       `charge.refunded` files that separately. Grouped with the inquiry
//       statuses here for exactly that reason.
//
// Treating an inquiry as a chargeback is not a cosmetic error: it marks the
// payment `refunded`, deducts the amount from every revenue figure and the CPA
// pack, and bills a franchise location for money that never left anyone's
// account. `warning_closed` then files a LOST chargeback, so the deduction is
// permanent and the queue tells the owner they were beaten in a fight that
// never happened.

export const DISPUTE_OUTCOMES = [
  "inquiry",
  "open",
  "won",
  "lost",
  "inquiry_closed",
] as const;
export type DisputeOutcome = (typeof DISPUTE_OUTCOMES)[number];

/** The reversal-queue kinds that describe a dispute's life. */
export const DISPUTE_KINDS = [
  "payment_dispute_inquiry",
  "payment_dispute_inquiry_closed",
  "payment_chargeback",
  "payment_chargeback_won",
  "payment_chargeback_lost",
] as const;

/**
 * Has money left the account because of a dispute in this status?
 *
 * A prefix test on `warning_` rather than an exact list, so a status Stripe
 * adds later to the inquiry family fails SAFE — as an inquiry that moves no
 * money — instead of silently deducting revenue the day it first appears.
 * Anything else is assumed to be a real chargeback, which is the other safe
 * direction: an unrecognised REAL dispute is still recorded as a withdrawal.
 */
export function disputeStatusMovedMoney(status: string | null | undefined): boolean {
  const s = (status ?? "").trim().toLowerCase();
  if (s.startsWith("warning_")) return false;
  if (s === "prevented") return false;
  return true;
}

/**
 * Is this dispute over?
 *
 * `won` and `lost` are the real outcomes; `warning_closed` is an inquiry that
 * was dropped without becoming one. Everything else — needs_response,
 * under_review and their `warning_` twins — is still live.
 *
 * Used to read `charge.dispute.updated`, which carries no hint of its own about
 * whether it is announcing a beginning or an end.
 */
export function disputeIsClosed(status: string | null | undefined): boolean {
  const s = (status ?? "").trim().toLowerCase();
  return s === "won" || s === "lost" || s === "warning_closed";
}

/** The reversal kind a dispute webhook should file, and what it means for money. */
export type DisputeWebhookPlan = {
  /** The `_kind` to hand the SQL filer, or null to record nothing. */
  kind:
    | "dispute_inquiry"
    | "dispute_inquiry_closed"
    | "chargeback"
    | "chargeback_won"
    | "chargeback_lost"
    | null;
  /** Whether THIS event moved money, i.e. whether it may bill a franchise. */
  movesMoney: boolean;
};

/**
 * What to do with a `charge.dispute.*` webhook — the whole of the money
 * decision, pure and testable, so it is not buried in a webhook handler that
 * only production traffic ever exercises.
 */
export function planDisputeEvent(
  eventType: string,
  status: string | null | undefined,
): DisputeWebhookPlan {
  const moved = disputeStatusMovedMoney(status);

  if (eventType === "charge.dispute.created") {
    // An inquiry is recorded so it is VISIBLE — it has a response window and
    // ignoring it is how it becomes a chargeback — but it moves nothing.
    return moved
      ? { kind: "chargeback", movesMoney: true }
      : { kind: "dispute_inquiry", movesMoney: false };
  }

  if (eventType === "charge.dispute.closed") {
    // A win is the only closure that returns money.
    if ((status ?? "").trim().toLowerCase() === "won") {
      return { kind: "chargeback_won", movesMoney: true };
    }
    // An inquiry closing (`warning_closed`) is the good outcome: it never
    // became a chargeback. Recording it as a loss is the BUILD-12 defect.
    if (!moved) return { kind: "dispute_inquiry_closed", movesMoney: false };
    // A genuine loss. Status only — the money left when the dispute opened.
    return { kind: "chargeback_lost", movesMoney: false };
  }

  if (eventType === "charge.dispute.updated") {
    // The event that carries the promotion nobody sees coming.
    //
    // Stripe does not always open a NEW dispute object when an inquiry becomes
    // a real chargeback — it can change `status` on the existing one, from
    // `warning_needs_response` to `needs_response`, and announce it here. The
    // money leaves the account at that moment. Arbitration works the same way
    // in the other direction: a dispute already closed as `won` can flip to
    // `lost` on an update, and the funds go back out.
    //
    // Neither transition raises `created` or `closed`. So with this event
    // unsubscribed, the two cases where money moves without a new dispute
    // object were exactly the two the system could not see — an inquiry we had
    // told the owner cost nothing quietly becoming a chargeback that did.
    //
    // Deliberately no new state machine: an update on a live dispute means the
    // same thing as an opening, and an update on a finished one means the same
    // thing as a closure, so it delegates to the branches above rather than
    // reimplementing them slightly differently. What makes this safe to run on
    // every update — Stripe also fires this when evidence is attached, with no
    // status change at all — is that every write it leads to is idempotent per
    // dispute id: the adjustment records a delta against what that dispute has
    // already billed, and the review item conflicts on the same key.
    return planDisputeEvent(
      disputeIsClosed(status) ? "charge.dispute.closed" : "charge.dispute.created",
      status,
    );
  }

  return { kind: null, movesMoney: false };
}

export type DisputeEvent = {
  kind: string;
  /** Org-local day the event was filed. */
  day: string;
  amountCents: number;
  /**
   * Stripe's dispute id (`dp_…`). A payment can carry SEVERAL disputes over its
   * life — an inquiry that escalates, or two partial disputes on one charge —
   * and each is its own object with its own amount and its own deadline. Blank
   * for rows filed before this was recorded; those group together, which is the
   * old one-dispute-per-payment behaviour and is right for them.
   */
  disputeId?: string;
};

export type Dispute = {
  paymentId: string;
  /** Stripe's dispute id, or "" for a row filed before it was recorded. */
  disputeId: string;
  outcome: DisputeOutcome;
  amountCents: number;
  /** When the dispute was raised (for a chargeback, when the bank took the money). */
  openedOn: string;
  /** When it was decided, if it has been. */
  decidedOn: string | null;
  /** Whether the amount has actually left the account. False for an inquiry. */
  moneyLeft: boolean;
};

/** A stable key for one dispute, since a payment can hold more than one. */
export function disputeKey(paymentId: string, disputeId: string | undefined): string {
  return `${paymentId}:${disputeId ?? ""}`;
}

/**
 * Fold ONE dispute's events into one state.
 *
 * The events handed here must belong to a single Stripe dispute — see
 * `disputesFrom`, which groups on payment AND dispute id. Grouping on the
 * payment alone was the second BUILD-12 defect: a payment that is disputed
 * twice had its second dispute folded into the first and lost.
 */
export function disputeFrom(
  paymentId: string,
  events: DisputeEvent[],
  disputeId = "",
): Dispute | null {
  const chargeback = events.find((e) => e.kind === "payment_chargeback");
  const inquiry = events.find((e) => e.kind === "payment_dispute_inquiry");
  // A chargeback outranks an inquiry on the same dispute: Stripe can promote an
  // inquiry in place, and once it has, money HAS left.
  const opened = chargeback ?? inquiry;
  // No opening event means no dispute. A `won` or `lost` on its own would be a
  // webhook we received out of order or a payment whose opening we missed —
  // either way we cannot say what was disputed or for how much, so it is not
  // rendered as a dispute rather than rendered as a guess.
  if (!opened) return null;

  const won = events.find((e) => e.kind === "payment_chargeback_won");
  const lost = events.find((e) => e.kind === "payment_chargeback_lost");
  const inquiryClosed = events.find((e) => e.kind === "payment_dispute_inquiry_closed");

  // A win beats a loss if both somehow exist. Money came back in the win, and
  // the loss record moves nothing — treating it as lost would tell the owner
  // they are out money they are actually holding.
  const outcome: DisputeOutcome = chargeback
    ? won
      ? "won"
      : lost
        ? "lost"
        : "open"
    : inquiryClosed
      ? "inquiry_closed"
      : "inquiry";

  const decided = won ?? lost ?? (chargeback ? undefined : inquiryClosed);
  return {
    paymentId,
    disputeId,
    outcome,
    amountCents: opened.amountCents,
    openedOn: opened.day,
    decidedOn: decided?.day ?? null,
    // An inquiry never took anything, whether it is still open or already
    // closed. Only a chargeback moves money, and a won one gave it back.
    moneyLeft: !!chargeback && !won,
  };
}

/** Group raw events by payment AND dispute, and fold each. */
export function disputesFrom(
  events: Array<DisputeEvent & { paymentId: string | null }>,
): Dispute[] {
  const byDispute = new Map<string, { paymentId: string; disputeId: string; evts: DisputeEvent[] }>();
  for (const e of events) {
    if (!e.paymentId) continue;
    if (!(DISPUTE_KINDS as readonly string[]).includes(e.kind)) continue;
    const disputeId = e.disputeId ?? "";
    const key = disputeKey(e.paymentId, disputeId);
    const bucket = byDispute.get(key) ?? { paymentId: e.paymentId, disputeId, evts: [] };
    bucket.evts.push(e);
    byDispute.set(key, bucket);
  }
  return [...byDispute.values()]
    .map((b) => disputeFrom(b.paymentId, b.evts, b.disputeId))
    .filter((d): d is Dispute => d !== null)
    .sort((a, b) => b.openedOn.localeCompare(a.openedOn) || a.disputeId.localeCompare(b.disputeId));
}

/**
 * Is this payment's money still reversed, given every dispute on it?
 *
 * Winning ONE dispute does not make the payment whole when another is still
 * open or was lost — flipping `payments.status` back to 'succeeded' on the
 * first win restored the full gross of a charge the bank is still holding.
 */
export function paymentIsReversedByDisputes(disputes: Dispute[]): boolean {
  return disputes.some((d) => d.moneyLeft);
}

export const DISPUTE_COPY: Record<
  DisputeOutcome,
  { label: string; tone: "danger" | "warn" | "ok"; whatItMeans: string }
> = {
  inquiry: {
    label: "Inquiry — no money taken",
    tone: "warn",
    whatItMeans:
      "The customer's bank has asked a question about this charge. Nothing has been withdrawn and your revenue is untouched. Answering it is how it stays that way — an unanswered inquiry is what turns into a chargeback. Answer it on the Payments page; you do not need to open Stripe.",
  },
  inquiry_closed: {
    label: "Inquiry closed — nothing was taken",
    tone: "ok",
    whatItMeans:
      "The bank's question was dropped without becoming a chargeback. No money ever left the account and none is owed. Nothing to do.",
  },
  open: {
    label: "Open — money withdrawn",
    tone: "warn",
    whatItMeans:
      "The bank has taken this money back while the customer's claim is reviewed. You have a limited window to submit evidence from the Payments page; after that the decision is made without it.",
  },
  lost: {
    label: "Lost",
    tone: "danger",
    whatItMeans:
      "Decided in the customer's favour. The money left when the dispute opened and is not coming back — this sale is final as lost.",
  },
  won: {
    label: "Won — money returned",
    tone: "ok",
    whatItMeans:
      "Decided in your favour. The money has been returned and the deduction taken for it was reversed.",
  },
};

/**
 * Does this dispute reduce ANALYTICS revenue?
 *
 * A won dispute never reduces anything — the money came back. A lost one always
 * does. An OPEN one is the only case the owner's toggle touches: the money has
 * genuinely left, so the default is to deduct it, but an owner confident of
 * winning can choose to see revenue as though the disputes hold.
 *
 * THE TAX REPORTS DO NOT CALL THIS. A figure on a return cannot depend on a
 * display preference; BUILD-13's sheets read the reversal ledger directly.
 */
export function disputeReducesAnalyticsRevenue(
  outcome: DisputeOutcome,
  includeOpenDisputes: boolean,
): boolean {
  // An inquiry — open or closed — never took anything, so there is nothing to
  // deduct and nothing for the toggle to have an opinion about.
  if (outcome === "inquiry" || outcome === "inquiry_closed") return false;
  if (outcome === "won") return false;
  if (outcome === "lost") return true;
  return !includeOpenDisputes;
}

/** Totals for the queue header, so "3 open" and the money agree. */
export function summarizeDisputes(disputes: Dispute[]) {
  const acc = {
    /** Open INQUIRIES — a live worklist item where no money has moved. */
    inquiryCount: 0,
    inquiryCents: 0,
    openCount: 0,
    openCents: 0,
    lostCount: 0,
    lostCents: 0,
    wonCount: 0,
    wonCents: 0,
  };
  for (const d of disputes) {
    if (d.outcome === "inquiry") {
      acc.inquiryCount += 1;
      acc.inquiryCents += d.amountCents;
    } else if (d.outcome === "inquiry_closed") {
      // Deliberately in no money bucket. A closed inquiry took nothing and is
      // owed nothing; counting its amount anywhere would invent a figure.
      continue;
    } else if (d.outcome === "open") {
      acc.openCount += 1;
      acc.openCents += d.amountCents;
    } else if (d.outcome === "lost") {
      acc.lostCount += 1;
      acc.lostCents += d.amountCents;
    } else {
      acc.wonCount += 1;
      acc.wonCents += d.amountCents;
    }
  }
  return acc;
}
