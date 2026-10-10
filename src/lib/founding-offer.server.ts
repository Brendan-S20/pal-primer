// The founding offer's server half: the count of places taken (accounts that
// PAID with LAUNCH20, in public.founding_accounts), the LAUNCH20 promotion code
// in Stripe, and taking a place when a founding subscription is paid. The
// rules and the banner's words are in ./founding-offer.ts.
import type Stripe from "stripe";
import {
  FOUNDING_CODE,
  FOUNDING_SPOTS,
  carriesFoundingCode,
  placesLeft,
  subscriptionHasPaid,
  type FoundingOffer,
} from "@/lib/founding-offer";

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

/** How many founding places are taken: accounts that PAID with the code. */
export async function countFoundingPaid(admin: any): Promise<number> {
  const { count, error } = await admin
    .from("founding_accounts")
    .select("organization_id", { count: "exact", head: true })
    .not("place", "is", null);
  if (error) throw new Error(`founding_accounts: ${error.message}`);
  return count ?? 0;
}

async function defaultCountPaid(): Promise<number> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return countFoundingPaid(supabaseAdmin);
}

let cached: { at: number; offer: FoundingOffer } | null = null;

/** Drop the cached count, so the next read asks again. */
export function forgetFoundingOffer(): void {
  cached = null;
}

/**
 * `{ visible: true, left }` while places remain, otherwise `{ visible: false }`.
 * `left` is 20 minus accounts that paid. Hidden too when billing is not
 * configured, when the code is not live in Stripe, or when either the count or
 * Stripe cannot be read: a banner that guesses is worse than no banner.
 */
export async function readFoundingOffer(
  getStripe: () => Promise<Stripe | null>,
  now: number = Date.now(),
  countPaid: () => Promise<number> = defaultCountPaid,
): Promise<FoundingOffer> {
  if (cached && now - cached.at < FOUNDING_CACHE_SECONDS * 1000) return cached.offer;
  let offer: FoundingOffer = { visible: false };
  try {
    const stripe = await getStripe();
    if (stripe) {
      const promo = await findFoundingPromotionCode(stripe);
      const left = promo ? placesLeft(await countPaid(), promo) : 0;
      offer = left > 0 ? { visible: true, left } : { visible: false };
    }
  } catch (e) {
    console.error("founding offer lookup failed (banner hidden)", (e as Error).message);
  }
  cached = { at: now, offer };
  return offer;
}

export type FoundingPayment =
  | { kind: "not_founding" }
  | { kind: "place"; place: number; newlyClaimed: boolean; placesTaken: number }
  | { kind: "over"; placesTaken: number; discountRemoved: boolean };

/**
 * A subscription has been seen. If it carries the founding code and has been
 * PAID, take a place for its account (once; a second sighting returns the
 * same place). Called by the platform Stripe webhook and by
 * refreshBillingStatus, whichever sees the payment first.
 *
 * Past the 20th place (two payments raced for the last one, or a checkout that
 * was started before the offer closed was paid after it), the account gets no
 * place: the founding discount is taken off its subscription in Stripe, so the
 * NEXT invoice is full price, and it is logged loudly. What cannot be undone
 * here is that payer's FIRST invoice, which Stripe already discounted.
 */
export async function recordFoundingPayment(opts: {
  admin: any;
  stripe: Stripe;
  orgId: string;
  sub: Pick<Stripe.Subscription, "id" | "status" | "metadata"> & {
    items?: { data?: Array<{ id: string; discounts?: Array<unknown> | null }> };
  };
}): Promise<FoundingPayment> {
  const { admin, stripe, orgId, sub } = opts;
  if (!carriesFoundingCode(sub) || !subscriptionHasPaid(sub.status)) return { kind: "not_founding" };

  const { data, error } = await admin.rpc("claim_founding_place", {
    _org: orgId,
    _subscription: sub.id,
    _spots: FOUNDING_SPOTS,
  });
  if (error) throw new Error(`claim_founding_place: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as
    | { place: number | null; newly_claimed: boolean; places_taken: number }
    | undefined;
  if (!row) throw new Error("claim_founding_place returned nothing");
  if (row.newly_claimed) forgetFoundingOffer();
  if (row.place != null) {
    return { kind: "place", place: row.place, newlyClaimed: row.newly_claimed, placesTaken: row.places_taken };
  }

  // No place. Take the discount off every item that carries one (the app only
  // ever puts it on the base plan item), and stop the subscription claiming
  // the code. Idempotent: an item with no discount is left alone.
  console.error(
    `founding offer: ${orgId} paid ${sub.id} with ${FOUNDING_CODE} after all ${FOUNDING_SPOTS} places were taken; removing the discount`,
  );
  let discountRemoved = false;
  for (const item of sub.items?.data ?? []) {
    if ((item.discounts ?? []).length === 0) continue;
    await stripe.subscriptionItems.update(item.id, { discounts: "" });
    discountRemoved = true;
  }
  await stripe.subscriptions.update(sub.id, {
    metadata: { promo_code: "", founding_over_limit: FOUNDING_CODE },
  });
  await admin
    .from("founding_accounts")
    .update({ discount_removed_at: new Date().toISOString() })
    .eq("organization_id", orgId);
  return { kind: "over", placesTaken: row.places_taken, discountRemoved };
}
