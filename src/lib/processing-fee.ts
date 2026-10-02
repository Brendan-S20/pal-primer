// What a payment COSTS, and how much of that cost may lawfully be handed to the
// person paying. One definition, one file — the same reasoning as
// `platform-fee.ts`, which this deliberately does not touch.
//
// ── THE TWO FEES ARE NOT THE SAME FEE ─────────────────────────────────────
//
// `platformFeeCents()` is OUR revenue: 50 bps, taken as `application_fee_amount`
// on every tenant→client charge, on every rail.
//
// This module is the TENANT'S cost: what Stripe charges the connected account
// for accepting the payment. On a direct charge the connected account is the
// merchant of record and pays Stripe directly — we never see that money, and we
// cannot bill for it a second time. So there is no world in which HoundStack
// charges "2.9% + 30¢": Stripe already does, to the tenant, and adding our own
// 2.9% on top would double it.
//
// What a tenant can do is pass their card cost on to the homeowner. That is a
// SURCHARGE, and it is regulated. Everything below is the regulation.
//
// ── WHY OUR 50 BPS CANNOT RIDE ALONG ──────────────────────────────────────
//
// Visa and Mastercard cap a surcharge at the merchant's actual COST OF CARD
// ACCEPTANCE. `platformFeeCents()` does not look at the rail — we charge it on
// an ACH payment too — which makes it a software fee, not a cost of accepting
// cards. Including it in a surcharge would put the surcharge over the permitted
// amount. So `surchargeCents()` returns Stripe's cost and nothing else, and the
// platform fee stays invisible to the homeowner. If the platform fee is ever
// made card-only, revisit this paragraph before revisiting the code.
//
// ── THE CAP BINDS ON ALMOST EVERY TICKET WE PROCESS ───────────────────────
//
// Visa lowered the surcharge ceiling to 3% in April 2023 (Mastercard still
// allows 4%; we use the lower, because at quote time we do not know which
// network will settle it). Stripe's card cost is 2.9% + 30¢, and the fixed 30¢
// is what pushes it over the cap on any ticket under $300:
//
//     ticket   Stripe on base   cap    surcharged   Stripe on total   absorbed
//     $25      $1.03  (4.1%)    $0.75  $0.75        $1.05             $0.30
//     $60      $2.04  (3.4%)    $1.80  $1.80        $2.09             $0.29
//     $100     $3.20  (3.2%)    $3.00  $3.00        $3.29             $0.29
//     $300     $9.00  (3.0%)    $9.00  $9.00        $9.26             $0.26
//     $1,000   $29.30 (2.9%)    $30.00 $29.30       $30.15            $0.85
//
// THE TENANT ALWAYS ABSORBS SOMETHING. Under $300 it is the cap doing it; over
// $300 it is the last column of the next paragraph. Around 25–30¢ on a typical
// ticket either way. That is the arithmetic of the rule, not a bug to fix, and
// `shortfallCents` is on every quote so a tenant is told rather than left to
// discover it reconciling a statement.
//
// ── NOT GROSSED UP, DELIBERATELY ──────────────────────────────────────────
//
// The surcharge is computed on the BASE, then added to it — so Stripe's fee
// actually lands on (base + surcharge) and is a little larger than what we
// collected. That gap is the "absorbed" column above.
//
// Recovering it too ("gross-up": S = (Ar + f) / (1 − r)) is legitimate — a
// grossed-up surcharge is still exactly the cost of acceptance, which is the
// legal standard — but it is a bigger number, and a bigger number is the one
// that can breach the cap. It also only helps above $2,308, because below that
// the grossed-up figure exceeds 3% and gets capped back down to where we
// already are. Paying ~30¢ a transaction to keep the compliance argument a
// one-liner (cost(base) < cost(total), and 3% of base < 3% of total, so both
// ceilings hold by construction) is the right side to err on.
//
// ── ACH IS NOT A CARD ─────────────────────────────────────────────────────
//
// None of the above applies to a bank debit: no network cap, no Durbin debit
// prohibition, no state ban, no network registration. Stripe charges 0.8%
// capped at $5, and passing exactly that on is clean. It is also where the
// money is — on a $10,000 ACH payment the cap means the tenant's cost is $5,
// not $80.
//
// ── WHAT THIS MODULE DOES NOT DECIDE ──────────────────────────────────────
//
// Whether a tenant may surcharge at all. Visa and Mastercard require THE
// MERCHANT to notify the networks and its acquirer 30 days before surcharging,
// and on a direct charge the merchant is the tenant, not HoundStack — we cannot
// file that once on their behalf. `organizations.card_surcharge_attested_at` records
// that a tenant said they had; this module only answers "given they may, how
// much."
//
// ── SALES TAX IS NOT SURCHARGED ───────────────────────────────────────────
//
// When the invoice carries sales tax, `taxCents` names the part of the base
// that is tax, and the surcharge is computed on `base − taxCents` only — the
// same way it is already computed without the tip. Tax is the state's money
// passing through, not the price of the service, and card-network surcharge
// rules are written against the transaction amount before tax; computing on
// the smaller figure is the direction that can only ever under-recover, never
// breach a cap. The CHARGE is still base + surcharge, so `invoiceAppliedCents`
// (charge − surcharge − tip) is still exactly the invoice's due amount, tax
// included. With no tax on the invoice every number here is what it was.

