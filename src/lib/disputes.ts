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
//   payment_chargeback        the bank pulled the money      (money moved)
//   payment_chargeback_won    we won it back                 (money moved)
//   payment_chargeback_lost   it closed against us           (no money moves)
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

export const DISPUTE_OUTCOMES = ["open", "won", "lost"] as const;
export type DisputeOutcome = (typeof DISPUTE_OUTCOMES)[number];

/** The reversal-queue kinds that describe a dispute's life. */
export const DISPUTE_KINDS = [
  "payment_chargeback",
  "payment_chargeback_won",
  "payment_chargeback_lost",
] as const;

export type DisputeEvent = {
  kind: string;
  /** Org-local day the event was filed. */
  day: string;
  amountCents: number;
};

export type Dispute = {
  paymentId: string;
  outcome: DisputeOutcome;
  amountCents: number;
  /** When the bank took the money. */
  openedOn: string;
  /** When it was decided, if it has been. */
  decidedOn: string | null;
};

/**
 * Fold a payment's dispute events into one state.
 *
 * A payment can carry at most one of each kind (the review queue is unique on
 * organization + kind + subject), so this is a small fixed set rather than a
 * general event stream.
 */
export function disputeFrom(paymentId: string, events: DisputeEvent[]): Dispute | null {
  const opened = events.find((e) => e.kind === "payment_chargeback");
  // No opening event means no dispute. A `won` or `lost` on its own would be a
  // webhook we received out of order or a payment whose opening we missed —
  // either way we cannot say what was disputed or for how much, so it is not
  // rendered as a dispute rather than rendered as a guess.
  if (!opened) return null;

  const won = events.find((e) => e.kind === "payment_chargeback_won");
  const lost = events.find((e) => e.kind === "payment_chargeback_lost");

  // A win beats a loss if both somehow exist. Money came back in the win, and
  // the loss record moves nothing — treating it as lost would tell the owner
  // they are out money they are actually holding.
  const decided = won ?? lost;
  return {
    paymentId,
    outcome: won ? "won" : lost ? "lost" : "open",
    amountCents: opened.amountCents,
    openedOn: opened.day,
    decidedOn: decided?.day ?? null,
  };
}

/** Group raw events by payment and fold each. */
export function disputesFrom(
  events: Array<DisputeEvent & { paymentId: string | null }>,
): Dispute[] {
  const byPayment = new Map<string, DisputeEvent[]>();
  for (const e of events) {
    if (!e.paymentId) continue;
    if (!(DISPUTE_KINDS as readonly string[]).includes(e.kind)) continue;
    byPayment.set(e.paymentId, [...(byPayment.get(e.paymentId) ?? []), e]);
  }
  return [...byPayment.entries()]
    .map(([paymentId, evts]) => disputeFrom(paymentId, evts))
    .filter((d): d is Dispute => d !== null)
    .sort((a, b) => b.openedOn.localeCompare(a.openedOn));
}

export const DISPUTE_COPY: Record<
  DisputeOutcome,
  { label: string; tone: "danger" | "warn" | "ok"; whatItMeans: string }
> = {
  open: {
    label: "Open — money withdrawn",
    tone: "warn",
    whatItMeans:
      "The bank has taken this money back while the customer's claim is reviewed. You have a limited window to submit evidence in Stripe; after that the decision is made without it.",
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
  if (outcome === "won") return false;
  if (outcome === "lost") return true;
  return !includeOpenDisputes;
}

/** Totals for the queue header, so "3 open" and the money agree. */
export function summarizeDisputes(disputes: Dispute[]) {
  const acc = {
    openCount: 0,
    openCents: 0,
    lostCount: 0,
    lostCents: 0,
    wonCount: 0,
    wonCents: 0,
  };
  for (const d of disputes) {
    if (d.outcome === "open") {
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
