#!/usr/bin/env node
// Create the Oct 9 pricing objects in a Stripe account (spec NP-2, NP-3, NP-4,
// NP-8, NP-10, NP-11). TEST MODE BY DEFAULT.
//
//   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-test-setup.mjs            # create
//   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-test-setup.mjs --dry-run  # say what it would do
//
// It REFUSES a live key (sk_live_ / rk_live_) unless `--live` is passed, and
// with `--live` it still creates NEW prices only: it never edits, archives or
// deactivates a price, so every price a grandfathered subscription is on keeps
// billing exactly as it does today.
//
// What it creates, each only if the account does not already have it:
//
//   seat prices     $15/mo and $150/yr for launch, growth, scale, on each
//                   plan's own product, taking the lookup keys
//                   <slug>_seat_monthly / <slug>_seat_annual
//   add-on prices   Priority support $99/mo   addon_priority_support
//                   Done-for-you setup $199    addon_developer_setup (one time)
//                   AI Receptionist $99/mo     addon_ai_receptionist (not sold:
//                                              the app's launch flag holds it)
//   coupon          30% off, forever, applies_to the three plan products only
//                   (never an add-on product). Base and seat prices share a
//                   plan's product, so the app puts the code on the BASE ITEM
//                   only; see src/lib/founding-offer.ts.
//   promotion code  LAUNCH20 on that coupon, max_redemptions 30 (a BACKSTOP,
//                   see PROMO_MAX), first-time customers only (a returning
//                   account does not get it back)
//
// `transfer_lookup_key: true` moves a key from the old price to the new one.
// The old price stays ACTIVE (a subscription item on it renews unchanged); it
// simply stops being the one the app resolves for new purchases.
//
// Base plan prices ($79/$199/$449, $790/$1,990/$4,490) are not touched.
//
// Afterwards it prints every id, and the platform_plans / platform_addons
// columns that could be pointed at them (the app resolves by lookup key first,
// so that repoint is optional, and it is NOT done here: no database is touched).
//
// Nothing here sends a message or charges anybody.

import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const LIVE_OK = args.has("--live");
const key = process.env.STRIPE_SECRET_KEY ?? "";

/** Exported for the test that pins the refusal. */
export function keyVerdict(k, { liveOk = false } = {}) {
  if (!k) return { ok: false, why: "Set STRIPE_SECRET_KEY to an sk_test_ key." };
  if (/^[rs]k_live_/.test(k)) {
    return liveOk
      ? { ok: true, live: true }
      : { ok: false, why: "Refusing a LIVE key. This script is for test mode; pass --live only for the approved B3 step." };
  }
  if (/^[rs]k_test_/.test(k)) return { ok: true, live: false };
  return { ok: false, why: "That does not look like a Stripe secret key (sk_test_… expected)." };
}

export const PLANS = ["launch", "growth", "scale"];
export const SEAT_MONTHLY_CENTS = 1500;
export const SEAT_ANNUAL_CENTS = 15000;
export const ADDONS = [
  { slug: "priority_support", name: "Priority support", cents: 9900, recurring: "month" },
  { slug: "developer_setup", name: "Done-for-you setup", cents: 19900, recurring: null },
  { slug: "ai_receptionist", name: "AI Receptionist", cents: 9900, recurring: "month" },
];
export const COUPON_ID = "founding-30-plan-only";
export const PROMO_CODE = "LAUNCH20";
// A backstop, deliberately HIGHER than the offer's 20 places (FOUNDING_SPOTS
// in src/lib/founding-offer.ts). Stripe counts a redemption when a
// subscription carrying the code is CREATED, and the app creates it unpaid
// (default_incomplete) before the card is taken, so an abandoned checkout uses
// one. The app closes the offer at 20 accounts that PAID (founding_accounts);
// this only stops a runaway if the app's count ever failed. Set to 20, ten
// abandoned checkouts would close the offer at 10 paying founders. Stripe
// cannot change max_redemptions on an existing promotion code, so a LAUNCH20
// made with another cap keeps it (the run below says so).
export const PROMO_MAX = 30;