/** Which rail a payment actually settled on. */
export type PaymentRail = "card" | "ach";

/**
 * A card's funding type, straight off `PaymentMethod.card.funding`.
 *
 * `unknown` is a real answer from Stripe and is treated as un-surchargeable —
 * see `SuppressionReason`. Guessing here would mean surcharging a debit card,
 * which is prohibited outright.
 */
export type CardFunding = "credit" | "debit" | "prepaid" | "unknown";

/** Stripe's standard US rate for a card on a connected account: 2.9% + 30¢. */
export const STRIPE_CARD_BPS = 290;
export const STRIPE_CARD_FIXED_CENTS = 30;

/** Stripe's standard US rate for an ACH debit: 0.8%, capped at $5.00. */
export const STRIPE_ACH_BPS = 80;
export const STRIPE_ACH_CAP_CENTS = 500;

/**
 * Stripe's rates as a sentence fragment, derived from the constants above.
 *
 * WHY THIS IS A FUNCTION AND NOT A STRING IN THE JSX. Until now the same
 * figures were written out three times: these constants, prose on the Payments
 * page, and the marketing site. That is the shape this repo has already been
 * bitten by and named -- one revenue figure with three implementations
 * (BUG-21). Two of the three are in this repo, so two of the three can be made
 * to move together, and `tests/what-a-payment-costs-is-said-once.test.ts`
 * refuses a hardcoded rate anywhere in src/.
 *
 * The marketing site is a separate repository and cannot be pulled in here. It
 * quotes the same numbers, so a rate change is still a two-repo edit -- but it
 * is now one edit per repo rather than one per surface, and this side fails
 * loudly rather than drifting quietly.
 *
 * Deliberately says nothing about HoundStack's own cut: that is
 * `describePlatformFee()` in platform-fee.ts, and the reason the two fees are
 * not blended into one number is the whole subject of the header above.
 */
export function describeStripeCardRate(): string {
  return `${STRIPE_CARD_BPS / 100}% + ${STRIPE_CARD_FIXED_CENTS}\u00a2`;
}

export function describeStripeAchRate(): string {
  return `${STRIPE_ACH_BPS / 100}% (capped at $${STRIPE_ACH_CAP_CENTS / 100})`;
}

/** "2.9% + 30¢ on cards and 0.8% (capped at $5) on bank payments". */
export function describeStripeRates(): string {
  return `${describeStripeCardRate()} on cards and ${describeStripeAchRate()} on bank payments`;
}

/**
 * The network ceiling on a card surcharge, in basis points.
 *
 * 300 = 3%, Visa's limit since April 2023. Mastercard permits 4%, but the
 * network is not known until the charge settles, so the lower of the two is the
 * only safe number to quote.
 */
