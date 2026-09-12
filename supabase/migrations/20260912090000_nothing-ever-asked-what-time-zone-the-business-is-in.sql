-- Nothing has ever asked a new business what time zone it is in.
--
-- ── THE FAULT ─────────────────────────────────────────────────────────────
--
-- `organizations.timezone` is `NOT NULL DEFAULT 'America/Chicago'`, and
-- bootstrap_organization inserts without it:
--
--     INSERT INTO public.organizations(name, plan_status, billing_status,
--                                      trial_ends_at)
--
-- There is no timezone field anywhere in signup and nothing infers one. So
-- every workspace on earth starts in US Central, and stays there until its
-- owner happens to find Settings -> Preferences. An operator in Michigan is
-- an hour out; one in California is three. Every workday window, every
-- optimized ETA, every "visits today" boundary and every month-to-date cut is
-- wrong by that much, for a business that never made a choice at all.
--
-- This is the same fault 20260805080000 fixed for one organization by hand --
-- "its timezone said America/Chicago, so every optimized ETA was an hour out"
-- -- without ever asking why it said that. This is why.
--
-- ── WHAT IS AND IS NOT CHANGED ────────────────────────────────────────────
--
-- The COLUMN DEFAULT STAYS 'America/Chicago'. It is not a good default and
-- there is no good default, but it is NOT NULL and something has to be there
-- for a row inserted by any other path. What changes is that the one path
-- that creates real workspaces now supplies a real answer, so the default
-- stops being the answer for everybody.
--
-- EXISTING ORGANIZATIONS ARE NOT TOUCHED. A workspace already in Central may
-- really be in Central, or may be an owner who has since set it deliberately,
-- and nothing here can tell those apart. Guessing on their behalf would be a
-- worse error than the one being fixed. The two exceptions below are the only
-- rows where the evidence is unambiguous.
--
-- ── THE PARAMETER, AND WHY IT IS APPLIED AFTER THE INSERT ─────────────────
--
-- `_timezone` is the browser's own IANA zone, read at signup. Two properties
-- matter and both come from where it is applied:
--
--   1. CREATION TIME ONLY. The early `RETURN _existing` above means this code
--      is only reached when a brand-new organization is being made. An
--      idempotent re-run for somebody who already has a workspace returns
--      before it and cannot overwrite a timezone its owner has since chosen.
--      That is the same rule the coupon capture follows, for the same reason.
--
--   2. IT DOES NOT RESTATE THE DEFAULT. Applying it as an UPDATE after the
--      INSERT rather than as a value inside it means there is no second
--      written copy of 'America/Chicago' in this function to drift out of
--      step with the column. 20260911230000 is the most recent reminder of
--      what that costs.
--
-- An unrecognised zone is DROPPED, not raised on: pg_timezone_names is the
-- authority, and a browser reporting something this Postgres has never heard
-- of must never be able to block a signup. Same posture as the promo code.

DROP FUNCTION IF EXISTS public.bootstrap_organization(text, text, text, jsonb);

CREATE OR REPLACE FUNCTION public.bootstrap_organization(
  _org_name text,
  _display_name text DEFAULT NULL,
  _ref_code text DEFAULT NULL,
  _utm jsonb DEFAULT NULL,
  _timezone text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
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
  _tz text := NULL;
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

  -- pg_timezone_names is the authority on what this server can resolve. An
  -- unrecognised zone becomes NULL and the column default stands; it never
  -- raises, because a browser string must not be able to stop a signup.
  IF _timezone IS NOT NULL AND length(trim(_timezone)) > 0
     AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = trim(_timezone)) THEN
    _tz := trim(_timezone);
  END IF;

  PERFORM set_config('app.allow_protected_org_write', '1', true);

  INSERT INTO public.organizations(name, plan_status, billing_status, trial_ends_at)
  VALUES (_org_name, 'trialing'::public.org_plan_status,
          'trialing'::public.org_billing_status,
          now() + (_trial_days || ' days')::interval)
  RETURNING id INTO _org_id;

  -- Only reachable for a brand-new organization; see the header.
  IF _tz IS NOT NULL THEN
    UPDATE public.organizations SET timezone = _tz, updated_at = now() WHERE id = _org_id;
  END IF;

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

