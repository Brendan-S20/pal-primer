// Reads the LAUNCH20 promotion code from Stripe, server-side only. The rules
// and the banner's words are in ./founding-offer.ts.
import type Stripe from "stripe";
import { FOUNDING_CODE, placesLeft, type FoundingOffer } from "@/lib/founding-offer";

/** Seconds a read is trusted for. */
export const FOUNDING_CACHE_SECONDS = 60;

/** The live LAUNCH20 promotion code, or null when there is none to use. */
export async function findFoundingPromotionCode(stripe: Stripe): Promise<Stripe.PromotionCode | null> {
  const list = await stripe.promotionCodes.list({ code: FOUNDING_CODE, active: true, limit: 1 });
  const promo = list.data[0];
  if (!promo || !promo.active) return null;
  if (promo.expires_at && promo.expires_at * 1000 <= Date.now()) return null;
  return promo;
}

let cached: { at: number; offer: FoundingOffer } | null = null;

/** Drop the cached count, so the next read goes to Stripe. */
export function forgetFoundingOffer(): void {
  cached = null;
}

/**
 * `{ visible: true, left }` while places remain, otherwise `{ visible: false }`.
 * Hidden too when billing is not configured or Stripe cannot be asked: a
 * banner that guesses is worse than no banner.
 */
export async function readFoundingOffer(
  getStripe: () => Promise<Stripe | null>,
  now: number = Date.now(),
): Promise<FoundingOffer> {
  if (cached && now - cached.at < FOUNDING_CACHE_SECONDS * 1000) return cached.offer;
  let offer: FoundingOffer = { visible: false };
  try {
    const stripe = await getStripe();
    if (stripe) {
      const promo = await findFoundingPromotionCode(stripe);
      const left = promo ? placesLeft(promo) : 0;
      offer = left > 0 ? { visible: true, left } : { visible: false };
    }
  } catch (e) {
    console.error("founding offer lookup failed (banner hidden)", (e as Error).message);
  }
  cached = { at: now, offer };
  return offer;
}
