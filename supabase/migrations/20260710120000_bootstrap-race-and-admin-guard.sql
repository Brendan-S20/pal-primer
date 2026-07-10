-- Finding #55 hardening (applied to live via Supabase MCP apply_migration on
-- 2026-07-10 as `bootstrap_organization_race_and_admin_guard`). Idempotent.
--
-- 1. Serialize concurrent first-sign-in bootstrap calls per user with an
--    advisory xact lock, so a double-clicked confirmation link or two open
--    tabs can't both pass the existence check and create two organizations.
--    (user_roles only has UNIQUE(user_id, organization_id, role), which does
--    not prevent two rows pointing at two different orgs.)
-- 2. Never auto-provision a tenant org for a platform admin. Platform admins
--    have zero user_roles rows by design, which previously made them look
--    like a fresh signup to the deferred-bootstrap path on /auth.
CREATE OR REPLACE FUNCTION public.bootstrap_organization(_org_name text, _display_name text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _org_id uuid;
  _existing uuid;
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

  INSERT INTO public.organizations(name) VALUES (_org_name) RETURNING id INTO _org_id;
  INSERT INTO public.user_roles(user_id, organization_id, role) VALUES (_uid, _org_id, 'owner');
  INSERT INTO public.staff(organization_id, user_id, role, display_name, active)
    VALUES (_org_id, _uid, 'owner', _display_name, true);

  RETURN _org_id;
END;
$function$;
