// The platform's cut of a tenant→client payment. One definition, one file.
//
// ── THE TERM ──────────────────────────────────────────────────────────────
//
// 50 basis points (0.5%) of the full charge, on charges OVER $10. The $10 is a
// threshold, not a deduction: a $100 job is charged $0.50, not $0.45. A $10.00
// job is charged nothing, because "over $10" is strictly greater.
//
// This is a PRICING TERM, so it is a constant and not an environment variable.
// A fee that could differ between staging and production is a fee that can ship
// wrong, and "what does this tenant actually pay" must have exactly one answer
// everywhere. Changing the rate is a deliberate one-line edit with a test that
// fails until the expected numbers are updated with it.
//
// ── WHY A MODULE FOR TWO LINES OF ARITHMETIC ──────────────────────────────
//
// Ten places in `src/` create a PaymentIntent on a connected account: three in
// portal.functions.ts, five in invoices.functions.ts, one in signup.functions.ts
// and one in the unattended nightly autopay run. Adding `amount * 0.005` to nine
// of them and missing the tenth does not error, does not warn, and does not show
// up in any test — it just quietly does not collect on whichever path was
// missed. The nightly run is the likely one, because nobody watches it.
//
// This repo has already paid for that shape twice: twenty-four hardcoded app
// hosts that disagreed, and one revenue figure with three implementations
// (BUG-21). So: one function, and `tests/the-platform-fee-has-one-definition.
// test.ts` asserts that no connected-account charge is built without it.
//
// ── HOW STRIPE APPLIES IT ─────────────────────────────────────────────────
//
// Every tenant charge is a DIRECT charge — created with `{ stripeAccount }`, so
// it lives on the tenant's own connected account and settles into their balance.
// `application_fee_amount` moves just the fee to the platform. The gross never
// touches the platform balance, which is why one Stripe account is enough: it
// holds subscription revenue and these fees, both of which are ours, and no part
// of a tenant's or a homeowner's money.
//
// ── REFUNDS ───────────────────────────────────────────────────────────────
//
// Stripe does NOT reverse an application fee when a connected account refunds a
// charge — the tenant would be out the refunded amount AND our fee. That is a
// policy decision, and the decision here is to give it back proportionally. See
// `feeReversalCents` below and the `charge.refunded` branch of the Connect
// webhook, which is the only place a refund is ever learned about (the app never
// calls `refunds.create`; tenants refund from their own Stripe dashboard).

/** Basis points. 50 bps = 0.5%. */
export const PLATFORM_FEE_BPS = 50;

/**
 * Charges at or below this collect nothing.
 *
 * Strictly greater, so exactly $10.00 is free and $10.01 is not. The floor
 * exists so a sub-dollar transaction does not carry a fee that costs more in
 * explanation than it earns.
 */
export const PLATFORM_FEE_THRESHOLD_CENTS = 1000;

/**
 * The platform fee on a charge, in whole cents.
 *
 * Rounded to the nearest cent — `application_fee_amount` must be an integer, and
 * truncating would give away a fraction of a cent on most transactions for no
 * reason. Returns 0 for anything at or below the threshold, and for input that
 * is not a usable amount, because a NaN reaching Stripe as an application fee
 * fails the whole charge and the customer's payment is what matters most.
 */
export function platformFeeCents(amountCents: number): number {
  if (!Number.isFinite(amountCents)) return 0;
  const amount = Math.floor(amountCents);
  if (amount <= PLATFORM_FEE_THRESHOLD_CENTS) return 0;
  return Math.round((amount * PLATFORM_FEE_BPS) / 10_000);
}

/**
 * How much of the fee to hand back, given how much of the charge has been
 * refunded — expressed as the TOTAL that should have been reversed by now, not
 * an increment.
 *
 * That distinction is the whole reason this is a named function. Stripe fires
 * `charge.refunded` once per refund and `amount_refunded` is CUMULATIVE, so a
 * handler that reverses `proportion × fee` on every event over-refunds the fee
 * on the second partial refund and every one after it. The caller subtracts what
 * Stripe says has already been returned and sends only the difference, which
 * also makes a replayed webhook a no-op.
 *
 * @param feeCents        the application fee originally taken
 * @param chargeCents     the charge's full amount
 * @param refundedCents   cumulative amount refunded so far
 */
export function feeReversalCents(
  feeCents: number,
  chargeCents: number,
  refundedCents: number,
): number {
  if (!Number.isFinite(feeCents) || !Number.isFinite(chargeCents)) return 0;
  if (!Number.isFinite(refundedCents)) return 0;
  if (feeCents <= 0 || chargeCents <= 0 || refundedCents <= 0) return 0;
  // A refund cannot exceed the charge, but clamp rather than trust: over-
  // refunding our own fee would be a real loss, and Stripe rejects a fee refund
  // larger than the fee with an error that would mask the rest of the handler.
  const refunded = Math.min(refundedCents, chargeCents);
  return Math.min(feeCents, Math.round((feeCents * refunded) / chargeCents));
}