async function main() {
  const verdict = keyVerdict(key, { liveOk: LIVE_OK });
  if (!verdict.ok) {
    console.error(verdict.why);
    process.exit(2);
  }
  const stripe = new Stripe(key);
  const created = [];
  const kept = [];

  const byLookup = async (lookupKey) => {
    const r = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
    return r.data[0] ?? null;
  };
  const productOf = (price) => (typeof price.product === "string" ? price.product : price.product.id);

  const ensurePrice = async ({ lookupKey, product, cents, recurring, nickname }) => {
    const existing = await byLookup(lookupKey);
    const sameShape =
      existing &&
      existing.unit_amount === cents &&
      (recurring ? existing.recurring?.interval === recurring : !existing.recurring);
    if (sameShape) {
      kept.push({ lookupKey, id: existing.id, cents });
      return existing;
    }
    const params = {
      product,
      currency: "usd",
      unit_amount: cents,
      nickname,
      lookup_key: lookupKey,
      transfer_lookup_key: true,
      ...(recurring ? { recurring: { interval: recurring } } : {}),
      metadata: { created_by: "scripts/stripe-test-setup.mjs", pricing: "2026-10-09" },
    };
    if (DRY) {
      created.push({ lookupKey, id: "(dry run)", cents, replaces: existing?.id ?? null });
      return { id: "(dry run)", product };
    }
    const price = await stripe.prices.create(params);
    created.push({ lookupKey, id: price.id, cents, replaces: existing?.id ?? null });
    return price;
  };

  // ── Plans: find each plan's product through its base price ───────────────
  const planProducts = {};
  for (const slug of PLANS) {
    const base = await byLookup(`${slug}_base_monthly`);
    if (!base) {
      console.error(`No price named ${slug}_base_monthly in this account; run the catalog setup first.`);
      process.exit(3);
    }
    planProducts[slug] = productOf(base);
    await ensurePrice({
      lookupKey: `${slug}_seat_monthly`,
      product: planProducts[slug],
      cents: SEAT_MONTHLY_CENTS,
      recurring: "month",
      nickname: `${slug} extra person (monthly)`,
    });
    await ensurePrice({
      lookupKey: `${slug}_seat_annual`,
      product: planProducts[slug],
      cents: SEAT_ANNUAL_CENTS,
      recurring: "year",
      nickname: `${slug} extra person (yearly)`,
    });
  }

  // ── Add-ons ──────────────────────────────────────────────────────────────
  for (const a of ADDONS) {
    const lookupKey = `addon_${a.slug}`;
    const prior = await byLookup(lookupKey);
    let product = prior ? productOf(prior) : null;
    if (!product) {
      if (DRY) product = "(dry run)";
      else product = (await stripe.products.create({ name: `${a.name} (add-on)` })).id;
    }
    await ensurePrice({ lookupKey, product, cents: a.cents, recurring: a.recurring, nickname: a.name });
  }

  // ── Coupon and promotion code ────────────────────────────────────────────
  let coupon = await stripe.coupons.retrieve(COUPON_ID).catch(() => null);
  if (coupon) {
    kept.push({ coupon: coupon.id, percent_off: coupon.percent_off, applies_to: coupon.applies_to?.products });
  } else if (DRY) {
    created.push({ coupon: COUPON_ID, percent_off: 30, duration: "forever", applies_to: Object.values(planProducts) });
  } else {
    coupon = await stripe.coupons.create({
      id: COUPON_ID,
      // Stripe caps a coupon name at 40 characters; the first run in test mode
      // (2026-10-10) was refused at 42.
      name: "Founding: 30% off the plan price",
      percent_off: 30,
      duration: "forever",
      applies_to: { products: Object.values(planProducts) },
      metadata: { created_by: "scripts/stripe-test-setup.mjs", scope: "plan base price only (the app attaches it to the base item)" },
    });
    created.push({ coupon: coupon.id, percent_off: 30, duration: "forever", applies_to: Object.values(planProducts) });
  }

  const promos = await stripe.promotionCodes.list({ code: PROMO_CODE, limit: 10 });
  const activePromo = promos.data.find((p) => p.active);
  if (activePromo) {
    kept.push({
      promotion_code: activePromo.id,
      code: PROMO_CODE,
      max_redemptions: activePromo.max_redemptions,
      times_redeemed: activePromo.times_redeemed,
      ...(activePromo.max_redemptions !== PROMO_MAX
        ? { note: `max_redemptions is ${activePromo.max_redemptions}, not the ${PROMO_MAX} backstop; Stripe cannot change it on an existing code, so it is left as it is` }
        : {}),
    });
  } else if (DRY) {
    created.push({ promotion_code: "(dry run)", code: PROMO_CODE, max_redemptions: PROMO_MAX });
  } else {
    const promo = await stripe.promotionCodes.create({
      promotion: { type: "coupon", coupon: COUPON_ID },
      code: PROMO_CODE,
      max_redemptions: PROMO_MAX,
      restrictions: { first_time_transaction: true },
      metadata: { created_by: "scripts/stripe-test-setup.mjs" },
    });
    created.push({ promotion_code: promo.id, code: PROMO_CODE, max_redemptions: PROMO_MAX });
  }

  console.log(JSON.stringify({ mode: verdict.live ? "LIVE" : "test", dryRun: DRY, created, kept }, null, 2));
  console.log(
    "\nNothing in the database was changed. The app resolves these by lookup key; " +
      "repointing platform_plans.stripe_seat_price_id / stripe_annual_seat_price_id and " +
      "platform_addons.stripe_price_id at the new ids is optional and is a B2 step.",
  );
}

// Run only as a script, never on import (the test imports keyVerdict).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
