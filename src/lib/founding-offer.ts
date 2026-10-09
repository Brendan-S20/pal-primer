// The founding offer, LAUNCH20 (owner, 2026-10-09; spec NP-2).
//
// 30% off the PLAN price, for as long as the account stays subscribed, for the
// first 20 paying accounts. Extra people and add-ons are full price. It applies
// on monthly and yearly billing and is lost on cancellation.
//
// ── ONE SOURCE OF TRUTH: STRIPE ───────────────────────────────────────────
//
// The count of places left is read from the LAUNCH20 promotion code itself:
// 20 minus its redemption count. Stripe enforces `max_redemptions` on the same
// object, so the banner and the code cannot disagree about when the offer is
// over. Nothing is counted in our database and nothing is computed in the
// browser; the server hands the client `{ left }` or "hidden".
//
// Cached briefly in this process, because every plan-picker render asks and a
// count that is a minute old is fine; a successful founding checkout drops the
// cache so the next render reads the new number.
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

/** 20 minus redemptions, never below zero, and never above what Stripe itself
 *  will still accept if its own cap was set lower. */
export function placesLeft(promo: Pick<Stripe.PromotionCode, "times_redeemed" | "max_redemptions">): number {
  const byOffer = FOUNDING_SPOTS - (promo.times_redeemed ?? 0);
  const byStripe =
    promo.max_redemptions != null ? promo.max_redemptions - (promo.times_redeemed ?? 0) : byOffer;
  return Math.max(0, Math.min(byOffer, byStripe));
}

/** The banner's words (NP-2), with the live count in place of {X}. */
export function foundingBannerText(left: number): string {
  return (
    `Founding customers: the first ${FOUNDING_SPOTS} paying accounts get ${FOUNDING_PERCENT_OFF}% off ` +
    `their plan price for as long as they stay subscribed. Extra people and add-ons are billed at ` +
    `regular price. Use code ${FOUNDING_CODE} at checkout. ${left} of ${FOUNDING_SPOTS} left.`
  );
}
