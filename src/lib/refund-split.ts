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
  /** The share attributable to the customer's tip. A tip was never revenue
   *  (it sits beside `amount_cents` in `payments.tip_cents`), so giving part
   *  of it back takes nothing off revenue either. */
  tipCents: number;
};

/**
 * Split a refund into its revenue, surcharge and tip parts.
 *
 * @param refundedCents Stripe's `amount_refunded` — CUMULATIVE across every
 *   refund on the charge, which is why callers must treat the result as a
 *   running total rather than an increment.
 * @param chargeTotalCents The charge's full amount: base + surcharge + tip.
 * @param surchargeCents The surcharge inside that total. Zero for every payment
 *   taken before pass-through existed, and for every tenant who absorbs the fee
 *   — in which case this is a straight pass-through of the refunded amount.
 * @param tipCents The tip inside that total. Zero for every untipped payment,
 *   which leaves the split exactly what it was before tipping existed.
 *
 * ── WHY THE TIP IS SPLIT THE SAME WAY ─────────────────────────────────────
 *
 * The same reason the surcharge is: a partial refund is dollars off a charge
 * and Stripe does not say which dollars. A $100 invoice with a $15 tip,
 * refunded $57.50, is half of each: $50 off revenue and $7.50 of tip back. A
 * refund that "gave back the tip first" or "the service first" would be a
 * policy the office never chose, and the proportional split is the one that
 * sums to the whole across any sequence of partials.
 */
export function splitRefund(
  refundedCents: number,
  chargeTotalCents: number,
  surchargeCents: number,
  tipCents = 0,
): RefundSplit {
  const refunded = Math.max(0, Math.round(refundedCents));
  const total = Math.max(0, Math.round(chargeTotalCents));
  const surcharge = Math.max(0, Math.round(surchargeCents));
  const tip = Math.max(0, Math.round(tipCents));
  const nonRevenue = surcharge + tip;

  // No surcharge and no tip, or a total that cannot be trusted to divide by.
  // Returning the refund whole is the pre-surcharge behaviour and the only safe
  // default: it can understate revenue, never overstate it, and it is exactly
  // right for the untipped, absorb-the-fee payments that are the majority.
  if (nonRevenue <= 0 || total <= 0 || nonRevenue >= total) {
    return { refundedCents: refunded, revenueCents: refunded, surchargeCents: 0, tipCents: 0 };
  }

  // A refund larger than the charge should not exist. Clamping rather than
  // trusting it keeps a bad number from producing a negative revenue line.
  const capped = Math.min(refunded, total);
  const base = total - nonRevenue;
  // Round the revenue part and derive the rest as the remainder, so the parts
  // always add back to the amount refunded — no lost or invented cent. The
  // remainder is divided between surcharge and tip in their own ratio, the
  // tip rounded and the surcharge taking what is left, so with no tip the
  // surcharge part is exactly what it always was.
  const revenue = Math.round((capped * base) / total);
  const remainder = capped - revenue;
  const tipPart = Math.round((remainder * tip) / nonRevenue);
  return {
    refundedCents: capped,
    revenueCents: revenue,
    surchargeCents: remainder - tipPart,
    tipCents: tipPart,
  };
}
