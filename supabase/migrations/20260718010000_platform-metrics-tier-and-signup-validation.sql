-- QA round 3 phase 9 — platform console metrics + tier correctness + signup
-- validation (H5, guardrails I1/I4/I5/I11/I13 #19).
--
-- 1. Stricter org-name validation: reject all-junk-word names ("Test Test").
-- 2. bootstrap_organization enforces it server-side (I11).
-- 3. assign_billing_tier_for_org no longer downgrades paid-subscription tenants
--    by seat count (root cause of the wrong "Growth" tier on a Scale org).
-- 4. Reconcile organizations.billing_tier to the actual subscribed plan (I5).

-- ── 1. is_valid_entity_name: reject names whose every word is junk ───────────
-- The single-token blocklist let "Test Test" through (each word is "test", but
-- the two-word string isn't an exact match). Add an all-words-junk rule.
CREATE OR REPLACE FUNCTION public.is_valid_entity_name(_name text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE
    WHEN _name IS NULL THEN false
    WHEN char_length(btrim(_name)) < 2 THEN false
    WHEN btrim(_name) !~ '[A-Za-z]' THEN false
    WHEN lower(btrim(_name)) = ANY (ARRAY[
      'ew','n/a','tbd','test','asdf','qwerty','none','null','xxx','xx',
      'unknown','placeholder','.','-','--','...'
    ]) THEN false
    -- Every alphabetic word is a placeholder junk token (e.g. "Test Test").
    WHEN NOT EXISTS (
      SELECT 1
      FROM regexp_split_to_table(lower(btrim(_name)), '\s+') AS w
      WHERE w ~ '[a-z]'
        AND w <> ALL (ARRAY[
          'ew','tbd','test','asdf','qwerty','none','null','xxx','xx',
          'unknown','placeholder'
        ])
    ) THEN false
    ELSE true
  END
$function$;

-- ── 2. Validate the org name inside bootstrap_organization (server-enforced) ──
CREATE OR REPLACE FUNCTION public.bootstrap_organization(_org_name text, _display_name text, _ref_code text DEFAULT NULL::text, _utm jsonb DEFAULT NULL::jsonb)
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

  -- Signup validation (I11 / H5 #4): reject blank / placeholder / all-junk names
  -- before a junk tenant ("Test Test") is ever created.
  IF NOT public.is_valid_entity_name(_org_name) THEN
    RAISE EXCEPTION 'Enter your real business name (not blank or a placeholder like "Test").'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('app.allow_protected_org_write', '1', true);

  INSERT INTO public.organizations(name) VALUES (_org_name) RETURNING id INTO _org_id;
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

-- ── 3. Don't let the seat-count heuristic clobber a paid tenant's tier ───────
-- assign_billing_tier_for_org picks the smallest plan whose included_seats
-- covers the org's active seats. For a subscribed org this is wrong: a 4-seat
-- tenant that PAYS for Scale would be silently downgraded to Growth (10 seats
-- covers 4), which is exactly why the console showed "Growth" for a Scale org.
-- Orgs on a real paid subscription keep the plan they actually pay for.
CREATE OR REPLACE FUNCTION public.assign_billing_tier_for_org(_org_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _seats integer;
  _status text;
  _plan public.platform_plans;
BEGIN
  SELECT active_seat_count, billing_status::text
    INTO _seats, _status
    FROM public.organizations WHERE id = _org_id;
  IF _seats IS NULL THEN RETURN NULL; END IF;

  -- Paying tenants are governed by their subscription, not seat count.
  IF _status IN ('active', 'grace', 'past_due') THEN
    RETURN (SELECT p.slug FROM public.platform_plans p
            JOIN public.organizations o ON o.plan_id = p.id
            WHERE o.id = _org_id);
  END IF;

  SELECT * INTO _plan
  FROM public.platform_plans
  WHERE is_active = true AND is_enterprise = false AND included_seats IS NOT NULL
    AND included_seats >= GREATEST(_seats, 1)
  ORDER BY included_seats ASC, sort_order ASC
  LIMIT 1;

  IF _plan.id IS NULL THEN
    SELECT * INTO _plan
    FROM public.platform_plans
    WHERE is_active = true AND is_enterprise = false AND included_seats IS NOT NULL
    ORDER BY included_seats DESC, sort_order DESC
    LIMIT 1;
  END IF;

  IF _plan.id IS NOT NULL THEN
    UPDATE public.organizations
       SET billing_tier = _plan.slug,
           plan_id = _plan.id
     WHERE id = _org_id
       AND (billing_tier IS DISTINCT FROM _plan.slug OR plan_id IS DISTINCT FROM _plan.id);
  END IF;
  RETURN _plan.slug;
END;
$function$;

-- ── 4. Reconcile stored tier to the actual subscribed plan (I5, idempotent) ──
-- billing_tier is a denormalized label; plan_id (the subscription's plan) is the
-- source of truth. The demo org read plan_id = Scale but billing_tier = growth.
SELECT set_config('app.allow_protected_org_write', '1', true);
UPDATE public.organizations o
   SET billing_tier = p.slug,
       updated_at = now()
  FROM public.platform_plans p
 WHERE o.plan_id = p.id
   AND o.plan_id IS NOT NULL
   AND o.billing_tier IS DISTINCT FROM p.slug;
