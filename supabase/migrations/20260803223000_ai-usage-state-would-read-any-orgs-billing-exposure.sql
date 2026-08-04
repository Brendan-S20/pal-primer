-- ai_usage_state() was SECURITY DEFINER, granted to `authenticated`, and
-- performed no authorization of any kind on its caller-supplied _org_id.
--
-- THE CHAIN. `public_get_org_for_lead_form(_slug)` is granted to `anon` and
-- returns an org's UUID for any matching slug — that is its job. So any person
-- who could sign up for a free HoundStack account (any tenant, any role, down to
-- `tech`) could call ai_usage_state with a competitor's UUID and read that
-- competitor's monthly AI action count, plan allowance, overage rate, hard cap
-- and computed overage dollars owed. Repeatable monthly for a usage trend.
--
-- Found by an authorization sweep, which also established that this was the ONLY
-- SECURITY DEFINER function granted to `authenticated` that takes an org id and
-- checks nothing — every other one gates on is_org_member / has_permission /
-- has_role. That is worth recording: the pattern was applied consistently and
-- this single function escaped it.
--
-- TWO FIXES, because either alone would do and both together is cheap:
--
--   1. Revoke EXECUTE from `authenticated`. Nothing needs it: the sole caller is
--      `ai-usage.server.ts`, which goes through supabaseAdmin as service_role.
--   2. Guard the body anyway, so a future GRANT cannot silently reopen this.
--      The service_role branch keeps the legitimate caller working, since
--      auth.uid() is NULL there and a membership test would reject it.
--
-- The body below is otherwise byte-identical to what was live.

REVOKE EXECUTE ON FUNCTION public.ai_usage_state(uuid) FROM authenticated;

CREATE OR REPLACE FUNCTION public.ai_usage_state(_org_id uuid)
 RETURNS TABLE(period_month date, actions_used integer, actions_included integer, overage_cents_per_action integer, hard_cap_actions integer, over_allowance boolean, over_hard_cap boolean, overage_cents integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _tz text;
  _month date;
  _used integer;
  _included integer;
  _rate integer;
  _mult numeric;
  _hard integer;
BEGIN
  -- Authorization. Everything below reads one organization's billing exposure.
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT public.is_org_member(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'not a member of this organization'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT COALESCE(o.timezone, 'America/Chicago'), o.ai_hard_cap_multiplier
    INTO _tz, _mult
    FROM public.organizations o WHERE o.id = _org_id;
  IF _tz IS NULL THEN RETURN; END IF;

  _month := date_trunc('month', (now() AT TIME ZONE _tz))::date;

  SELECT COALESCE(p.actions, 0) INTO _used
    FROM public.ai_usage_periods p
   WHERE p.organization_id = _org_id AND p.period_month = _month;
  _used := COALESCE(_used, 0);

  SELECT pp.ai_actions_included, pp.ai_overage_cents_per_action
    INTO _included, _rate
    FROM public.organizations o
    JOIN public.platform_plans pp ON pp.id = o.plan_id
   WHERE o.id = _org_id;

  IF _included IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.organizations o
      JOIN public.platform_plans pp ON pp.id = o.plan_id
     WHERE o.id = _org_id AND pp.ai_actions_included IS NULL
  ) THEN
    SELECT min(pp.ai_actions_included) INTO _included
      FROM public.platform_plans pp
     WHERE pp.is_active AND pp.ai_actions_included IS NOT NULL;
  END IF;

  _hard := CASE WHEN _included IS NULL THEN NULL
                ELSE ceil(_included * COALESCE(_mult, 3.0))::integer END;

  RETURN QUERY SELECT
    _month,
    _used,
    _included,
    _rate,
    _hard,
    (_included IS NOT NULL AND _used >= _included),
    (_hard IS NOT NULL AND _used >= _hard),
    CASE WHEN _included IS NULL OR _rate IS NULL OR _used <= _included THEN 0
         ELSE (_used - _included) * _rate END;
END;
$function$;

-- Assert both halves actually landed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      LEFT JOIN LATERAL aclexplode(p.proacl) ae ON true
      LEFT JOIN pg_roles r ON r.oid = ae.grantee
     WHERE n.nspname = 'public' AND p.proname = 'ai_usage_state'
       AND r.rolname = 'authenticated'
  ) THEN
    RAISE EXCEPTION 'ai_usage_state is still executable by authenticated';
  END IF;

  IF (SELECT prosrc FROM pg_proc WHERE proname = 'ai_usage_state') NOT LIKE '%is_org_member%' THEN
    RAISE EXCEPTION 'ai_usage_state lost its membership guard';
  END IF;
END $$;
