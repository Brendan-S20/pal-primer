-- Off means off.
--
-- Turning a person off on Settings -> Users (set_staff_active, staff.active =
-- false) took them off the seat count and nothing else. Every permission check
-- -- has_role, is_org_member, has_permission, can_write_org, the RLS helpers,
-- useMyRole, the server functions -- read user_roles, and turning somebody off
-- does not touch user_roles. So a person who had been turned off kept signing
-- in and working, and a business could leave everyone but the owner "off" and
-- pay for one seat. The owner's rule is that every enabled user counts; the
-- converse has to hold too: a user who does not count is not enabled.
--
-- Found by a read-only investigation (INV-2, 2026-10-09). This file:
--
--   1. The six primitives answer false for a person whose staff row in that
--      organization is inactive. A membership with no staff row at all is
--      unchanged: only an explicit "off" takes access away, so nobody is locked
--      out by a row that was never written. One indexed probe, on a partial
--      index that holds only the rows that are off (normally none).
--
--   2. The helpers that let a technician read a customer because the customer
--      is on their own route (may_read_client, may_read_client_row,
--      may_read_property, may_read_property_row, my_day_stop_facts,
--      post_credit_entry) match the staff row by user and never asked whether
--      it was on. They do now. Spliced by name, as 20261002010000 did, so no
--      second copy of a body is written here to drift from the first.
--
--   3. Five policies asked user_roles directly instead of a primitive (leads x3,
--      org_invites, platform_org_feature_flags) and are rewritten onto them.
--      Same roles, same meaning; they now inherit the check above.
--
--   4. At least one owner keeps access. Turning off the last owner who is on,
--      or demoting the last such owner, is refused by a trigger -- not only in
--      set_staff_active, because the staff UPDATE policy lets an owner write
--      staff.active straight from the browser.
--
--      set_staff_active itself could never succeed: it wrote staff.updated_at,
--      a column staff does not have. Fixed here, or none of this is reachable.
--
--   5. An accepted invitation joins ACTIVE whatever the role. It used to be
--      `active = (role = 'tech')`, so an office manager or a dispatcher joined
--      with full access and no seat.
--
--   6. public.access_turned_off(): the one thing a person who is off may still
--      ask -- which business turned them off -- so the app can say so instead
--      of drawing a workspace that will not load.
--
-- Platform admins: is_platform_admin is re-issued with the same body; it never
-- read staff and still does not. Impersonation mints a real session for the
-- target, so it sees exactly what the target sees, which is the point of it.
--
-- Replays into an empty database: every object named here is created earlier
-- in the sequence; nothing below needs a row to exist.

-- ── 1. The index the probe uses ────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS staff_turned_off_idx
  ON public.staff (organization_id, user_id)
  WHERE NOT active;

