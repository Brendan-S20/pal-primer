// Server half of the pass-through processing fee: turn an organization and a
// Stripe PaymentMethod into a `FeeQuote`.
//
// The arithmetic and the law live in `processing-fee.ts`, which is pure and
// tested in isolation. This file only fetches the two inputs that arithmetic
// needs — the tenant's choice, and what the payer actually paid with — and it
// exists so the charge sites cannot each fetch them differently.
//
// ── WHERE PASS-THROUGH ACTUALLY APPLIES ───────────────────────────────────
//
// THREE paths, all of them OFF-SESSION: the nightly autopay run, staff "charge
// saved card", and the portal's saved card. Each already holds
// `default_payment_method_id` when it builds the charge, so the rail and the
// funding type are known and `quoteForPaymentMethodId` can answer.
//
// FOUR paths do NOT surcharge, and cannot as they stand: portal inline, staff
// inline, the public pay link and signup prepay. `INVOICE_PM_TYPES` is
// `["card", "us_bank_account"]`, and on those the homeowner chooses inside
// Stripe's Payment Element — AFTER the PaymentIntent exists with its amount
// already fixed. Card and ACH cost wildly different amounts (2.9% + 30¢ against
// 0.8% capped at $5) and a debit card may not be surcharged at all, so the
// quote is undecidable at creation and there is nowhere later to apply it.
//
// ── A CORRECTION, BECAUSE THIS HEADER USED TO CLAIM OTHERWISE ─────────────
//
// It described the customer-present paths as a two-step create → attach →
// quote → update → confirm. No such step exists, and never did. Every
// `paymentIntents.update` in the repo sets `amount: dueCents` with no quote and
// no `surchargeMetadata`, and `quoteForPaymentMethod` / `absorbedQuote` had
// ZERO callers. Meanwhile the settings screen advertised "applies to bank (ACH)
// payments straight away" with a live "you recover $X" figure — and every
// ACH-capable path absorbed the fee. A tenant who ticked the box recovered
// nothing on exactly the rail the screen named.
//
// The UI now states which payments it reaches, and
// `tests/a-surcharged-charge-carries-its-split.test.ts` asserts the split
// across ALL of them rather than only the three that pass, so this cannot widen
// unnoticed. Building the real two-step — a client-side hook on payment-method
// selection, a requote endpoint, then confirm — is the remaining work, and it
// touches four live payment surfaces, which is why it is not being bolted on
// here.

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import {
  quoteProcessingFee,
  railOfPaymentMethod,
  type FeeQuote,
  type PaymentRail,
} from "@/lib/processing-fee";
import { tipFromMetadata } from "@/lib/tips";

/** What this module needs off a payment method — Stripe's own type, narrowed. */
type PaymentMethodLike = Pick<Stripe.PaymentMethod, "type"> & {
  card?: { funding?: string | null } | null;
};

export type OrgFeeConfig = {
  passThroughEnabled: boolean;
  attested: boolean;
  merchantRegion: string | null;
};

/**
 * The tenant's pass-through settings.
 *
 * Fails CLOSED on any error: an org we cannot read is an org that does not
 * surcharge. The cost of getting that wrong in the safe direction is a fee we
 * did not pass on; in the unsafe direction it is an unlawful surcharge on a
 * homeowner's card.
 */
export async function orgFeeConfig(
  supabaseAdmin: SupabaseClient,
  organizationId: string,
): Promise<OrgFeeConfig> {
  const off: OrgFeeConfig = {
    passThroughEnabled: false,
    attested: false,
    merchantRegion: null,
  };
  try {
    const { data } = await supabaseAdmin
      .from("organizations")
      .select("payment_fee_pass_through, card_surcharge_attested_at, stripe_merchant_region")
      .eq("id", organizationId)
      .maybeSingle();
    const row = data as {
      payment_fee_pass_through?: boolean | null;
      card_surcharge_attested_at?: string | null;
      stripe_merchant_region?: string | null;
    } | null;
    if (!row) return off;
    return {
      passThroughEnabled: !!row.payment_fee_pass_through,
      attested: !!row.card_surcharge_attested_at,
      merchantRegion: row.stripe_merchant_region ?? null,
    };
  } catch (e) {
    console.error("orgFeeConfig failed; absorbing fees for this charge", organizationId, e);
    return off;
  }
}

/** A quote with no surcharge, for the paths that bail out. */
export function absorbedQuote(baseCents: number, rail: PaymentRail = "card"): FeeQuote {
  return quoteProcessingFee({
    baseCents,
    rail,
    passThroughEnabled: false,
    attested: false,
    merchantRegion: null,
  });
}

/**
 * Retrieve a PaymentMethod on the connected account and quote against it.
 *
 * A retrieval failure absorbs rather than throws. The payment is what matters:
 * losing a 24¢ fee recovery is not a reason to fail a homeowner's payment, and
 * this is called on the autopay path where nobody is watching to retry.
 */
