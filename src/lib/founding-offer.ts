// The founding offer, LAUNCH20 (owner, 2026-10-09; spec NP-2).
//
// 30% off the PLAN price, for as long as the account stays subscribed, for the
// first 20 paying accounts. Extra people and add-ons are full price. It applies
// on monthly and yearly billing and is lost on cancellation.
//
// ── THE COUNT: ACCOUNTS THAT PAID (owner, 2026-10-10) ──────────────────────
//
// A founding place is used only by an account that actually PAID. Stripe's
// own count (the promotion code's times_redeemed) cannot be it: Stripe counts
// a redemption when the subscription is CREATED, and the app creates it unpaid
// (default_incomplete) before the Payment Element takes the card, so every
// abandoned checkout would burn a place.
//
// So the count is `public.founding_accounts`: one row per account whose
// founding subscription was seen paid (active or past_due), written by
// claim_founding_place from the platform Stripe webhook and from
// refreshBillingStatus (founding-offer.server.ts: recordFoundingPayment).
// The banner's "{X} of 20 left" (shown from 10 left, FOUNDING_COUNT_SHOWN_AT)
// and checkout's refusal both read that count,
// on the server; the browser is handed `{ left }` or "hidden".
//
// FOUNDING_SPOTS below is the ONE place the 20 is written. The database takes
// it as an argument rather than keeping a copy.
//
// Stripe's max_redemptions stays on LAUNCH20 as a backstop, set higher than
// the offer (30, scripts/stripe-test-setup.mjs) so a few abandoned checkouts
// cannot close the offer before 20 have paid. The banner also hides if Stripe
// itself would refuse the code (inactive, expired, or at that backstop).
//
// Cached briefly in this process, because every plan-picker render asks and a
// count that is a minute old is fine; a newly taken place drops the cache.
//
// ── PLAN PRICE ONLY ───────────────────────────────────────────────────────
//
// The coupon is restricted in Stripe to the plan products (so no add-on can
// take it), but the plan's base and seat prices share a product, so Stripe
// cannot tell "plan price" from "extra person" by product. The app therefore
// attaches the code to the BASE PLAN ITEM of the subscription only
// (`items[].discounts`), never to the subscription as a whole.
import type Stripe from "stripe";

export const FOUNDING_CODE = "LAUNCH20";
export const FOUNDING_SPOTS = 20;
export const FOUNDING_PERCENT_OFF = 30;

export type FoundingOffer = { visible: true; left: number } | { visible: false };

export function isFoundingCode(code: string | null | undefined): boolean {
  return !!code && code.trim().toUpperCase() === FOUNDING_CODE;
}

/** Places left: 20 minus accounts that PAID with the code, never below zero.
 *  Also never more than Stripe itself will still accept, when its backstop
 *  (max_redemptions, which counts unpaid checkouts too) is closer. */
export function placesLeft(
  paidFounding: number,
  promo?: Pick<Stripe.PromotionCode, "times_redeemed" | "max_redemptions"> | null,
): number {
  const byOffer = FOUNDING_SPOTS - Math.max(0, paidFounding);
  const byStripe =
    promo?.max_redemptions != null ? promo.max_redemptions - (promo.times_redeemed ?? 0) : byOffer;
  return Math.max(0, Math.min(byOffer, byStripe));
}

/** Does this Stripe subscription carry the founding code? The app writes
 *  `metadata.promo_code` when it puts LAUNCH20 on the plan line, and clears it
 *  when Stripe refuses the code or the discount is taken off. */
export function carriesFoundingCode(sub: { metadata?: Record<string, string> | null } | null | undefined): boolean {
  return isFoundingCode(sub?.metadata?.promo_code);
}

/** A subscription status that means the first invoice was paid. A
 *  default_incomplete subscription is `incomplete` until it is, and becomes
 *  `past_due` only after a later renewal fails. */
export function subscriptionHasPaid(status: string | null | undefined): boolean {
  return status === "active" || status === "past_due";
}

/** The count is shown only once this many places or fewer are left. "20 of
 *  20 left" told every owner who opened Plan & billing that nobody had bought
 *  yet (QA finding 30). Until half are taken the banner states the offer and
 *  no number; the cap itself (placesLeft, checkout's refusal) is unchanged. */
export const FOUNDING_COUNT_SHOWN_AT = FOUNDING_SPOTS / 2;

/** The banner's words (NP-2), with the live count in place of {X} once few
 *  enough places are left to be worth saying. */
export function foundingBannerText(
  left: number,
  translate?: (key: string, values: Record<string, string | number>) => string,
): string {
  const offer = translate
    ? translate("launch.founding", {
        spots: FOUNDING_SPOTS,
        percent: FOUNDING_PERCENT_OFF,
        code: FOUNDING_CODE,
      })
    : `Founding pricing: the first ${FOUNDING_SPOTS} paying accounts get ${FOUNDING_PERCENT_OFF}% off ` +
      `their plan price for as long as they stay subscribed. Extra people and add-ons are billed at ` +
      `regular price. Use code ${FOUNDING_CODE} at checkout.`;
  if (left > FOUNDING_COUNT_SHOWN_AT) return offer;
  const remaining = translate
    ? translate("launch.remaining", { left, spots: FOUNDING_SPOTS })
    : `${left} of ${FOUNDING_SPOTS} left.`;
  return `${offer} ${remaining}`;
}
