-- BUILD-7 follow-up: the trial was invisible to the people running the company.
--
-- BUILD-7 set plan_status='trialing' on signup and left billing_status at its
-- 'free' default. But /platform/tenants — the screen the platform actually
-- watches — filters, badges and bulk-selects on billing_status, and so does
-- platform-overview's status breakdown and the "3 clients on free" upgrade-
-- candidate list. So every trialing organization rendered as "Free", the
-- "trialing" filter returned zero rows no matter how many trials were running,
-- and a real trial was indistinguishable from one of the six legacy free
-- accounts.
--
-- Which column is authoritative is a question this schema has never answered —
-- both exist, several paths write one and not the other, and that asymmetry is
-- what let a suspended tenant keep its AI (see the trial.ts header). Answering
-- it properly means collapsing two columns into one, which touches billing,
-- the platform screens and the webhook, and is not something to do in passing.
--
-- What this does is narrower and safe: the two places that START a trial write
-- BOTH columns, so the platform sees the state the tenant is actually in.
-- trialStateFor already reads both, so nothing downstream changes meaning.
--
-- No backfill, because there is nothing to backfill: no organization currently
-- holds plan_status='trialing' (verified — six 'free', one 'active'). Every
-- trial that has ever existed will be created by one of these two functions.
--
-- Idempotent.

-- ── 1. Normal signup ───────────────────────────────────────────────────────
-- Identical to 20260731150000 except for the billing_status column in the
-- INSERT. Reproduced in full because CREATE OR REPLACE has no other form.
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

  -- BUILD-7: the trial starts in the same INSERT that creates the org, so there
  -- is no window in which an account exists without one. billing_status is set
  -- alongside plan_status because the platform screens read that one — see the
  -- header.
  INSERT INTO public.organizations(name, plan_status, billing_status, trial_ends_at)
  VALUES (_org_name, 'trialing'::public.org_plan_status,
          'trialing'::public.org_billing_status,
          now() + (_trial_days || ' days')::interval)
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

-- ── 2. A franchise opening a location ──────────────────────────────────────
-- Same one-column change, applied to the INSERT in
-- 20260731160000. Everything else in that function is unchanged.
CREATE OR REPLACE FUNCTION public.provision_franchise_location(
  _name text,
  _members jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _parent uuid;
  _new_org uuid;
  _tz text;
  _m jsonb;
  _email text;
  _role public.app_role;
  _taken text[];
  _clean jsonb;
  _trial_days constant int := 14;
BEGIN
  SELECT organization_id INTO _parent FROM public.user_roles
   WHERE user_id = auth.uid() LIMIT 1;
  IF _parent IS NULL THEN
    RAISE EXCEPTION 'No organization for this account.';
  END IF;
  IF NOT public.has_role(auth.uid(), _parent, 'owner'::public.app_role) THEN
    RAISE EXCEPTION 'Only the franchise owner can open a location.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.organizations
              WHERE id = _parent AND parent_organization_id IS NOT NULL) THEN
    RAISE EXCEPTION 'This organization is a location within another franchise, so it cannot open locations of its own.';
  END IF;

  IF _name IS NULL OR btrim(_name) = '' THEN
    RAISE EXCEPTION 'Give the location a name.';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('email', s.email, 'role', s.role)), '[]'::jsonb)
    INTO _clean
    FROM (
      SELECT lower(btrim(m.value->>'email')) AS email,
             coalesce((m.value->>'role')::public.app_role, 'tech'::public.app_role)::text AS role
        FROM jsonb_array_elements(coalesce(_members, '[]'::jsonb)) AS m
       WHERE btrim(coalesce(m.value->>'email', '')) <> ''
    ) s;

  SELECT array_agg(e.email) INTO _taken
    FROM (SELECT x.value->>'email' AS email FROM jsonb_array_elements(_clean) x
           GROUP BY 1 HAVING count(*) > 1) e;
  IF _taken IS NOT NULL THEN
    RAISE EXCEPTION 'This address is listed more than once: %. Each person gets one row, with the one role they hold at this location.',
      array_to_string(_taken, ', ');
  END IF;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(_clean) e
              WHERE e.value->>'role' = 'platform_admin') THEN
    RAISE EXCEPTION 'A location cannot be given platform-admin access.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(_clean) e
                  WHERE e.value->>'role' = 'owner') THEN
    RAISE EXCEPTION 'Name someone as the owner of this location. A location without an owner has nobody who can invite staff, change its settings or take payment — and the franchise is not a member of its own locations, so it cannot do those things on their behalf.';
  END IF;

  SELECT array_agg(DISTINCT e.value->>'email') INTO _taken
    FROM jsonb_array_elements(_clean) e
   WHERE EXISTS (
     SELECT 1 FROM auth.users u
      JOIN public.user_roles ur ON ur.user_id = u.id
     WHERE lower(u.email) = e.value->>'email'
   );
  IF _taken IS NOT NULL AND array_length(_taken, 1) > 0 THEN
    RAISE EXCEPTION 'These people already belong to another HoundStack organization, so they cannot be added to a new location: %. Use a different address for them, or link their existing business with an invitation code instead.',
      array_to_string(_taken, ', ');
  END IF;

  SELECT coalesce(timezone, 'America/Chicago') INTO _tz
    FROM public.organizations WHERE id = _parent;

  PERFORM set_config('app.allow_protected_org_write', '1', true);

  INSERT INTO public.organizations (name, timezone, plan_status, billing_status, trial_ends_at)
  VALUES (btrim(_name), _tz, 'trialing'::public.org_plan_status,
          'trialing'::public.org_billing_status,
          now() + (_trial_days || ' days')::interval)
  RETURNING id INTO _new_org;

  UPDATE public.organizations SET parent_organization_id = _parent WHERE id = _new_org;
  UPDATE public.organizations SET is_franchise_parent = true WHERE id = _parent;

  FOR _m IN SELECT * FROM jsonb_array_elements(_clean)
  LOOP
    _email := _m->>'email';
    _role := (_m->>'role')::public.app_role;

    INSERT INTO public.org_invites (organization_id, email, role, token, invited_by)
    VALUES (
      _new_org,
      _email,
      _role,
      replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      auth.uid()
    );
  END LOOP;

  RETURN _new_org;
END;
$$;