export async function quoteForPaymentMethodId(
  stripe: Stripe,
  args: {
    paymentMethodId: string;
    stripeAccount: string;
    baseCents: number;
    config: OrgFeeConfig;
  },
): Promise<FeeQuote> {
  let pm: PaymentMethodLike | null = null;
  try {
    pm = await stripe.paymentMethods.retrieve(args.paymentMethodId, undefined, {
      stripeAccount: args.stripeAccount,
    });
  } catch (e) {
    console.error("payment method retrieve failed; absorbing fee", args.paymentMethodId, e);
    return absorbedQuote(args.baseCents);
  }
  return quoteForPaymentMethod(pm, args.baseCents, args.config);
}

/** The same decision when the PaymentMethod object is already in hand. */
export function quoteForPaymentMethod(
  pm: PaymentMethodLike | null,
  baseCents: number,
  config: OrgFeeConfig,
): FeeQuote {
  const { rail, funding } = railOfPaymentMethod(pm);
  return quoteProcessingFee({
    baseCents,
    rail,
    funding,
    merchantRegion: config.merchantRegion,
    passThroughEnabled: config.passThroughEnabled,
    attested: config.attested,
  });
}

/**
 * PaymentIntent metadata carrying the surcharge through to the webhook.
 *
 * The webhook cannot recompute this: it sees `pi.amount` (base + surcharge) and
 * has no way to split it back apart — the funding type that decided the
 * surcharge is not on the event, and re-quoting could return a different number
 * if the tenant changed their setting between charge and callback. So the split
 * travels with the charge, as a fact about what happened rather than a
 * calculation to repeat.
 *
 * Stripe metadata values are strings; `surchargeFromMetadata` is the only thing
 * that should parse them back.
 */
export function surchargeMetadata(quote: FeeQuote): Record<string, string> {
  return {
    surcharge_cents: String(quote.surchargeCents),
    fee_rail: quote.rail,
  };
}

/**
 * Read the surcharge back off a PaymentIntent.
 *
 * Returns 0 for anything missing or malformed, which is exactly right for every
 * charge made before this feature existed: no metadata means no surcharge means
 * `pi.amount` is entirely invoice money, which is what those rows already mean.
 */
export function surchargeFromMetadata(metadata: Record<string, string> | null | undefined): number {
  const raw = metadata?.surcharge_cents;
  if (typeof raw !== "string") return 0;
  // Digits only, deliberately: `parseInt` stops at the first character it does
  // not understand and returns what it has, so "1e9999" parses to 1 and
  // "180abc" to 180. We write this value ourselves and it is always a plain
  // integer, so anything else is corruption or tampering and reads as zero —
  // which charges the invoice the full amount rather than inventing a split.
  if (!/^\d+$/.test(raw)) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n < 0) return 0;
  return n;
}

/**
 * The part of a charge that pays down the invoice.
 *
 * Every reconcile path wants this and not `pi.amount`. A charge is
 * invoice + surcharge + tip, and only the first is a payment against what was
 * owed: the surcharge is fee recovery and the tip is a gratuity, and both are
 * recorded BESIDE `amount_cents` (see src/lib/tips.ts). Clamped at zero and
 * never above the charge, because a metadata value larger than the charge would
 * otherwise credit a negative payment.
 */
export function invoiceAppliedCents(
  chargeAmountCents: number,
  metadata: Record<string, string> | null | undefined,
): number {
  const amount = Number.isFinite(chargeAmountCents) ? Math.floor(chargeAmountCents) : 0;
  if (amount <= 0) return 0;
  const surcharge = Math.min(surchargeFromMetadata(metadata), amount);
  const tip = Math.min(tipFromMetadata(metadata), amount - surcharge);
  return amount - surcharge - tip;
}

/**
 * The tip inside a charge, as it should be recorded on the payment row:
 * `tip_cents` from the metadata, clamped so that surcharge + tip never exceeds
 * the charge. Paired with `invoiceAppliedCents` so the three parts always add
 * back to `pi.amount`.
 */
export function tipAppliedCents(
  chargeAmountCents: number,
  metadata: Record<string, string> | null | undefined,
): number {
  const amount = Number.isFinite(chargeAmountCents) ? Math.floor(chargeAmountCents) : 0;
  if (amount <= 0) return 0;
  const surcharge = Math.min(surchargeFromMetadata(metadata), amount);
  return Math.min(tipFromMetadata(metadata), amount - surcharge);
}

/**
 * The merchant's state, off a Stripe Account.
 *
 * `company.address.state` for a business, `individual.address.state` for a sole
 * trader — a one-person dog-waste business is very often the latter, so both are
 * checked. Returns null rather than guessing, and null suppresses the surcharge.
 */
export function merchantRegionFrom(
  acct: Pick<Stripe.Account, "company" | "individual" | "business_profile">,
): string | null {
  const candidates = [
    acct.company?.address?.state,
    acct.individual?.address?.state,
    acct.business_profile?.support_address?.state,
  ];
  for (const c of candidates) {
    const v = (c ?? "").trim().toUpperCase();
    if (v) return v;
  }
  return null;
}
