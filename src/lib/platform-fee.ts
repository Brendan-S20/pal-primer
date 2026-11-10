// The platform's cut of a tenant→client payment. One definition, one file.
//
// Taken on REVENUE only: the sales tax inside an invoice's amount is the
// state's, so `platformFeeCents(amount, invoice)` takes the fee on
// `preTaxShareCents(amount, invoice)` (src/lib/sales-tax.ts).
import { preTaxShareCents } from "@/lib/sales-tax";
//
// ── THE TERM ──────────────────────────────────────────────────────────────
//
// ZERO, as of 2026-09-08. `platformFeeCents()` returns undefined for every
// amount, so `application_fee_amount` is omitted from every charge and nothing
// is taken for the platform. What a payment costs a tenant is what Stripe
// charges their own connected account, and nothing else.
//
// It was 50 bps of the full charge, on charges over $10. Why it is not any more
// is a PRICING decision, not a cleanup:
//
//   HoundStack now posts a card rate the way the rest of the category does --
//   2.9% + 30 cents. On a DIRECT charge that number is Stripe's, billed to the
//   tenant's own account (see "HOW STRIPE APPLIES IT" below). Charging 50 bps
//   on top made a tenant's real cost about 3.4% while the page said 2.9%, and
//   no choice of words fixes a number that is simply larger than the published
//   one. So the fee comes off until the charge routes through the platform.
//
// The machinery is left standing rather than deleted, because the fee returns
// in a different shape. Once platform pricing is configured on the live Connect
// profile and charges become destination charges, Stripe bills the PLATFORM at
// whatever volume rate has been negotiated, the posted price stays 2.9% + 30
// cents, and the spread is the margin. Tenants on the books at that point are
// grandfathered by construction: the price they were quoted never moved.
//
// Turning it back on is this one constant. Every call site, the refund
// reversal, the franchise settlement split, and the coverage test that refuses
// a charge built without the fee are all still here and still exercised at
// zero -- which is the point of setting the rate rather than ripping the wiring
// out and rebuilding it under time pressure later.
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
// While the rate is zero the helper returns undefined rather than 0, so the key
// is absent from the params object entirely. Stripe documents the field as an
// optional integer and does not forbid 0, but "charge no fee" and "charge a fee
// of nothing" are not worth distinguishing on a live payment path, and omitting
// it is the behaviour Stripe unambiguously specifies.
//
// ── REFUNDS ───────────────────────────────────────────────────────────────
//
// Stripe does NOT reverse an application fee when a connected account refunds a
// charge — the tenant would be out the refunded amount AND our fee. That is a
// policy decision, and the decision here is to give it back proportionally. See
// `feeReversalCents` below and the `charge.refunded` branch of the Connect
// webhook, which is the only place a refund is ever learned about.
//
// "Learned about" rather than "issued" for every refund a TENANT makes. Those
// go either through the embedded Stripe payments component on the Payments
// page, or through Refund on the invoice (`refundInvoicePayment`,
// src/lib/refunds.server.ts) — both on the tenant's own connected account —
// and in BOTH cases the webhook is how the ledger finds out. The invoice path
// deliberately does not pass `refund_application_fee`, so that this
// proportional reversal stays the one place our fee comes back; refunds.server.ts
// says why. That is also why the refund ledger has to be correct about
// redelivery and partials: the ledger is written from Stripe's word, never
// from the request that asked for the refund.
//
// There is exactly ONE refund this app issues that is deliberately not routed
// through `feeReversalCents`: `provisionSignup` in the Connect
// webhook, when a public signup's card settled and provisioning then failed.
// That call passes `refund_application_fee: true`, so Stripe reverses the fee
// in the same operation rather than the webhook learning about it afterwards —
// the charge is being unwound in full by us, so there is nothing to apportion.
// The exception is a fee that carries a Stripe cost passed through to the
// business (the Radar fee, #825, docs/stripe-connect-fees.md): Stripe keeps
// that on a refund, so the fee is kept rather than handed back.
// It also writes no `payments` row, which is why the `charge.refunded` branch
// finds nothing to reconcile and correctly does nothing.

