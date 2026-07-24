-- Promo/referral code support on the platform signup flow.
--
-- The Get-started walkthrough gains an optional "Promo or referral code" box.
-- A code matching organizations.referral_code rides the EXISTING attribution
-- path (bootstrap_organization → tenant_referrals ledger; no SQL changes
-- needed). A code matching platform_coupons.code is stored here at org
-- creation, then applied as the mirrored Stripe coupon when the org first
-- subscribes (createPlanSubscription) — coupons only take effect at Stripe
-- subscribe time, so the code has to survive the gap between signup and the
-- plan picker.
ALTER TABLE public.organizations
  ADD COLUMN signup_promo_code text;

COMMENT ON COLUMN public.organizations.signup_promo_code IS
  'Platform coupon code captured on signup; applied as the Stripe coupon on the org''s first subscription. Written once (only when null).';
