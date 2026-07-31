-- BUILD-7: a new organization actually gets the trial the site promises.
--
-- The marketing site has advertised "14 day free trial, no credit card
-- required" since launch. `bootstrap_organization` has never set `trial_ends_at`
-- or `plan_status = 'trialing'`, so every account that has ever signed up
-- landed on the `free` default and stayed there. Verified live: seven
-- organizations, zero with a trial end date, none ever in `trialing`.
--
-- The enum has carried `trialing` from the start, `billing-state.server.ts`
-- reconciles it, and the announcement audience filter targets it. As with the
-- weekly digest and the franchise rollup before it, the machinery was built and
-- nothing ever set it in motion.
--
-- ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
--
-- No backfill. The six existing `free` organizations keep exactly what they
-- have. Retro-fitting a fourteen-day clock onto an account somebody has been
-- using for weeks would be a surprise rather than a migration — they would open
-- the app tomorrow to a countdown nobody offered them. `trialStateFor` reads a
-- missing `trial_ends_at` as the `none` phase and leaves them alone.
--
-- No enforcement. An expired trial is a state and a message; nothing locks.
-- Stripe is not authorized yet, so there is no way to convert, and a paywall
-- whose only exit is a payment nobody can make is an outage. TRIAL_ENFORCEMENT
-- in src/lib/trial.ts is the single switch that turns it into a real gate when
-- Stripe goes live.
--
-- ── WHY THE TRIAL DOES NOT GRANT A PLAN ────────────────────────────────────
--
-- `plan_id` is deliberately left to `assign_billing_tier_for_org`, exactly as
-- before. The trial changes STATUS, not tier: `plan_tier_for_org()` already
-- floors an org with no plan at Launch, which is the tier the site says the
-- trial converts to. Granting a higher tier for fourteen days would take
-- features away on day fifteen — a worse experience than never showing them,
-- and it would contradict the published FAQ, which says the trial converts to
-- Launch at $79.
--
-- Idempotent. Only the two trial columns are added to the existing INSERT path.

CREATE OR REPLACE FUNCTION public.bootstrap_organization(
  _org_name text,
  _display_name text,
  _ref_code text DEFAULT NULL::text,
  _utm jsonb DEFAULT NULL::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _org_id uuid;
  _existing uuid;
  _referrer_org uuid;
  _new_email text;
  _flag_reason text := NULL;
  _recent_count int;
  _threshold int;
  -- BUILD-7. Mirrors TRIAL_DAYS in src/lib/trial.ts and TRIAL_DAYS in the
  -- marketing site's src/lib/site.ts. Three copies is two too many, but SQL
  -- cannot import from TypeScript; a test asserts the app constant against the
  -- site's published FAQ copy so a drift is caught rather than discovered by a
  -- customer whose trial ended a week early.
  _trial_days constant int := 14;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF public.is_platform_admin(_uid) THEN
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('bootstrap_organization:' || _uid::text, 0));

  SELECT organization_id INTO _existing FROM public.user_roles WHERE user_id = _uid LIMIT 1;
  IF _existing IS NOT NULL THEN
    RETURN _existing;
  END IF;

  IF NOT public.is_valid_entity_name(_org_name) THEN
    RAISE EXCEPTION 'Enter your real business name (not blank or a placeholder like "Test").'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('app.allow_protected_org_write', '1', true);

  -- BUILD-7: the trial starts here, in the same INSERT that creates the org, so
  -- there is no window in which an account exists without one. A separate
  -- UPDATE afterwards could fail on its own and leave a permanently free
  -- account that looks identical to a legitimate legacy one.
  INSERT INTO public.organizations(name, plan_status, trial_ends_at)
  VALUES (_org_name, 'trialing'::public.org_plan_status, now() + (_trial_days || ' days')::interval)
  RETURNING id INTO _org_id;

  INSERT INTO public.user_roles(user_id, organization_id, role) VALUES (_uid, _org_id, 'owner');
  INSERT INTO public.staff(organization_id, user_id, role, display_name, active)
    VALUES (_org_id, _uid, 'owner', _display_name, true);

  IF _ref_code IS NOT NULL AND length(trim(_ref_code)) > 0 THEN
    SELECT id INTO _referrer_org FROM public.organizations
     WHERE lower(referral_code) = lower(trim(_ref_code)) AND id <> _org_id
       AND deleted_at IS NULL;

    UPDATE public.organizations
       SET signup_ref_code = trim(_ref_code),
           signup_utm = _utm,
           referred_by_org_id = _referrer_org,
           updated_at = now()
     WHERE id = _org_id;

    IF _referrer_org IS NOT NULL THEN
      SELECT email INTO _new_email FROM auth.users WHERE id = _uid;

      IF EXISTS (
        SELECT 1 FROM public.user_roles ur JOIN auth.users u ON u.id = ur.user_id
        WHERE ur.organization_id = _referrer_org AND lower(u.email) = lower(_new_email)
      ) THEN
        _flag_reason := 'Self-referral suspected: signup email belongs to the referring business';
      END IF;

      SELECT volume_flag_threshold INTO _threshold FROM public.platform_referral_settings LIMIT 1;
      SELECT count(*) INTO _recent_count FROM public.tenant_referrals
       WHERE referrer_org_id = _referrer_org AND created_at > now() - interval '30 days';
      IF _flag_reason IS NULL AND (_recent_count + 1) >= COALESCE(_threshold, 5) THEN
        _flag_reason := 'High referral volume from this tenant in the last 30 days (' || (_recent_count + 1)::text || '): review for fraud';
      END IF;

      INSERT INTO public.tenant_referrals (referrer_org_id, referred_org_id, code_used, flagged, flag_reason)
      VALUES (_referrer_org, _org_id, trim(_ref_code), _flag_reason IS NOT NULL, _flag_reason);
    END IF;
  ELSIF _utm IS NOT NULL THEN
    UPDATE public.organizations SET signup_utm = _utm, updated_at = now() WHERE id = _org_id;
  END IF;

  RETURN _org_id;
END;
$function$;

COMMENT ON FUNCTION public.bootstrap_organization(text, text, text, jsonb) IS
  'Creates an organization for a new signup, with the 14-day trial the marketing site promises (BUILD-7). Idempotent per user via the advisory lock and the existing-role check. Existing organizations are deliberately not backfilled with a trial.';
