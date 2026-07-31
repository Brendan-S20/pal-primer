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
};

/** Gross received across a set of payment rows. Rows that never reached the
 *  account (pending, failed) are ignored even if the caller forgot to filter —
 *  counting a failed card as revenue is the other direction of the same
 *  mistake, and one call site was doing exactly that. */
export function grossReceivedCents(rows: ReceiptLike[]): number {
  let total = 0;
  for (const r of rows) {
    if (!paymentWasReceived(r.status)) continue;
    total += r.amount_cents ?? 0;
  }
  return total;
}