-- ── 1. The primitives ──────────────────────────────────────────────────────
-- Bodies as 20260731270000 left them, with 20261002010000's second step, the
-- identity read through (SELECT auth.uid()), and the new NOT EXISTS.

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _org_id uuid, _role app_role)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT ((SELECT auth.uid()) IS NULL OR _user_id IS NOT DISTINCT FROM (SELECT auth.uid()))
     AND public.mfa_satisfied()
     AND EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND organization_id = _org_id AND role = _role
  )
     AND NOT EXISTS (
    SELECT 1 FROM public.staff s
    WHERE s.organization_id = _org_id AND s.user_id = _user_id AND NOT s.active
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_org_member(_user_id uuid, _org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT ((SELECT auth.uid()) IS NULL OR _user_id IS NOT DISTINCT FROM (SELECT auth.uid()))
     AND public.mfa_satisfied()
     AND EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND organization_id = _org_id
  )
     AND NOT EXISTS (
    SELECT 1 FROM public.staff s
    WHERE s.organization_id = _org_id AND s.user_id = _user_id AND NOT s.active
  );
$function$;

CREATE OR REPLACE FUNCTION public.can_write_org(_user_id uuid, _org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT ((SELECT auth.uid()) IS NULL OR _user_id IS NOT DISTINCT FROM (SELECT auth.uid()))
     AND public.mfa_satisfied()
     AND EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND organization_id = _org_id
      AND role IN ('owner', 'office_manager', 'dispatcher')
  )
     AND NOT EXISTS (
    SELECT 1 FROM public.staff s
    WHERE s.organization_id = _org_id AND s.user_id = _user_id AND NOT s.active
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_platform_admin(_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT ((SELECT auth.uid()) IS NULL OR _user_id IS NOT DISTINCT FROM (SELECT auth.uid()))
     AND public.mfa_satisfied()
     AND EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = _user_id)
$function$;

CREATE OR REPLACE FUNCTION public.is_visit_tech(_user_id uuid, _visit_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT ((SELECT auth.uid()) IS NULL OR _user_id IS NOT DISTINCT FROM (SELECT auth.uid()))
     AND EXISTS (
    SELECT 1 FROM public.visits v
    JOIN public.staff s ON s.id = v.assigned_staff_id
    WHERE v.id = _visit_id AND s.user_id = _user_id AND s.active
  );
$function$;

-- Mirrors ROLE_PERMISSIONS in src/lib/permissions.ts (tests/permission-parity).
CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _org_id uuid, _permission text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT ((SELECT auth.uid()) IS NULL OR _user_id IS NOT DISTINCT FROM (SELECT auth.uid()))
     AND public.mfa_satisfied()
     AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = _user_id
      AND ur.organization_id = _org_id
      AND (
        ur.role = 'owner'
        OR (ur.role = 'office_manager' AND _permission NOT IN ('manage_org_billing', 'manage_franchise'))
        OR (ur.role = 'dispatcher' AND _permission IN ('view_client_directory', 'record_field_addons'))
        OR (ur.role = 'tech' AND _permission = 'record_field_addons')
      )
  )
     AND NOT EXISTS (
    SELECT 1 FROM public.staff s
    WHERE s.organization_id = _org_id AND s.user_id = _user_id AND NOT s.active
  );
$function$;

-- Re-created, so re-closed: CREATE in this schema grants to PUBLIC (see
-- the-lockdown-that-only-held-for-the-functions-that-existed-that-day).
-- `authenticated` and service_role keep their explicit grants; RLS needs them.
REVOKE ALL ON FUNCTION public.has_role(uuid, uuid, public.app_role) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_org_member(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_write_org(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_platform_admin(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_visit_tech(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.has_permission(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, uuid, public.app_role) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_org_member(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_write_org(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_platform_admin(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_visit_tech(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_permission(uuid, uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.has_permission(uuid, uuid, text) IS
  'Mirrors ROLE_PERMISSIONS in src/lib/permissions.ts; the IMP-3 parity test pins them together. Answers only about the CALLER, only after the second step when they have one, and never for a person whose staff row in that organization is turned off (20261009180000).';

-- ── 2. "On my own route" helpers ───────────────────────────────────────────
DO $route$
DECLARE
  _fn text;
  _def text;
  _new text;
  _match constant text := 's.user_id = auth.uid()';
BEGIN
  FOREACH _fn IN ARRAY ARRAY[
    'public.may_read_client(uuid)',
    'public.may_read_client_row(uuid, uuid)',
    'public.may_read_property(uuid)',
    'public.may_read_property_row(uuid, uuid)',
    'public.my_day_stop_facts(uuid[])',
    'public.post_credit_entry(uuid, uuid, integer, text, uuid, uuid, text)'
  ] LOOP
    _def := pg_get_functiondef(_fn::regprocedure);
    IF strpos(_def, _match || ' AND s.active') > 0 THEN
      CONTINUE;
    END IF;
    _new := replace(_def, _match, _match || ' AND s.active');
    IF _new = _def THEN
      RAISE EXCEPTION '% no longer matches the staff row by %; re-cut this splice against the current body.', _fn, _match;
    END IF;
    EXECUTE _new;
  END LOOP;
END
$route$;

-- ── 3. Policies that read user_roles themselves ────────────────────────────
-- TO authenticated, where they were TO public: a policy that calls a primitive
-- needs EXECUTE on it, and anon has none. For anon these four could never pass
-- anyway (auth.uid() is NULL, so no user_roles row matched), so nothing anon
-- could do changes; the public lead form is its own INSERT policy.
ALTER POLICY "Managers can read leads" ON public.leads
  TO authenticated
  USING (public.has_role((SELECT auth.uid()), organization_id, 'owner'::public.app_role)
      OR public.has_role((SELECT auth.uid()), organization_id, 'office_manager'::public.app_role));
ALTER POLICY "Managers can delete leads" ON public.leads
  TO authenticated
  USING (public.has_role((SELECT auth.uid()), organization_id, 'owner'::public.app_role)
      OR public.has_role((SELECT auth.uid()), organization_id, 'office_manager'::public.app_role));
ALTER POLICY "Managers can update leads" ON public.leads
  TO authenticated
  USING (public.has_role((SELECT auth.uid()), organization_id, 'owner'::public.app_role)
      OR public.has_role((SELECT auth.uid()), organization_id, 'office_manager'::public.app_role))
  WITH CHECK (public.has_role((SELECT auth.uid()), organization_id, 'owner'::public.app_role)
      OR public.has_role((SELECT auth.uid()), organization_id, 'office_manager'::public.app_role));
ALTER POLICY org_invites_manage ON public.org_invites
  TO authenticated
  USING (public.has_role((SELECT auth.uid()), organization_id, 'owner'::public.app_role)
      OR public.has_role((SELECT auth.uid()), organization_id, 'office_manager'::public.app_role))
  WITH CHECK (public.has_role((SELECT auth.uid()), organization_id, 'owner'::public.app_role)
      OR public.has_role((SELECT auth.uid()), organization_id, 'office_manager'::public.app_role));
ALTER POLICY "Org flags are read by that org or by a platform admin" ON public.platform_org_feature_flags
  USING (public.is_org_member((SELECT auth.uid()), organization_id)
      OR public.is_platform_admin((SELECT auth.uid())));

-- ── 4. Somebody has to be able to turn people back on ──────────────────────
CREATE OR REPLACE FUNCTION public.tg_keep_an_active_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  -- Only an owner leaving matters. On staff, that is an owner being turned
  -- off; on user_roles (the trigger's WHEN), an owner being demoted.
  IF TG_TABLE_NAME = 'staff' AND NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = NEW.user_id AND ur.organization_id = NEW.organization_id
       AND ur.role = 'owner'
  ) THEN
    RETURN NEW;
  END IF;

  -- Two owners turning each other off at the same moment take turns.
  PERFORM pg_advisory_xact_lock(hashtext('houndstack.active-owner'), hashtext(NEW.organization_id::text));

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.organization_id = NEW.organization_id
       AND ur.role = 'owner'
       AND ur.user_id <> NEW.user_id
       AND NOT EXISTS (
         SELECT 1 FROM public.staff s
          WHERE s.organization_id = ur.organization_id AND s.user_id = ur.user_id AND NOT s.active
       )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'The business needs at least one owner who can sign in. Make someone else an owner first.',
      HINT = 'last_active_owner';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_keep_an_active_owner() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS staff_keeps_an_active_owner ON public.staff;
CREATE TRIGGER staff_keeps_an_active_owner
  BEFORE UPDATE OF active ON public.staff
  FOR EACH ROW
  WHEN (OLD.active AND NOT NEW.active)
  EXECUTE FUNCTION public.tg_keep_an_active_owner();

DROP TRIGGER IF EXISTS user_roles_keeps_an_active_owner ON public.user_roles;
CREATE TRIGGER user_roles_keeps_an_active_owner
  BEFORE UPDATE OF role ON public.user_roles
  FOR EACH ROW
  WHEN (OLD.role = 'owner'::public.app_role AND NEW.role IS DISTINCT FROM 'owner'::public.app_role)
  EXECUTE FUNCTION public.tg_keep_an_active_owner();

-- And the switch itself never worked. set_staff_active (20260702102436) ends
-- `SET active = _active, updated_at = now()`, and staff has no updated_at --
-- not in any migration, not in the generated types. So every press of
-- Deactivate on Settings -> Users raised `column "updated_at" of relation
-- "staff" does not exist` and changed nothing, which is also why every staff
-- row in production is active. Same body, same guards, without the column.
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
  IF NOT public.has_role(auth.uid(), _org, 'owner'::app_role)
     AND NOT public.has_role(auth.uid(), _org, 'office_manager'::app_role) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  -- The last owner who is on cannot be turned off: tg_keep_an_active_owner.
  UPDATE public.staff SET active = _active WHERE id = _staff_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_staff_active(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_staff_active(uuid, boolean) TO authenticated, service_role;

-- ── 5. An accepted invitation is a seat ────────────────────────────────────
DO $invite$
DECLARE
  _def text;
  _new text;
  _old_tail constant text := 'split_part(_email, ''@'', 1), _inv.role::text = ''tech'');';
  _new_tail constant text := 'split_part(_email, ''@'', 1), true);';
BEGIN
  _def := pg_get_functiondef('public.accept_org_invite_for_current_user(text)'::regprocedure);
  IF strpos(_def, _new_tail) > 0 THEN
    RETURN;
  END IF;
  _new := replace(_def, _old_tail, _new_tail);
  IF _new = _def THEN
    RAISE EXCEPTION 'accept_org_invite_for_current_user no longer inserts staff with %; re-cut this splice.', _old_tail;
  END IF;
  EXECUTE _new;
END
$invite$;

-- ── 6. What a person who is off may still ask ──────────────────────────────
CREATE OR REPLACE FUNCTION public.access_turned_off()
RETURNS TABLE (organization_id uuid, organization_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT o.id, o.name
    FROM public.user_roles ur
    JOIN public.staff s
      ON s.organization_id = ur.organization_id AND s.user_id = ur.user_id AND NOT s.active
    JOIN public.organizations o ON o.id = ur.organization_id
   WHERE ur.user_id = (SELECT auth.uid());
$function$;

COMMENT ON FUNCTION public.access_turned_off() IS
  'The organization (id, name) in which the CALLER''s staff row is turned off, if any. Empty for everyone else. What the app asks to say "your access has been turned off" instead of loading a workspace that will not load.';

REVOKE ALL ON FUNCTION public.access_turned_off() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.access_turned_off() TO authenticated, service_role;

-- ── What this file establishes ─────────────────────────────────────────────
DO $check$
DECLARE
  _fn text;
  _bad text;
BEGIN
  FOREACH _fn IN ARRAY ARRAY[
    'public.has_permission(uuid, uuid, text)',
    'public.has_role(uuid, uuid, public.app_role)',
    'public.can_write_org(uuid, uuid)',
    'public.is_org_member(uuid, uuid)'
  ] LOOP
    IF (SELECT prosrc FROM pg_proc WHERE oid = _fn::regprocedure) !~ 'NOT s\.active'
       OR (SELECT prosrc FROM pg_proc WHERE oid = _fn::regprocedure) !~ 'public\.mfa_satisfied\(\)' THEN
      RAISE EXCEPTION '% does not refuse a person who is turned off (or lost the second step)', _fn;
    END IF;
    IF (SELECT provolatile FROM pg_proc WHERE oid = _fn::regprocedure) <> 's'
       OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = _fn::regprocedure)
       OR NOT (SELECT proconfig FROM pg_proc WHERE oid = _fn::regprocedure) @> ARRAY['search_path=public'] THEN
      RAISE EXCEPTION '% must stay STABLE SECURITY DEFINER with a pinned search_path', _fn;
    END IF;
  END LOOP;

  FOREACH _fn IN ARRAY ARRAY[
    'public.may_read_client(uuid)',
    'public.may_read_client_row(uuid, uuid)',
    'public.may_read_property(uuid)',
    'public.may_read_property_row(uuid, uuid)',
    'public.my_day_stop_facts(uuid[])',
    'public.post_credit_entry(uuid, uuid, integer, text, uuid, uuid, text)',
    'public.is_visit_tech(uuid, uuid)'
  ] LOOP
    IF (SELECT prosrc FROM pg_proc WHERE oid = _fn::regprocedure) !~ 's\.active' THEN
      RAISE EXCEPTION '% still reads a turned-off staff row as on', _fn;
    END IF;
  END LOOP;

  -- No permissive policy outside user_roles' own asks user_roles directly.
  SELECT string_agg(tablename || ': ' || policyname, ', ') INTO _bad
    FROM pg_policies
   WHERE schemaname IN ('public', 'storage')
     AND permissive = 'PERMISSIVE'
     AND tablename <> 'user_roles'
     AND (coalesce(qual, '') || coalesce(with_check, '')) ~ '\muser_roles\M';
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'policies that read user_roles past the primitives: %', _bad;
  END IF;

  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.set_staff_active(uuid, boolean)'::regprocedure)
     ~ 'updated_at' THEN
    RAISE EXCEPTION 'set_staff_active still writes a column staff does not have';
  END IF;

  IF (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.accept_org_invite_for_current_user(text)'::regprocedure)
     ~ '_inv\.role::text = ''tech''\)' THEN
    RAISE EXCEPTION 'an accepted invitation still joins inactive unless the role is tech';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'staff_turned_off_idx' AND i.indisvalid
  ) THEN
    RAISE EXCEPTION 'staff_turned_off_idx is missing or INVALID';
  END IF;

  IF has_function_privilege('anon', 'public.access_turned_off()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tg_keep_an_active_owner()', 'EXECUTE') THEN
    RAISE EXCEPTION 'a function from this file is callable by a role that should not have it';
  END IF;
END
$check$;
