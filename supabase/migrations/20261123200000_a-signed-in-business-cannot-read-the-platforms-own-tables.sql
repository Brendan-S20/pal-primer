-- #1001: Lovable's scan flags "unrestricted RLS". A signed-in user of ANY
-- business could SELECT (USING true) from three platform tables:
--   platform_addons            -> now: is_active rows only, or a platform admin
--   platform_referral_settings -> now: platform admins only
--   platform_feature_flags     -> now: platform admins only
-- Same shape as 20261119140000 (the forecast cache). The app reads all three
-- for tenants through server functions on the service role (it bypasses RLS):
-- listPlatformAddons (catalog) and getMyReferralProgram (the two reward
-- numbers) were switched to supabaseAdmin in the same change. Every database
-- function that reads them is SECURITY DEFINER, so none of them is affected.
-- Write policies are untouched; the two-step sign-in RESTRICTIVE policy stays.

DROP POLICY IF EXISTS "authenticated read active platform addons" ON public.platform_addons;
CREATE POLICY "authenticated read active platform addons" ON public.platform_addons
  FOR SELECT TO authenticated
  USING (is_active OR public.is_platform_admin((SELECT auth.uid())));

DROP POLICY IF EXISTS "authenticated read referral settings" ON public.platform_referral_settings;
CREATE POLICY "platform admins read referral settings" ON public.platform_referral_settings
  FOR SELECT TO authenticated
  USING (public.is_platform_admin((SELECT auth.uid())));

DROP POLICY IF EXISTS "Any auth user reads flag catalog" ON public.platform_feature_flags;
CREATE POLICY "platform admins read flag catalog" ON public.platform_feature_flags
  FOR SELECT TO authenticated
  USING (public.is_platform_admin((SELECT auth.uid())));