export const SURCHARGE_CAP_BPS = 300;

/**
 * Where surcharging a card is prohibited outright, by the MERCHANT's location.
 *
 * Connecticut and Massachusetts ban it by statute; Puerto Rico likewise. The
 * other state bans people remember are gone — the New York statute survived
 * *Expressions Hair Design* only as a disclosure rule, and Maine, Oklahoma,
 * Kansas and others were repealed or struck down. This list is short because it
 * is the list that is actually still enforceable, not the list from a blog post.
 *
 * The merchant's region comes from the connected account's registered address,
 * which is the only place we hold it — `orgs` has no address column.
 */
export const SURCHARGE_BANNED_REGIONS: readonly string[] = ["CT", "MA", "PR"];

/** Why a quote carries no surcharge. `null` on a quote that does. */
export type SuppressionReason =
  /** The tenant has not switched pass-through on. The default, and today's behaviour. */
  | "absorbed"
  /** Durbin: a debit card may not be surcharged, at any amount, in any state. */
  | "debit"
  /** Prepaid cards are debit for this purpose. */
  | "prepaid"
  /** The merchant is in CT, MA or PR. */
  | "region"
  /** Stripe did not tell us the funding type. Fail closed — see `CardFunding`. */
  | "unknown_funding"
  /** We could not determine the merchant's state. Fail closed. */
  | "unknown_region"
  /** The tenant has not attested that they notified the networks. */
  | "not_attested";

export type FeeQuote = {
  /** What the invoice is actually for. Never changes. */
  baseCents: number;
  rail: PaymentRail;
  /** Added to the charge and paid by the homeowner. 0 when suppressed. */
  surchargeCents: number;
  /** What Stripe will actually take from the tenant, on `totalCents`. */
  stripeCostCents: number;
  /** base + surcharge — the amount to charge. */
  totalCents: number;
  /**
   * Stripe's cost minus what the surcharge recovered: what the tenant still
   * pays out of their own margin. Never negative, and on a card almost never
   * zero — see the table in the header.
   */
  shortfallCents: number;
  suppressed: SuppressionReason | null;
};

/**
 * What Stripe charges the connected account to accept `amountCents` on `rail`.
 *
 * This is a cost, not a fee we collect — nothing here reaches
 * `application_fee_amount`.
 */
export function stripeCostCents(amountCents: number, rail: PaymentRail): number {
  if (!Number.isFinite(amountCents) || amountCents <= 0) return 0;
  const amount = Math.floor(amountCents);
  if (rail === "ach") {
    return Math.min(STRIPE_ACH_CAP_CENTS, Math.round((amount * STRIPE_ACH_BPS) / 10_000));
  }
  return Math.round((amount * STRIPE_CARD_BPS) / 10_000) + STRIPE_CARD_FIXED_CENTS;
}

export type QuoteInput = {
  baseCents: number;
  rail: PaymentRail;
  /** Required for a card. Ignored for ACH. */
  funding?: CardFunding;
  /** Two-letter state/territory of the MERCHANT, e.g. "TX". */
  merchantRegion?: string | null;
  /** `organizations.payment_fee_pass_through` — the tenant's own choice. */
  passThroughEnabled: boolean;
  /** `organizations.card_surcharge_attested_at` — non-null once they confirmed they notified. */
  attested: boolean;
  /** The sales tax inside `baseCents`, which is not surcharged. Omitted is 0. */
  taxCents?: number;
};

/**
 * The whole decision: may this payment carry a surcharge, and how much.
 *
 * Every suppression path returns a zero surcharge with a REASON rather than
 * just zero, because "no fee shown" and "no fee allowed" look identical on a
 * screen and only one of them is a bug.
 */
