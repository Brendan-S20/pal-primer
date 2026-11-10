-- An office manager changes roles and turns people on or off, but never the
-- owner's, and never to a role above their own (#659, decision D7 as changed
-- by Brendan on 2026-11-10).
--
-- WHAT CHANGED. 20261102140000 made both of these owner-only, the issue's
-- safe default while D7 was open. The decision is now: "Let managers too."
-- The rules that stay:
--
--   * nobody but an owner changes or turns off an owner (and the last owner
--     who is on still cannot be turned off: tg_keep_an_active_owner, and
--     change_user_role's own last-owner check);
--   * an office manager never grants a role above their own -- so never
--     owner, and never platform_admin, which app_role also holds. What they
--     may grant is office_manager, dispatcher or tech;
--   * dispatchers and technicians are still refused.
--
-- WHAT DOES NOT CHANGE. The owner's abilities. "Only an owner adds an owner"
-- (INSERT) and "Only an owner removes a person" (DELETE) are untouched:
-- deleting a staff row is not the same thing as turning someone off, and was
-- not asked for. The activity_log trigger from 20261102140000 already names
-- the actor on every change of active or role, office manager included.
--
-- THREE PATHS, ONE RULE. The server functions (users.functions.ts) say it in
-- words; set_staff_active and change_user_role enforce it for the RPC; the
-- restrictive UPDATE policy on staff enforces it for PATCH /rest/v1/staff.
--
-- Replays into an empty database: function and policy definitions and
-- assertions about what this file establishes. No rows are read or written.

-- ── 1. Is this staff row an owner? ──────────────────────────────────────────
-- Either half is enough: staff.role and user_roles are kept in step by
-- change_user_role, but a row where they disagree is exactly the row an
-- office manager must not be able to reach. Asks who is calling, like every
-- SECURITY DEFINER helper handed a tenant's row id
-- (tests/six-helpers-that-answered-questions-about-other-peoples-tenants):
-- for a row outside the caller's business it answers true, which can only
-- refuse.
CREATE OR REPLACE FUNCTION public.staff_row_is_an_owner(_staff_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT COALESCE((
    SELECT NOT (auth.uid() IS NULL OR public.is_org_member(auth.uid(), s.organization_id))
        OR s.role = 'owner'::public.staff_role
        OR EXISTS (
             SELECT 1 FROM public.user_roles ur
              WHERE ur.user_id = s.user_id
                AND ur.organization_id = s.organization_id
                AND ur.role = 'owner'::public.app_role)
      FROM public.staff s
     WHERE s.id = _staff_id
  ), true);
$function$;

REVOKE ALL ON FUNCTION public.staff_row_is_an_owner(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_row_is_an_owner(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.staff_row_is_an_owner(uuid) IS
  'True when the stored staff row is an owner (by staff.role or user_roles), or is not in the caller''s business. Behind the office-manager limits in 20261110160000 (#659).';

-- ── 2. set_staff_active: owner, or an office manager on anyone but an owner ─
CREATE OR REPLACE FUNCTION public.set_staff_active(_staff_id uuid, _active boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid;
BEGIN
  SELECT organization_id INTO _org FROM public.staff WHERE id = _staff_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'staff not found'; END IF;
  IF public.has_role(auth.uid(), _org, 'owner'::app_role) THEN
    NULL;
  ELSIF public.has_role(auth.uid(), _org, 'office_manager'::app_role) THEN
    -- D7 as changed 2026-11-10 (#659): an office manager, but never on an owner.
    IF public.staff_row_is_an_owner(_staff_id) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'An office manager cannot turn the owner on or off.';
    END IF;
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Only an owner or an office manager can turn people on or off.';
  END IF;
  -- The last owner who is on cannot be turned off: tg_keep_an_active_owner.
  UPDATE public.staff SET active = _active WHERE id = _staff_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_staff_active(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_staff_active(uuid, boolean) TO authenticated, service_role;

-- ── 3. change_user_role: owner, or an office manager within their own rank ──
CREATE OR REPLACE FUNCTION public.change_user_role(_org_id uuid, _user_id uuid, _new_role app_role)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF public.has_role(auth.uid(), _org_id, 'owner'::app_role) THEN
    NULL;
  ELSIF public.has_role(auth.uid(), _org_id, 'office_manager'::app_role) THEN
    -- D7 as changed 2026-11-10 (#659). Never a role above their own.
    IF _new_role NOT IN ('office_manager'::app_role, 'dispatcher'::app_role, 'tech'::app_role) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'An office manager cannot give anyone a role above their own.';
    END IF;
    -- Never the owner.
    IF EXISTS (SELECT 1 FROM public.user_roles
                WHERE user_id = _user_id AND organization_id = _org_id AND role = 'owner'::app_role)
       OR EXISTS (SELECT 1 FROM public.staff
                   WHERE user_id = _user_id AND organization_id = _org_id AND role = 'owner'::staff_role) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'An office manager cannot change the owner''s role.';
    END IF;
    -- Only somebody already on this team. The owner's path below inserts a
    -- role row when there is none; an office manager adds people by invite.
    IF NOT EXISTS (SELECT 1 FROM public.user_roles
                    WHERE user_id = _user_id AND organization_id = _org_id) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'That person is not on your team.';
    END IF;
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Only an owner or an office manager can change roles.';
  END IF;
  -- Prevent removing the last owner
  IF _new_role <> 'owner'::app_role AND EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND organization_id = _org_id AND role = 'owner'::app_role
  ) THEN
    IF (SELECT COUNT(*) FROM public.user_roles WHERE organization_id = _org_id AND role = 'owner'::app_role) <= 1 THEN
      RAISE EXCEPTION 'Cannot demote the last owner';
    END IF;
  END IF;
  UPDATE public.user_roles SET role = _new_role WHERE user_id = _user_id AND organization_id = _org_id;
  IF NOT FOUND THEN
    INSERT INTO public.user_roles(user_id, organization_id, role) VALUES (_user_id, _org_id, _new_role);
  END IF;
  -- Keep the staff row's role and field-worker flag in step with the new role
  -- (C3): a manual override on is_field_tech is preserved.
  UPDATE public.staff
     SET role = _new_role::text::public.staff_role,
         is_field_tech = CASE WHEN is_field_tech_overridden THEN is_field_tech
                              ELSE (_new_role = 'tech') END
   WHERE user_id = _user_id AND organization_id = _org_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.change_user_role(uuid, uuid, app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.change_user_role(uuid, uuid, app_role) TO authenticated, service_role;

-- ── 4. The table itself (PATCH /rest/v1/staff) ──────────────────────────────
-- Same rule as the two functions. WITH CHECK sees the NEW row; the two
-- helpers read the STORED row (STABLE, so inside the UPDATE they see it as it
-- was before). An office manager's write may change active or role only on a
-- row that was not an owner's, and only to a role no higher than their own.
-- Address, routing and skill edits change neither and pass as before.
DROP POLICY IF EXISTS "Only an owner changes who is on or their role" ON public.staff;
DROP POLICY IF EXISTS "Owner or office manager sets who is on; never the owner" ON public.staff;
CREATE POLICY "Owner or office manager sets who is on; never the owner" ON public.staff
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (true)
  WITH CHECK (
    public.has_role((SELECT auth.uid()), organization_id, 'owner'::public.app_role)
    OR public.staff_authority_unchanged(id, active, role)
    OR (
      public.has_role((SELECT auth.uid()), organization_id, 'office_manager'::public.app_role)
      AND role IN ('office_manager'::public.staff_role, 'dispatcher'::public.staff_role, 'tech'::public.staff_role)
      AND NOT public.staff_row_is_an_owner(id)
    )
  );

-- ── 5. What this file establishes ───────────────────────────────────────────
DO $check$
DECLARE _src text;
BEGIN
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'staff' AND permissive = 'RESTRICTIVE'
         AND policyname IN ('Owner or office manager sets who is on; never the owner',
                            'Only an owner adds an owner',
                            'Only an owner removes a person')) <> 3 THEN
    RAISE EXCEPTION 'staff is missing one of the three restrictive staff-authority policies';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'staff'
                AND policyname = 'Only an owner changes who is on or their role') THEN
    RAISE EXCEPTION 'the owner-only UPDATE policy is still on staff and would refuse an office manager';
  END IF;

  _src := (SELECT prosrc FROM pg_proc WHERE oid = 'public.set_staff_active(uuid, boolean)'::regprocedure);
  IF strpos(_src, 'public.staff_row_is_an_owner(_staff_id)') = 0 THEN
    RAISE EXCEPTION 'set_staff_active does not keep an office manager off the owner';
  END IF;

  _src := (SELECT prosrc FROM pg_proc WHERE oid = 'public.change_user_role(uuid, uuid, app_role)'::regprocedure);
  IF strpos(_src, 'An office manager cannot give anyone a role above their own.') = 0
     OR strpos(_src, 'An office manager cannot change the owner''s role.') = 0 THEN
    RAISE EXCEPTION 'change_user_role does not hold an office manager to their own rank and off the owner';
  END IF;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('set_staff_active', 'change_user_role')) <> 2 THEN
    RAISE EXCEPTION 'set_staff_active or change_user_role has an overload this body does not cover';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.staff'::regclass AND tgname = 'staff_logs_authority_change'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'staff changes of active or role are not logged';
  END IF;
END
$check$;
