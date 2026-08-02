-- The organizations UPDATE policy disagreed with the permission matrix, and
-- the disagreement was SILENT.
--
-- ── WHAT WAS ACTUALLY WRONG ────────────────────────────────────────────────
--
-- `ROLE_PERMISSIONS` grants `manage_settings` to office_manager, and
-- `has_permission()` in SQL says the same thing — the IMP-3 parity test pins
-- them together. But the only UPDATE policy on public.organizations was:
--
--   "Owners update own org"  USING has_role(auth.uid(), id, 'owner')
--
-- So every settings write an office manager made through their own RLS-bound
-- client matched ZERO ROWS. PostgREST does not treat that as an error — an
-- UPDATE that affects nothing is a successful UPDATE — so the handler saw no
-- error, returned { ok: true }, and the UI showed a success toast over a
-- setting that had not changed. Reload and it is back.
--
-- Two live cases:
--
--   - setDisputesInAnalytics: an office manager toggling whether open disputes
--     reduce the revenue figures. Reports silently keep the old basis.
--   - updateOrgBranding: the ONLY write path for contact_email, which BUILD-5
--     just made load-bearing — it is the reply-to on customer email. An office
--     manager following that new copy to fix the reply-to address gets a
--     success toast, and customer replies keep going to noreply@, which is the
--     exact failure BUILD-5 existed to fix.
--
-- ── WHY BROADEN THE POLICY RATHER THAN NARROW THE PERMISSION ───────────────
--
-- Because the permission is right. Branding, portal options, timezone and
-- notification preferences are what "manage settings" means, and an office
-- manager is who does them. The policy is the copy that drifted.
--
-- Keying it on has_permission() rather than spelling out roles is the point:
-- the matrix now has ONE definition that both layers read, so the next role
-- change cannot leave RLS behind. Everything that must stay owner-only stays
-- owner-only by a stronger mechanism than this policy —
-- tg_orgs_protect_platform_columns refuses plan_status, billing_status,
-- plan_id, both Stripe ids, trial_ends_at, grace_expires_at, suspended_at,
-- deleted_at, the referral columns, ai_receptionist_enabled and every
-- franchise column, for anyone who is not service_role. Widening who may
-- UPDATE the row does not widen which columns can be written.
--
-- Idempotent.

DROP POLICY IF EXISTS "Owners update own org" ON public.organizations;
DROP POLICY IF EXISTS "Settings managers update own org" ON public.organizations;

CREATE POLICY "Settings managers update own org"
  ON public.organizations
  FOR UPDATE
  USING (public.has_permission(auth.uid(), id, 'manage_settings'))
  WITH CHECK (public.has_permission(auth.uid(), id, 'manage_settings'));

COMMENT ON POLICY "Settings managers update own org" ON public.organizations IS
  'Keyed on has_permission rather than has_role so RLS and ROLE_PERMISSIONS cannot drift: the owner-only version made every office_manager settings write match zero rows, which PostgREST reports as success. Platform-owned columns are guarded by tg_orgs_protect_platform_columns, not by this policy.';