export function quoteProcessingFee(input: QuoteInput): FeeQuote {
  const base = Number.isFinite(input.baseCents) ? Math.max(Math.floor(input.baseCents), 0) : 0;
  const rail = input.rail;
  // What the surcharge is computed ON: the base less its sales tax. Equal to
  // `base` whenever there is no tax. See "SALES TAX IS NOT SURCHARGED".
  const tax = Number.isFinite(input.taxCents) ? Math.max(Math.floor(input.taxCents ?? 0), 0) : 0;
  const surchargeable = Math.max(base - tax, 0);

  const suppressed = (reason: SuppressionReason): FeeQuote => ({
    baseCents: base,
    rail,
    surchargeCents: 0,
    stripeCostCents: stripeCostCents(base, rail),
    totalCents: base,
    shortfallCents: stripeCostCents(base, rail),
    suppressed: reason,
  });

  if (base <= 0) return suppressed("absorbed");
  if (!input.passThroughEnabled) return suppressed("absorbed");

  // ACH first: a bank debit is not a card, so none of the card rules reach it —
  // no attestation, no funding check, no state ban, no cap.
  if (rail === "ach") {
    const surcharge = stripeCostCents(surchargeable, "ach");
    const total = base + surcharge;
    const cost = stripeCostCents(total, "ach");
    return {
      baseCents: base,
      rail,
      surchargeCents: surcharge,
      stripeCostCents: cost,
      totalCents: total,
      shortfallCents: Math.max(cost - surcharge, 0),
      suppressed: null,
    };
  }

  // Everything from here is a card surcharge.
  if (!input.attested) return suppressed("not_attested");

  const region = (input.merchantRegion ?? "").trim().toUpperCase();
  if (!region) return suppressed("unknown_region");
  if (SURCHARGE_BANNED_REGIONS.includes(region)) return suppressed("region");

  const funding = input.funding ?? "unknown";
  if (funding === "debit") return suppressed("debit");
  if (funding === "prepaid") return suppressed("prepaid");
  if (funding !== "credit") return suppressed("unknown_funding");

  // Both ceilings, on the base — see "NOT GROSSED UP" in the header.
  const cost = stripeCostCents(surchargeable, "card");
  const cap = Math.floor((surchargeable * SURCHARGE_CAP_BPS) / 10_000);
  const surcharge = Math.max(Math.min(cost, cap), 0);
  const total = base + surcharge;
  const actualCost = stripeCostCents(total, "card");
  return {
    baseCents: base,
    rail,
    surchargeCents: surcharge,
    stripeCostCents: actualCost,
    totalCents: total,
    shortfallCents: Math.max(actualCost - surcharge, 0),
    suppressed: null,
  };
}

/**
 * The rail and funding type of a Stripe PaymentMethod.
 *
 * Kept here rather than at the call sites because seven places create a charge
 * and every one of them needs the same answer, and because `us_bank_account` is
 * the only bank rail we enable — a future rail added to `INVOICE_PM_TYPES`
 * without a line here would silently be priced as a card.
 */
export function railOfPaymentMethod(
  pm: { type?: string | null; card?: { funding?: string | null } | null } | null | undefined,
): { rail: PaymentRail; funding: CardFunding } {
  if (pm?.type === "us_bank_account") return { rail: "ach", funding: "unknown" };
  const f = pm?.card?.funding;
  const funding: CardFunding = f === "credit" || f === "debit" || f === "prepaid" ? f : "unknown";
  return { rail: "card", funding };
}

/** Human-readable, for the payer-facing line and the tenant-facing explanation. */
export function suppressionExplanation(reason: SuppressionReason): string {
  switch (reason) {
    case "absorbed":
      return "Your business is absorbing card and bank fees on this payment.";
    case "debit":
      return "Debit cards cannot be surcharged, so no processing fee was added.";
    case "prepaid":
      return "Prepaid cards cannot be surcharged, so no processing fee was added.";
    case "region":
      return "Card surcharges are not permitted in your business's state, so none was added.";
    case "unknown_funding":
      return "We could not confirm the card type, so no processing fee was added.";
    case "unknown_region":
      return "We could not confirm your business's state, so no processing fee was added.";
    case "not_attested":
      return "Card surcharging is not yet active for your business.";
  }
}
