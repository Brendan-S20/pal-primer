// What a settlement statement SAYS, in one place, for every surface that shows
// one.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// `generate_franchise_settlements` writes six figures per statement:
// `revenue_cents`, `royalty_percent`, `royalty_cents` (also copied to
// `amount_cents`), `adjustments_applied_cents`, `direction` and
// `net_due_cents`. The last two are the ones that say what actually happens —
// `direction` names who pays whom and `net_due_cents` is how much.
//
// Only the CPA report pack read them. The `/franchise` screen — the one with
// the Issue button on it — selected neither, and rendered the ROYALTY as the
// headline figure. The royalty is not what changes hands:
//
//     balance = revenue_the_franchise_collected − (total_revenue × royalty%)
//
// so under parent-collection the arrow reverses. A statement where the
// franchise owes the location $900 and one where the location owes the
// franchise $100 both rendered as a row reading "Royalty $100", with no
// indication of which way the money goes. The franchise owner marks that
// "paid" from a screen that never told them who was paying.
//
// The CPA pack had the labels right and was the only place they existed, which
// is the same shape as the last docs audit: a thing fixed in one of two places.
// So the vocabulary moved here and all three surfaces read it from one
// definition.
//
// ── AUDIENCE IS NOT DECORATION ────────────────────────────────────────────
//
// "You owe the franchise" and "The location owes you" are the SAME row. Which
// sentence is true depends on who is reading, and getting it backwards tells
// someone they are owed money they in fact owe. That is why the audience is a
// required argument rather than a default — there is no sensible fallback for
// "I don't know who is looking at this".

export type SettlementDirection = "franchise_owes_location" | "location_owes_franchise" | "settled";

/** Who is reading. Not a formatting preference — see the note above. */
export type SettlementAudience = "franchise" | "location";

/** The columns every settlement surface needs, named as the table names them. */
export type SettlementRow = {
  id: string;
  period_start: string;
  period_end: string;
  revenue_cents: number | string | null;
  royalty_percent: number | string | null;
  royalty_cents?: number | string | null;
  amount_cents?: number | string | null;
  adjustments_applied_cents?: number | string | null;
  /** How the period's revenue split by WHO ACTUALLY HELD IT. Absent when the
   *  caller's query did not select them — see `collectedByFranchiseCents`. */
  revenue_collected_by_parent_cents?: number | string | null;
  revenue_collected_by_location_cents?: number | string | null;
  /** Sales tax the franchise's account took in for the location. The
   *  location's liability, so owed to it in full and carrying no royalty. */
  sales_tax_collected_by_parent_cents?: number | string | null;
  direction: string | null;
  net_due_cents: number | string | null;
  status: string | null;
};

/** What this statement does to the reader's own bank balance. */
export type SettlementFlow = "incoming" | "outgoing" | "settled";

export type SettlementLine = {
  id: string;
  period: string;
  revenueCents: number;
  royaltyPercent: number;
  royaltyCents: number;
  adjustmentsCents: number;
  netDueCents: number;
  /** Of `revenueCents`, how much the FRANCHISE's own Stripe account received.
   *
   *  `null` — not zero — when the query did not select the column, because the
   *  two mean opposite things: zero is "the location collected all of it" and
   *  is worth printing, while null is "this surface cannot say" and must not be
   *  printed as if it could.
   *
   *  Without it the statement's own arithmetic does not close on a mixed
   *  period. `net_due = |collected_by_franchise − royalty − adjustments|`, and
   *  the line printed revenue, royalty and adjustments but never
   *  `collected_by_franchise` — so a period where the franchise collected half
   *  showed a net that followed from none of the numbers beside it. */
  collectedByFranchiseCents: number | null;
  /** Sales tax the franchise collected on the location's behalf. Not revenue
   *  (it is not in `revenueCents`, and carries no royalty), and passed to the
   *  location whole, so with it the statement's arithmetic is
   *  net = |collected_by_franchise + tax_held_by_franchise − royalty − adjustments|.
   *  0 when the query did not select it, or there was no tax — which is every
   *  statement of a franchise whose locations never set a tax rate. */
  taxHeldByFranchiseCents: number;
  direction: SettlementDirection;
  /** "The franchise owes you", "You owe the franchise", … */
  directionLabel: string;
  flow: SettlementFlow;
  status: string;
  statusLabel: string;
  /** True once the statement has been issued — i.e. it is a bill rather than a
   *  number the franchise is still working on. */
  isIssued: boolean;
};

const DIRECTIONS: Record<SettlementDirection, Record<SettlementAudience, string>> = {
  franchise_owes_location: {
    franchise: "You owe the location",
    location: "The franchise owes you",
  },
  location_owes_franchise: {
    franchise: "The location owes you",
    location: "You owe the franchise",
  },
  settled: {
    franchise: "Settled, nothing to move",
    location: "Settled, nothing to move",
  },
};

/**
 * Which way the money goes, said from the reader's side.
 *
 * An unrecognised direction is returned verbatim rather than guessed at. The
 * column is a text column with a default, so a value this module has never
 * heard of is possible; printing it raw is ugly and honest, whereas defaulting
 * to either real direction is neither.
 */