REVOKE ALL ON FUNCTION public.bootstrap_organization(text, text, text, jsonb, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.bootstrap_organization(text, text, text, jsonb, text) TO authenticated;

COMMENT ON FUNCTION public.bootstrap_organization(text, text, text, jsonb, text) IS
  'Creates a tenant organization, owner role and staff row for the calling '
  'user, once. Idempotent: returns the existing organization when the caller '
  'already has one. _timezone is the browser IANA zone captured at signup and '
  'is applied only when a new organization is actually created; an '
  'unrecognised zone is dropped and the column default stands.';

-- ── The two locations the old default caught ──────────────────────────────
--
-- Owner decision, 2026-09-12: both are Eastern.
--
-- Northside and Southside are `America/Chicago` while their parent is
-- `America/New_York`. They are not a deliberate spread. They were provisioned
-- before 20260805080000 moved the parent to Eastern, and that migration's
-- WHERE clause matched the parent alone -- it joined staff on a `W 34th St`
-- address, which no child had -- so the children kept the clock the parent had
-- at the time. provision_franchise_location copies the parent's timezone, so a
-- location created today would already be Eastern; these two predate the fix.
--
-- The evidence is their own customers. Northside's ten properties average
-- 42.580, -83.188 and Southside's ten average 42.284, -83.141: metro Detroit,
-- Michigan, which is Eastern in every county these fall in.
--
-- WHAT THIS DOES NOT UNDO. 20260819130000 recorded the decision that each
-- location's row uses its OWN clock, and cited these two as Chicago when it
-- measured the hour of disagreement it was fixing. That decision stands and
-- the machinery is untouched. It was right about the design and wrong about
-- one input: a location's own clock is the right boundary, and these two
-- locations' own clock is Eastern. After this the demo data no longer spans
-- two zones, so nothing in the seed exercises that path by hand -- that cost
-- was weighed and accepted rather than overlooked.
DO $locations$
DECLARE _n integer;
BEGIN
  UPDATE public.organizations
     SET timezone = 'America/New_York', updated_at = now()
   WHERE id IN ('05132407-765b-4f41-a98a-0fd8f7068013',
                'afaaa8bc-e182-4b45-ac3b-7c60e2d38057')
     AND timezone = 'America/Chicago';
  GET DIAGNOSTICS _n = ROW_COUNT;

  IF _n = 0 THEN
    RAISE WARNING 'no Central-time demo franchise location on this build (0 rows): either a fresh build, which has none, or both are already Eastern';
  ELSE
    RAISE NOTICE 'demo franchise location(s) moved from America/Chicago to America/New_York: % row(s)', _n;
  END IF;
END $locations$;

-- ── What this migration establishes ───────────────────────────────────────
--
-- Provable from any starting state, including an empty database, which is why
-- these are EXCEPTIONs. "No row disagrees" is satisfied by there being no rows.
DO $est$
DECLARE _n integer; _src text;
BEGIN
  -- The old four-argument overload must be gone. Leaving both would make a
  -- four-key PostgREST call ambiguous and fail every signup with "function is
  -- not unique" -- a worse outcome than the bug being fixed.
  SELECT count(*) INTO _n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'bootstrap_organization';
  IF _n <> 1 THEN
    RAISE EXCEPTION 'there are % bootstrap_organization overloads; a signup call would be ambiguous', _n;
  END IF;

  SELECT p.prosrc INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'bootstrap_organization';

  -- It must actually USE the parameter. A signature that accepts a timezone
  -- and ignores it is the exact shape of a fix that looks applied and is not.
  IF _src NOT LIKE '%SET timezone = _tz%' THEN
    RAISE EXCEPTION 'bootstrap_organization takes a timezone and never writes it';
  END IF;

  -- And it must not carry a second written copy of the default.
  IF _src LIKE '%America/Chicago%' THEN
    RAISE EXCEPTION 'bootstrap_organization restates the column default, which is how the last three of these drifted apart';
  END IF;

  SELECT count(*) INTO _n
    FROM public.organizations
   WHERE id IN ('05132407-765b-4f41-a98a-0fd8f7068013',
                'afaaa8bc-e182-4b45-ac3b-7c60e2d38057')
     AND timezone <> 'America/New_York';
  IF _n > 0 THEN
    RAISE EXCEPTION '% demo franchise location(s) are still not Eastern', _n;
  END IF;

  RAISE NOTICE 'signup carries a timezone, and no demo location is left on a clock its customers do not keep';
END $est$;

-- ── What it only measures ─────────────────────────────────────────────────
--
-- A premise, not a product: this reads whatever customers THIS database holds,
-- and a fresh build holds none. It warns either way and says out loud when it
-- had nothing to measure, so a log cannot make "the geography checks out" and
-- "no geography was checked" look the same.
DO $premise$
DECLARE _r record; _any boolean := false;
BEGIN
  FOR _r IN
    SELECT o.name, o.timezone, count(p.id) AS n,
           round(avg(p.latitude)::numeric, 3) AS lat,
           round(avg(p.longitude)::numeric, 3) AS lon
      FROM public.organizations o
      JOIN public.properties p ON p.organization_id = o.id
     WHERE p.latitude IS NOT NULL AND p.longitude IS NOT NULL
     GROUP BY o.name, o.timezone
     HAVING count(p.id) > 0
     ORDER BY count(p.id) DESC
  LOOP
    _any := true;
    RAISE WARNING 'geography: % keeps % and its % customers average %, %',
      _r.name, _r.timezone, _r.n, _r.lat, _r.lon;
  END LOOP;

  IF NOT _any THEN
    RAISE WARNING 'SKIPPED: no organization on this build has a customer with coordinates, so no timezone was checked against any geography here';
  END IF;
END $premise$;
