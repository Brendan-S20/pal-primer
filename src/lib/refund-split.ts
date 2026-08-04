// How much of a refund comes off REVENUE, as distinct from how much left the
// bank.
//
// ── THE TWO NUMBERS ARE NOT THE SAME, AND BOTH ARE TRUE ───────────────────
//
// With fee pass-through on, a $100 invoice is charged as $103: $100 of service
// plus a $3 card surcharge the tenant is recovering, not earning. The payment
// row already keeps them apart — `amount_cents` is the invoice-applied base and
// `surcharge_cents` sits beside it, explicitly so the surcharge is "reported as
// fee recovery and never as revenue".
//
// The refund path did not honour that split. `charge.refunded` carries
// `amount_refunded` on the CHARGE, which is base + surcharge, and that figure
// went straight into the reversal ledger — the contra line every revenue
// surface subtracts. So refunding that charge in full took $103 off revenue
// that had only ever contained $100. The tenant's income was understated by
// exactly the fee they never earned in the first place, and it compounds with
// every refunded surcharged payment.
//
// The customer really did get $103 back, so the alert has to say $103. Revenue
// really should only drop by $100. Keeping one number for both is what made
// this wrong; this module produces both.
//
// ── WHY PROPORTIONAL ──────────────────────────────────────────────────────
//
// A partial refund is dollars off a charge, and Stripe does not say which
// dollars. Splitting the refunded amount in the same ratio as the original
// charge is the only division that stays consistent: refunding everything
// returns exactly the base and exactly the surcharge, refunding half returns
// half of each, and a sequence of partials sums to the whole. It also matches
// what `platform-fee.ts` already does when reversing the application fee
// (`proportion × fee`), so the two halves of a refund do not use two theories.

export type RefundSplit = {
  /** What actually left the account. What the customer sees, what the alert
   *  quotes, and what reconciles against Stripe. */
  refundedCents: number;
  /** The share attributable to invoiced service — the ONLY part that comes off
   *  revenue. */
  revenueCents: number;
  /** The share attributable to the recovered processing fee. Reported as fee
   *  recovery reversing, never as lost revenue. */
  surchargeCents: number;
};

/**
 * Split a refund into its revenue and surcharge parts.
 *
 * @param refundedCents Stripe's `amount_refunded` — CUMULATIVE across every
 *   refund on the charge, which is why callers must treat the result as a
 *   running total rather than an increment.
 * @param chargeTotalCents The charge's full amount: base + surcharge.
 * @param surchargeCents The surcharge inside that total. Zero for every payment
 *   taken before pass-through existed, and for every tenant who absorbs the fee
 *   — in which case this is a straight pass-through of the refunded amount.
 */
export function splitRefund(
  refundedCents: number,
  chargeTotalCents: number,
  surchargeCents: number,
): RefundSplit {
  const refunded = Math.max(0, Math.round(refundedCents));
  const total = Math.max(0, Math.round(chargeTotalCents));
  const surcharge = Math.max(0, Math.round(surchargeCents));

  // No surcharge, or a total that cannot be trusted to divide by. Returning the
  // refund whole is the pre-surcharge behaviour and the only safe default: it
  // can understate revenue, never overstate it, and it is exactly right for the
  // absorb-the-fee tenants who are the majority.
  if (surcharge <= 0 || total <= 0 || surcharge >= total) {
    return { refundedCents: refunded, revenueCents: refunded, surchargeCents: 0 };
  }

  // A refund larger than the charge should not exist. Clamping rather than
  // trusting it keeps a bad number from producing a negative revenue line.
  const capped = Math.min(refunded, total);
  const base = total - surcharge;
  // Round the revenue part and derive the surcharge as the remainder, so the
  // two always add back to the amount refunded — no lost or invented cent.
  const revenue = Math.round((capped * base) / total);
  return {
    refundedCents: capped,
    revenueCents: revenue,
    surchargeCents: capped - revenue,
  };
}