/**
 * Basis points. Currently 0 -- see "THE TERM" above.
 *
 * 50 would be 0.5%. This is a PRICING TERM, so it is a constant and not an
 * environment variable: a fee that could differ between staging and production
 * is a fee that can ship wrong, and "what does this tenant actually pay" must
 * have exactly one answer everywhere.
 */
export const PLATFORM_FEE_BPS = 0;

/**
 * Charges at or below this collect nothing.
 *
 * Strictly greater, so exactly $10.00 is free and $10.01 is not. The floor
 * exists so a sub-dollar transaction does not carry a fee that costs more in
 * explanation than it earns.
 *
 * Inert while PLATFORM_FEE_BPS is 0 -- everything is free -- and kept because
 * the floor is part of the term, not part of the rate. It applies again the
 * moment the rate does.
 */
export const PLATFORM_FEE_THRESHOLD_CENTS = 1000;

/**
 * HoundStack's own cut as a sentence fragment, or null when there is not one.
 *
 * NULL IS THE POINT. Every surface that tells a tenant what a payment costs has
 * to name this fee when it exists and stay silent when it does not, and both
 * halves are real faults: naming a fee of zero overstates what leaves their
 * account, and omitting a live one is the surprise the franchise copy already
 * had to be corrected for. Deriving the sentence from the constant means the
 * next rate change updates every surface, rather than leaving whichever one
 * somebody forgot saying the wrong thing.
 *
 * Reads the threshold as well as the rate, because "0.5%" alone is not the
 * term -- a $10 job is free, and a tenant who works out our cut from a small
 * ticket and gets a different answer is entitled to think the number is a lie.
 */
export function describePlatformFee(): string | null {
  if (PLATFORM_FEE_BPS <= 0) return null;
  const pct = PLATFORM_FEE_BPS / 100;
  const floor = PLATFORM_FEE_THRESHOLD_CENTS / 100;
  return `a ${pct}% HoundStack fee on payments over $${floor}`;
}

/**
 * The platform fee on a charge, in whole cents, or undefined when there is none.
 *
 * UNDEFINED RATHER THAN 0 is the load-bearing part of the signature. Every one
 * of the ten call sites spends this straight into `application_fee_amount`, so
 * returning undefined omits the key and returning a number sets it. That is why
 * the rate can be turned off in one constant without editing a single payment
 * path -- and why nothing here needs to grow a conditional spread that a future
 * charge site could forget to copy.
 *
 * Rounded to the nearest cent — `application_fee_amount` must be an integer, and
 * truncating would give away a fraction of a cent on most transactions for no
 * reason. Returns undefined for anything at or below the threshold, and for
 * input that is not a usable amount, because a NaN reaching Stripe as an
 * application fee fails the whole charge and the customer's payment is what
 * matters most.
 */
export function platformFeeCents(
  amountCents: number,
  /** The invoice this amount pays down, when there is one. Its sales tax is
   *  owed to the state, not earned by the tenant, so the fee is taken on the
   *  pre-tax share of the amount only (pro rata, `preTaxShareCents`). Omitted,
   *  or an invoice with no tax, the base is `amountCents` exactly — which is
   *  every invoice of every business that never set a tax rate. */
  invoice?: { tax_cents?: number | null; total_cents?: number | null } | null,
): number | undefined {
  if (!Number.isFinite(amountCents)) return undefined;
  const amount = preTaxShareCents(Math.floor(amountCents), invoice);
  if (amount <= PLATFORM_FEE_THRESHOLD_CENTS) return undefined;
  const fee = Math.round((amount * PLATFORM_FEE_BPS) / 10_000);
  return fee > 0 ? fee : undefined;
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