export function settlementDirectionLabel(
  direction: string | null | undefined,
  audience: SettlementAudience,
): string {
  const known = DIRECTIONS[direction as SettlementDirection];
  return known ? known[audience] : (direction ?? "-");
}

/**
 * What the statement does to the reader's own bank balance, which is what
 * decides whether a figure is rendered as money in or money out.
 *
 * Deliberately derived from `direction` and the audience together rather than
 * stored: the same row is incoming for one party and outgoing for the other,
 * so a single stored "is this a credit" flag would have to be wrong for
 * somebody.
 */
export function settlementFlow(
  direction: string | null | undefined,
  audience: SettlementAudience,
): SettlementFlow {
  if (direction === "settled") return "settled";
  if (direction === "franchise_owes_location") {
    return audience === "location" ? "incoming" : "outgoing";
  }
  if (direction === "location_owes_franchise") {
    return audience === "location" ? "outgoing" : "incoming";
  }
  return "settled";
}

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft, not yet agreed",
  issued: "Issued",
  paid: "Paid",
  void: "Voided",
};

export function settlementStatusLabel(status: string | null | undefined): string {
  return STATUS_LABELS[status ?? ""] ?? status ?? "-";
}

/**
 * A draft is not a bill. `generate_franchise_settlements` rewrites drafts —
 * a late adjustment moves the figures underneath — and only stops once the
 * statement leaves draft. Showing a location a number that is still moving
 * invites them to reconcile against it and be wrong.
 *
 * One exception, and it is not this module's to fix: the ROYALTY PERCENTAGE
 * does not move. The generator reads the rate from the existing statement for
 * the period before it reads the location's configured rate, and that lookup is
 * not conditioned on the statement being past draft — while the ON CONFLICT
 * guard already makes issued statements untouchable on its own. So the freeze
 * can only ever bite a draft, which is the one row it should not. Reported
 * 2026-08-19 rather than fixed here; the fix is one predicate in SQL.
 *
 * So issuing is what DELIVERS a statement, and this is the predicate that says
 * so. A voided statement stays visible: there is no `issued_at` column, so a
 * void that was never issued cannot be told from one that was withdrawn after
 * the location had already seen it, and of the two possible errors — telling a
 * location about a statement that never reached them, or silently retracting
 * one that did — only the second is the kind this product has a rule against.
 */
export function settlementIsDelivered(status: string | null | undefined): boolean {
  return status !== "draft";
}

const num = (v: number | string | null | undefined): number => Number(v ?? 0);

export function describeSettlement(
  row: SettlementRow,
  audience: SettlementAudience,
): SettlementLine {
  const direction = (row.direction ?? "location_owes_franchise") as SettlementDirection;
  const status = row.status ?? "draft";
  return {
    id: row.id,
    period: `${row.period_start} → ${row.period_end}`,
    revenueCents: num(row.revenue_cents),
    royaltyPercent: num(row.royalty_percent),
    // `royalty_cents` and `amount_cents` are written from the same expression;
    // preferring the named one and falling back keeps this working against a
    // query that selected only the older column.
    royaltyCents: num(row.royalty_cents ?? row.amount_cents),
    adjustmentsCents: num(row.adjustments_applied_cents),
    netDueCents: num(row.net_due_cents),
    collectedByFranchiseCents:
      row.revenue_collected_by_parent_cents == null
        ? null
        : num(row.revenue_collected_by_parent_cents),
    taxHeldByFranchiseCents: num(row.sales_tax_collected_by_parent_cents),
    direction,
    directionLabel: settlementDirectionLabel(direction, audience),
    flow: settlementFlow(direction, audience),
    status,
    statusLabel: settlementStatusLabel(status),
    isIssued: settlementIsDelivered(status),
  };
}

/** "$1,000.00" from cents. Sign is the caller's to add — see `flow`. */
export function settlementMoney(cents: number): string {
  return `$${(Math.abs(cents) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * "-$50.00" from cents, for a figure whose SIGN is part of what it says.
 *
 * `settlementMoney` takes an absolute value on purpose: `net_due_cents` is
 * always positive and its direction is carried by `direction`, so printing it
 * unsigned and letting `flow` add the arrow is right. `adjustments_applied_cents`
 * is not that kind of number. It is
 *
 *     loc_owes − fran_owes
 *
 * an input to `balance = collected_by_franchise − royalty − adjustments`, and
 * it goes NEGATIVE whenever the franchise is the one absorbing a reversal —
 * which is every refund on a location-collected charge at a location set to
 * `chargeback_responsibility = 'franchise'`, the whole point of that setting,
 * and every won-dispute repayment, whose shares are stored negated.
 *
 * Run through `settlementMoney` those came out as "adjustments $50.00" — a
 * credit printed as a charge, on the line whose job is to let both sides check
 * the arithmetic behind the net. Nothing else on the statement disagreed
 * loudly enough to notice: the net itself was right, so the only symptom was a
 * statement that did not add up.
 */
export function settlementSignedMoney(cents: number): string {
  return `${cents < 0 ? "-" : ""}${settlementMoney(cents)}`;
}
