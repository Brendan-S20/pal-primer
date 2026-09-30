// IMP-10 — the canonical definition of tenant REVENUE.
//
// Before this file there were six implementations split three ways
// (`payments.paid_at`, `payments.created_at`, and paid-invoices-by-`issued_at`),
// no shared helper, and nothing claiming authority. That is how BUG-21 got in:
// a rule that lives in six places is a rule nobody owns.
//
// ── THE RULE ───────────────────────────────────────────────────────────────
//
//   Revenue for a period is the money that ARRIVED in that period.
//   A reversal is a separate event, deducted in the period IT happened.
//   A past period is never re-derived from today's payment status.
//
// ── WHY `status = 'succeeded'` IS THE WRONG FILTER ─────────────────────────
//
// When a refund or chargeback lands, the Stripe webhook sets
// payments.status = 'refunded'. A query filtering on 'succeeded' therefore
// stops counting the ORIGINAL RECEIPT — retroactively, everywhere, forever.
// March's revenue changes in October. Nothing announces it. If March was
// already reported to an accountant, already settled with a franchise, or
// already used to bill a royalty, the number that was right is now silently
// different from the number in the filing.
//
// `refunded` means the money arrived and later went back. Both facts are true
// and both need to be visible, in their own periods.
//
// ── WHY NOT NET THE REFUND INTO REVENUE ────────────────────────────────────
//
// Because refunds cross period boundaries. Netting works when the refund falls
// in the same period as the sale and misstates every case where it doesn't —
// which is most of them, since disputes take weeks. Receipt where it happened,
// reversal where it happened, is the only treatment that survives the boundary,
// and it is what an accountant expects now that BUILD-13 hands these numbers
// over.
//
// ── WHAT THIS DOES NOT COVER ───────────────────────────────────────────────
//
// Invoice-based revenue (`/reports`, `/analytics`, the dashboard) is a
// different question — what was BILLED, not what was banked — and has its own
// answer in `ar.ts`. The two are reconciled by BUILD-13's cash-to-accrual
// bridge rather than by pretending either one is "the" revenue.

/** Payment statuses that mean the money reached the account.
 *
 *  Mirrored in SQL by generate_franchise_settlements and franchise_rollup; a
 *  test replays the migration against this list so the two cannot drift, the
 *  same guard IMP-3 put on permissions. */
export const RECEIVED_PAYMENT_STATUSES = ["succeeded", "refunded"] as const;

export type ReceivedPaymentStatus = (typeof RECEIVED_PAYMENT_STATUSES)[number];

/** Did this payment's money actually arrive? */
export function paymentWasReceived(status: string | null | undefined): boolean {
  return (RECEIVED_PAYMENT_STATUSES as readonly string[]).includes(status ?? "");
}

/** Mutable copy for query builders — PostgREST's `.in()` wants a plain array,
 *  and passing the readonly tuple straight in is rejected.
 *
 *  The return type stays the literal union rather than `string[]` so the
 *  generated Supabase types still check the call: a typo here would otherwise
 *  compile and return nothing at runtime. */
export function receivedPaymentStatuses(): ReceivedPaymentStatus[] {
  return [...RECEIVED_PAYMENT_STATUSES];
}

export type ReceiptLike = {
  amount_cents?: number | null;
  status?: string | null;
  /** Card processing recovered from the payer. Carried on the row, never
   *  summed here: it is fee recovery, not revenue. */
  surcharge_cents?: number | null;
  /** The customer's tip. Carried on the row, never summed here: a tip is not
   *  payment for the service, and it has its own report (Tips received). */
  tip_cents?: number | null;
  /** The sales-tax share INSIDE amount_cents (payments.tax_cents, filled by
   *  the database pro rata from the invoice). Tax collected is owed to the
   *  state: subtracted from revenue here, summed on its own by
   *  `taxReceivedCents`. Zero on every payment against an untaxed invoice,
   *  which is every payment of a business that never set a rate. */
  tax_cents?: number | null;
};

/** Gross received across a set of payment rows — `amount_cents` less its
 *  sales-tax share, which is the invoice-applied amount on every row minus the
 *  part of it that belongs to the state. The surcharge and the tip sit beside
 *  it and are deliberately left out.
 *
 *  Gross received across a set of payment rows. Rows that never reached the
 *  account (pending, failed) are ignored even if the caller forgot to filter —
 *  counting a failed card as revenue is the other direction of the same
 *  mistake, and one call site was doing exactly that. */
export function grossReceivedCents(rows: ReceiptLike[]): number {
  let total = 0;
  for (const r of rows) {
    if (!paymentWasReceived(r.status)) continue;
    total += revenueCentsOf(r);
  }
  return total;
}

/** One payment's revenue: what it applied to the invoice, less the tax share
 *  inside that. The only per-row definition, so a caller summing rows itself
 *  cannot count the tax by summing the wrong column. */
export function revenueCentsOf(r: Pick<ReceiptLike, "amount_cents" | "tax_cents">): number {
  return (r.amount_cents ?? 0) - Math.max(0, r.tax_cents ?? 0);
}

/** Sales tax received across a set of payment rows, on the same "did the
 *  money arrive" rule as revenue. A liability, reported by the accountant
 *  pack's Sales tax collected sheet and never added to income. */
export function taxReceivedCents(rows: ReceiptLike[]): number {
  let total = 0;
  for (const r of rows) {
    if (!paymentWasReceived(r.status)) continue;
    total += Math.max(0, r.tax_cents ?? 0);
  }
  return total;
}

/** Tips received across a set of payment rows, on the same "did the money
 *  arrive" rule as revenue. Kept apart from `grossReceivedCents` so no caller
 *  can add a tip into revenue by summing the wrong helper. */
export function tipsReceivedCents(rows: ReceiptLike[]): number {
  let total = 0;
  for (const r of rows) {
    if (!paymentWasReceived(r.status)) continue;
    total += Math.max(0, r.tip_cents ?? 0);
  }
  return total;
}
