// Who pays Stripe Radar's screening fee on a business's charge (#825).
//
// Owner decision (Brendan, 2026-11-10, 1:45 AM ET), word for word: "Pass Radar
// fees to each business, like the tap fee". The platform (The North
// Consulting) never absorbs another business's Radar fee.
//
// ── WHY THIS IS NOT THE TAP FEE'S RULE ───────────────────────────────────
//
// The tap fee (#757, src/lib/tap-to-pay.ts) is added to the application fee
// only when the account's `controller.fees.payer` is `application` or cannot
// be read, because for a DIRECT charge Stripe bills payment processing fees to
// the connected account under `application_express`.
//
// Radar is different. Stripe's own table
// (docs.stripe.com/connect/direct-charges-fee-payer-behavior, "List of fee
// behaviors for payer values") has a Radar row that reads:
//
//     account: Connected Account | application: Platform |
//     application_custom: Varies | application_express: Varies
//
// and the live check on #825 settled the "Varies" for HoundStack's accounts:
// Radar debits of -$0.30 (Nov 2), -$0.15 (Nov 3) and -$0.10 (Nov 6) landed on
// the PLATFORM balance, while both live connected accounts are Express
// (`application_express`) and every one of their charges is a direct charge.
// So Radar is passed through for every fee payer except `account`, which is
// the one setting where Stripe bills the business itself. An account whose
// fee payer cannot be read is treated as the platform paying, as for the tap:
// a wrong guess that way costs the business five cents, the other way is the
// leak the owner ruled out.
//
// ── WHAT IS SCREENED ─────────────────────────────────────────────────────
//
// Radar screens online card payments. A bank debit (`us_bank_account`) is not
// a card, and an in-person tap (`card_present`) is not screened by Radar, so
// neither carries the fee. Link pays with a card and is screened. An intent
// whose methods are not pinned (automatic payment methods) may be paid by
// card, so it is treated as screened.
//
// An intent that offers BOTH card and bank (Take payment, the portal, the
// public pay link) has its application fee set before the payer picks, so it
// carries the Radar fee either way. When such a payment is made by bank the
// business pays five cents Stripe did not bill. That is the deliberate
// direction of the error, the same one the tap fee takes for an unreadable
// account, and it is written down in docs/stripe-connect-fees.md.
//
// This module ships to the app (the Payments page names the fee), so it holds
// no HoundStack pricing term and does not import @/lib/platform-fee.

/**
 * Stripe Radar's fee per screened card payment, in cents.
 *
 * Five cents is Stripe's published per-screening price for Radar outside
 * standard blended pricing, and every live Radar debit on #825 (30, 15 and 10
 * cents) is a whole multiple of it. That the live platform is billed exactly
 * five cents per screening, and not some other per-account rate, is still to
 * be confirmed against Stripe (a test-mode check, approved separately). A
 * change to Stripe's price is a change to this one constant.
 */
export const RADAR_SCREENING_FEE_CENTS = 5;

/** "$0.05", for the sentence on the Payments page. */
export function radarFeeLabel(): string {
  return "$" + (RADAR_SCREENING_FEE_CENTS / 100).toFixed(2);
}

/** Payment method types Radar screens. */
const SCREENED_METHOD_TYPES = new Set(["card", "link"]);

/** True when a charge offering these methods can be screened by Radar.
 *  Unpinned methods (null, undefined, empty) may be a card, so they count. */
export function radarScreens(paymentMethodTypes: readonly string[] | null | undefined): boolean {
  if (!paymentMethodTypes || paymentMethodTypes.length === 0) return true;
  return paymentMethodTypes.some((t) => SCREENED_METHOD_TYPES.has(t));
}

/** True when Stripe bills Radar to the platform for this account's direct
 *  charges, or that cannot be ruled out. Only `account` bills the business. */
export function platformBilledForRadar(feePayer: string | null): boolean {
  return feePayer !== "account";
}

/** The Radar fee a charge's application fee should carry: five cents for a
 *  screened payment where the platform would be billed, else zero. */
export function radarFeeCents(
  feePayer: string | null,
  paymentMethodTypes: readonly string[] | null | undefined,
): number {
  if (!platformBilledForRadar(feePayer)) return 0;
  return radarScreens(paymentMethodTypes) ? RADAR_SCREENING_FEE_CENTS : 0;
}

/** The method list a saved payment method's rail stands for, for radarFeeCents. */
export function methodTypesForRail(rail: "card" | "ach"): string[] {
  return rail === "ach" ? ["us_bank_account"] : ["card"];
}

/** The Radar fee a charge's application fee carried, from the
 *  `radar_fee_cents` its PaymentIntent was created with. 0 for anything
 *  created before #825 and for anything malformed. */
export function radarFeeFromMetadata(metadata: Record<string, string> | null | undefined): number {
  const raw = metadata?.radar_fee_cents;
  if (typeof raw !== "string" || !/^\d{1,6}$/.test(raw)) return 0;
  return Number(raw);
}

/**
 * The application fee with Stripe costs the platform recovers added on top.
 *
 * `platformFee` is `platformFeeCents(...)`, which is undefined while the
 * platform fee is zero so the key is omitted. That is exactly the case that
 * hit the platform on #825: with no application fee there is nothing to
 * recover Radar from. So a pass-through turns "no fee" into a fee of the
 * pass-through alone, and adds to a real fee rather than replacing it. With
 * nothing to pass through, the platform fee comes back unchanged, undefined
 * included.
 */
export function withPassThroughFees(
  platformFee: number | undefined,
  passThroughCents: number,
): number | undefined {
  if (!Number.isFinite(passThroughCents) || passThroughCents <= 0) return platformFee;
  return (platformFee ?? 0) + Math.round(passThroughCents);
}

/** Metadata every connected-account intent carries for the Radar fee. Always
 *  written, "0" included, because Stripe merges metadata on update. */
export function radarFeeMetadata(
  radarCents: number,
  feePayer: string | null,
): { radar_fee_cents: string; connect_fee_payer: string } {
  return {
    radar_fee_cents: String(Math.max(0, Math.round(radarCents))),
    connect_fee_payer: feePayer ?? "unknown",
  };
}

/**
 * What the business is told, on the Payments page, before it connects and
 * again beside the processing-fee setting. Same plain style as the tap-fee
 * line on the Tap to pay card. Worded for what the code does: a payment that
 * offers card and bank carries the fee before the client picks, so a bank
 * payment there pays it too; a saved bank account and a tap carry none.
 */
export function radarFeeSentence(): string {
  return (
    `Each online payment a client can make by card also costs your business ` +
    `${radarFeeLabel()} for Stripe's fraud check (Radar), even when the client ends up ` +
    `paying by bank. It is taken out of the payout and shown in Stripe as an application fee.`
  );
}
