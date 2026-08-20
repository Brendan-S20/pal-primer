// The reversal trail on a settlement statement — BUG-26's readback.
//
// `record_franchise_adjustment` has always written `reversed_at` and
// `reversed_by_adjustment_id`, and until now nothing read either. So when a
// franchise won a chargeback and the location was repaid, the statement showed
// a credit that nothing in the product could explain: the deduction was on one
// statement, the repayment on another, and the only thing joining them was a
// foreign key no screen followed.
//
// This module turns a row of `franchise_adjustment_ledger()` into the sentence
// a franchisee needs when they query a deduction. It is deliberately pure —
// every date it prints is the ISO day the database recorded, so the two sides
// of a franchise reading the same statement in different timezones read the
// same words.

export type AdjustmentLedgerRow = {
  id: string;
  child_organization_id: string;
  child_name: string | null;
  payment_id: string | null;
  kind: string;
  status: string;
  amount_cents: number;
  franchise_share_cents: number;
  location_share_cents: number;
  collected_by_parent: boolean | null;
  note: string | null;
  dispute_ref: string | null;
  created_at: string;
  settlement_id: string | null;
  settlement_period_start: string | null;
  settlement_period_end: string | null;
  settlement_status: string | null;
  reversed_at: string | null;
  reversed_by_adjustment_id: string | null;
  repaid_amount_cents: number | null;
  repaid_at: string | null;
  repaid_settlement_id: string | null;
  repaid_settlement_period_start: string | null;
  repaid_settlement_period_end: string | null;
  repaid_settlement_status: string | null;
  repays_adjustment_id: string | null;
  repays_amount_cents: number | null;
  repays_created_at: string | null;
  repays_settlement_period_start: string | null;
  repays_settlement_period_end: string | null;
};

export type AdjustmentLine = {
  id: string;
  locationName: string;
  locationOrgId: string;
  kindLabel: string;
  /** A compensating adjustment raised because a dispute was won (BUG-26). */
  isRepayment: boolean;
  amountCents: number;
  /** What this line does to the location's settlement balance. Negative = the
   *  location receives that much less; positive = the franchise owes it back. */
  effectCents: number;
  billedPeriod: string | null;
  billedStatus: string | null;
  stateLabel: string;
  /** The sentence that joins a deduction to the repayment that cancelled it —
   *  or a repayment to the deduction it cancels. Null when there is no trail. */
  trail: string | null;
  /** The other half of the pair, so a UI can scroll to or highlight it. */
  linkedAdjustmentId: string | null;
  /** True when a billed deduction was reversed and nothing repaid it. Not a
   *  normal outcome — surfaced rather than smoothed over. */
  needsAttention: boolean;
  disputeRef: string | null;
  note: string | null;
};

const KIND_LABELS: Record<string, string> = {
  refund: "Refund",
  chargeback: "Chargeback",
  chargeback_won: "Chargeback won",
  manual: "Manual adjustment",
};

export function adjustmentKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replace(/_/g, " ");
}

