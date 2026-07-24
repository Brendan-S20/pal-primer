// Classification for the single "Promo or referral code" box on signup.
//
// One input accepts BOTH kinds of code:
//  - platform_coupons.code        → SaaS discount. Stored on the org at
//    creation (organizations.signup_promo_code) and applied as the mirrored
//    Stripe coupon on the org's FIRST subscribe (createPlanSubscription).
//  - organizations.referral_code  → tenant referral attribution. Handed to
//    bootstrap_organization, which owns the tenant_referrals ledger, fraud
//    flags, and conversion semantics — nothing new here.
//
// Coupons win ties: they're platform-admin-minted, while referral codes are
// generated from an unambiguous machine alphabet, so overlaps shouldn't
// happen in practice.
//
// Invalid codes NEVER block signup — callers warn and proceed without them.

type CouponRow = {
  id: string;
  code: string;
  stripe_coupon_id: string | null;
  percent_off: number | null;
  amount_off_cents: number | null;
  duration: string;
  duration_in_months: number | null;
  expires_at: string | null;
  is_active: boolean;
  max_redemptions: number | null;
  times_redeemed: number;
  applies_to_plan_ids: string[] | null;
};

export type SignupCodeLookup =
  | { kind: "coupon"; coupon: CouponRow; description: string }
  | { kind: "referral"; referrerOrgId: string; referrerName: string; description: string }
  | { kind: "invalid"; reason: string };

// User-typed input goes into ilike (case-insensitive match): escape the LIKE
// metacharacters so "10%OFF" can't wildcard-match another code.
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function couponDiscountLabel(c: {
  percent_off: number | null;
  amount_off_cents: number | null;
  duration: string;
  duration_in_months: number | null;
}): string {
  const amount = c.percent_off
    ? `${Number(c.percent_off) % 1 === 0 ? Number(c.percent_off) : c.percent_off}% off`
    : `$${((c.amount_off_cents ?? 0) / 100).toFixed(2)} off`;
  const span =
    c.duration === "forever"
      ? "for as long as you subscribe"
      : c.duration === "repeating"
        ? `for ${c.duration_in_months ?? 1} month${(c.duration_in_months ?? 1) === 1 ? "" : "s"}`
        : "your first payment";
  return `${amount} ${span}`;
}

export async function lookupSignupCode(
  supabaseAdmin: any,
  rawCode: string,
): Promise<SignupCodeLookup> {
  const code = rawCode.trim();
  if (!code) return { kind: "invalid", reason: "Enter a code." };
  if (code.length > 40) return { kind: "invalid", reason: "That code isn't valid." };

  // platform_coupons.code is only case-sensitively unique, so match with
  // limit(1) instead of maybeSingle (which errors on 2+ rows).
  const { data: couponRows } = await supabaseAdmin
    .from("platform_coupons")
    .select(
      "id, code, stripe_coupon_id, percent_off, amount_off_cents, duration, duration_in_months, expires_at, is_active, max_redemptions, times_redeemed, applies_to_plan_ids",
    )
    .ilike("code", escapeLike(code))
    .limit(1);
  const coupon = (couponRows?.[0] ?? null) as CouponRow | null;
  if (coupon) {
    if (!coupon.is_active) return { kind: "invalid", reason: "That code is no longer active." };
    if (coupon.expires_at && new Date(coupon.expires_at) <= new Date()) {
      return { kind: "invalid", reason: "That code has expired." };
    }
    if (coupon.max_redemptions != null && (coupon.times_redeemed ?? 0) >= coupon.max_redemptions) {
      return { kind: "invalid", reason: "That code has been fully redeemed." };
    }
    return {
      kind: "coupon",
      coupon,
      description: `${couponDiscountLabel(coupon)} — applied at checkout`,
    };
  }

  const { data: referrerRows } = await supabaseAdmin
    .from("organizations")
    .select("id, name")
    .ilike("referral_code", escapeLike(code))
    .is("deleted_at", null)
    .limit(1);
  const referrer = referrerRows?.[0] as { id: string; name: string } | undefined;
  if (referrer) {
    return {
      kind: "referral",
      referrerOrgId: referrer.id,
      referrerName: referrer.name,
      description: `Referred by ${referrer.name}`,
    };
  }

  return {
    kind: "invalid",
    reason: "We don't recognize that code. Check for typos — or continue without it.",
  };
}