/** "$1,000.00" — cents, always signed positive here; callers add the sign. */
export function centsToUsd(cents: number): string {
  const v = Math.abs(cents) / 100;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The ISO day of a timestamp, which is what the database recorded. */
export function isoDay(ts: string | null | undefined): string | null {
  if (!ts) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(ts);
  return m ? m[1] : null;
}

export function periodLabel(start: string | null, end: string | null): string | null {
  if (!start || !end) return null;
  return `${start} → ${end}`;
}

/**
 * What this line does to the location's settlement balance.
 *
 * Mirrors the arithmetic in `generate_franchise_settlements` (BUG-24): the
 * settlement only settles the half the OTHER party is carrying. If the parent
 * collected the money, the location's share is deducted from what the parent
 * pays over; if the location collected it, the refund already left their own
 * account and it is the FRANCHISE's share that has to come back to them.
 *
 * Getting this backwards is the BUG-24 shape — every figure still looks like a
 * plausible number, it is just the wrong side of the ledger.
 */
export function settlementEffectCents(row: AdjustmentLedgerRow): number {
  return row.collected_by_parent
    ? -Number(row.location_share_cents ?? 0)
    : Number(row.franchise_share_cents ?? 0);
}

function stateLabelFor(row: AdjustmentLedgerRow): string {
  if (row.status === "reversed") {
    const day = isoDay(row.reversed_at);
    return day ? `Reversed ${day}` : "Reversed";
  }
  if (row.status === "written_off") return "Written off";
  if (row.status === "applied") {
    const period = periodLabel(row.settlement_period_start, row.settlement_period_end);
    if (!period) return "On a statement";
    return row.settlement_status === "draft"
      ? `On the draft ${period} statement`
      : `Billed on the ${period} statement`;
  }
  return "Carries into the next statement";
}

/**
 * The trail sentence. Four distinct situations, and saying the wrong one is
 * worse than saying nothing:
 *
 *   1. reversed, repayment raised and already settled  → it has been paid back
 *   2. reversed, repayment raised, not yet settled     → it will be, and when
 *   3. reversed with no repayment, never billed        → nothing was ever taken
 *   4. reversed with no repayment but ALREADY billed   → money is missing
 *
 * (4) should be impossible — `record_franchise_adjustment` raises the
 * compensating adjustment whenever the original left draft — so it is reported
 * rather than hidden behind a reassuring (3).
 */
export function reversalTrail(row: AdjustmentLedgerRow): string | null {
  // A repayment line, read backwards: which deduction does this cancel?
  if (row.repays_adjustment_id) {
    const period = periodLabel(
      row.repays_settlement_period_start,
      row.repays_settlement_period_end,
    );
    const amount = centsToUsd(Number(row.repays_amount_cents ?? row.amount_cents));
    const when = isoDay(row.repays_created_at);
    return period
      ? `Repays the ${amount} chargeback deducted on the ${period} statement.`
      : `Repays the ${amount} chargeback recorded${when ? ` ${when}` : ""}.`;
  }

  if (row.status !== "reversed") return null;

  const reversedOn = isoDay(row.reversed_at);
  const reversedPhrase = reversedOn ? `Reversed ${reversedOn}` : "Reversed";

  if (row.reversed_by_adjustment_id) {
    const amount = centsToUsd(Number(row.repaid_amount_cents ?? row.amount_cents));
    const repaidPeriod = periodLabel(
      row.repaid_settlement_period_start,
      row.repaid_settlement_period_end,
    );
    if (repaidPeriod && row.repaid_settlement_status && row.repaid_settlement_status !== "draft") {
      return `${reversedPhrase}. The ${amount} was repaid on the ${repaidPeriod} statement.`;
    }
    if (repaidPeriod) {
      return `${reversedPhrase}. The ${amount} repayment is on the draft ${repaidPeriod} statement.`;
    }
    return `${reversedPhrase}. The ${amount} repayment carries into the next statement.`;
  }

  const wasBilled =
    !!row.settlement_id && !!row.settlement_status && row.settlement_status !== "draft";
  if (wasBilled) {
    const period = periodLabel(row.settlement_period_start, row.settlement_period_end);
    return (
      `${reversedPhrase}, but it had already been billed on the ${period ?? "previous"} statement ` +
      `and no repayment has been raised. Ask your franchise to check this one.`
    );
  }
  return `${reversedPhrase} before any statement billed it, so nothing was deducted.`;
}

export function describeAdjustment(row: AdjustmentLedgerRow): AdjustmentLine {
  const isRepayment = !!row.repays_adjustment_id || row.kind === "chargeback_won";
  const wasBilled =
    !!row.settlement_id && !!row.settlement_status && row.settlement_status !== "draft";
  return {
    id: row.id,
    locationName: row.child_name ?? "This location",
    locationOrgId: row.child_organization_id,
    kindLabel: adjustmentKindLabel(row.kind),
    isRepayment,
    amountCents: Number(row.amount_cents ?? 0),
    effectCents: settlementEffectCents(row),
    billedPeriod: periodLabel(row.settlement_period_start, row.settlement_period_end),
    billedStatus: row.settlement_status,
    stateLabel: stateLabelFor(row),
    trail: reversalTrail(row),
    linkedAdjustmentId: row.reversed_by_adjustment_id ?? row.repays_adjustment_id ?? null,
    needsAttention: row.status === "reversed" && !row.reversed_by_adjustment_id && wasBilled,
    disputeRef: row.dispute_ref,
    note: row.note,
  };
}

export type LedgerSummary = {
  lines: AdjustmentLine[];
  /** Money taken off this location's settlements and not given back. */
  deductedCents: number;
  /** Money given back by a won dispute. */
  repaidCents: number;
  /** Lines not yet on any statement. */
  openCents: number;
  reversedCount: number;
  needsAttentionCount: number;
};

export function summariseLedger(rows: AdjustmentLedgerRow[]): LedgerSummary {
  const lines = rows.map(describeAdjustment);
  let deductedCents = 0;
  let repaidCents = 0;
  let openCents = 0;
  let reversedCount = 0;
  let needsAttentionCount = 0;

  rows.forEach((row, i) => {
    const line = lines[i];
    if (row.status === "reversed") {
      // A reversed deduction was cancelled: it is not money still held. Its
      // repayment, if one was raised, is its own line and is counted there.
      reversedCount += 1;
      if (line.needsAttention) needsAttentionCount += 1;
      return;
    }
    if (row.status === "written_off") return;
    const effect = line.effectCents;
    if (effect < 0) deductedCents += -effect;
    else repaidCents += effect;
    if (row.status === "pending") openCents += effect;
  });

  return { lines, deductedCents, repaidCents, openCents, reversedCount, needsAttentionCount };
}
