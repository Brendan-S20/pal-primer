-- Only an owner changes who is on the team or what their role is (#659,
-- R2-18 / F-31, decision D7).
--
-- WHAT WAS WRONG. Settings -> Users shows Deactivate, Reactivate and the role
-- picker to the owner only. The database did not agree:
--
--   * set_staff_active (20261009180000) let an office manager turn anybody
--     off or on -- an owner included, as long as another owner stayed on.
--   * "Managers write staff" is FOR ALL on manage_users, which an office
--     manager holds. So the same person could PATCH /rest/v1/staff directly:
--     active = false on a teammate, or role = 'owner' on their own row.
--
-- change_user_role was already owner-only; it is not touched.
--
-- THE RULE (D7, Brendan, 2026-11-02): only an owner turns a person on or
-- off, or changes a role, and nobody but an owner writes role = 'owner'. The
-- rule the screen already showed.
--
-- HOW. An office manager still edits a teammate's addresses, routing and
-- skills through "Managers write staff", so that policy stays. What is added
-- are RESTRICTIVE policies, which can only take access away:
--
--   UPDATE  a non-owner's write must leave active and role as they were;
--   INSERT  only an owner inserts a staff row with role = 'owner';
--   DELETE  only an owner removes a staff row (a deletion is a deactivation
--           with no way back).
--
-- SECURITY DEFINER functions (set_staff_active, change_user_role,
-- accept_org_invite_for_current_user, the account-deletion purge) and the
-- service role are not subject to RLS; each carries its own check.
--
-- WHO DID IT. Every change of staff.active or staff.role, by any path, writes
-- an activity_log row naming the actor (auth.uid(); NULL for the service role
-- or a migration, labelled "system"). An AFTER trigger, so a refused write
-- logs nothing.
--
-- Replays into an empty database: function and policy definitions and
-- assertions about what this file establishes. No rows are read or written.

-- ── 1. set_staff_active: owner only ─────────────────────────────────────────
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
  -- D7 (#659): owner only. An office manager was allowed here until
  -- 20261102140000.
  IF NOT public.has_role(auth.uid(), _org, 'owner'::app_role) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Only an owner can turn people on or off.';
  END IF;
  -- The last owner who is on cannot be turned off: tg_keep_an_active_owner.
  UPDATE public.staff SET active = _active WHERE id = _staff_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_staff_active(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_staff_active(uuid, boolean) TO authenticated, service_role;

-- ── 2. The table itself: what a non-owner may not change ────────────────────
-- Reads the row as it is stored. STABLE, so inside the UPDATE's WITH CHECK it
-- sees the row before the update. SECURITY DEFINER so it reads the stored row
-- whatever the caller's SELECT policy says.
--
-- It answers only about a row in the caller's own business: a policy
-- expression runs as the querying role, so EXECUTE cannot be revoked from
-- authenticated, and a SECURITY DEFINER function that takes another tenant's
-- row id must ask who is calling
-- (tests/six-helpers-that-answered-questions-about-other-peoples-tenants).
-- For anyone else it says false, which can only refuse.
CREATE OR REPLACE FUNCTION public.staff_authority_unchanged(
  _staff_id uuid, _active boolean, _role public.staff_role)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.staff s
     WHERE s.id = _staff_id
       AND (auth.uid() IS NULL OR public.is_org_member(auth.uid(), s.organization_id))
       AND s.active IS NOT DISTINCT FROM _active
       AND s.role IS NOT DISTINCT FROM _role
  );
$function$;

REVOKE ALL ON FUNCTION public.staff_authority_unchanged(uuid, boolean, public.staff_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_authority_unchanged(uuid, boolean, public.staff_role) TO authenticated, service_role;

COMMENT ON FUNCTION public.staff_authority_unchanged(uuid, boolean, public.staff_role) IS
  'True when the stored staff row already has this active and role. The UPDATE check behind "Only an owner changes who is on or their role" (20261102140000, #659).';

DROP POLICY IF EXISTS "Only an owner changes who is on or their role" ON public.staff;
CREATE POLICY "Only an owner changes who is on or their role" ON public.staff
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (true)
  WITH CHECK (
    public.has_role((SELECT auth.uid()), organization_id, 'owner'::public.app_role)
    OR public.staff_authority_unchanged(id, active, role)
  );

DROP POLICY IF EXISTS "Only an owner adds an owner" ON public.staff;
CREATE POLICY "Only an owner adds an owner" ON public.staff
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (
    role IS DISTINCT FROM 'owner'::public.staff_role
    OR public.has_role((SELECT auth.uid()), organization_id, 'owner'::public.app_role)
  );

DROP POLICY IF EXISTS "Only an owner removes a person" ON public.staff;
CREATE POLICY "Only an owner removes a person" ON public.staff
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.has_role((SELECT auth.uid()), organization_id, 'owner'::public.app_role));

-- ── 3. Who did it ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_log_staff_authority_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  _actor uuid := auth.uid();
  _label text;
BEGIN
  IF _actor IS NULL THEN
    _label := 'system';
  ELSE
    SELECT s.display_name INTO _label
      FROM public.staff s
     WHERE s.user_id = _actor AND s.organization_id = NEW.organization_id
     LIMIT 1;
    _label := COALESCE(_label, 'Someone outside the team');
  END IF;

  IF OLD.active IS DISTINCT FROM NEW.active THEN
    INSERT INTO public.activity_log (organization_id, actor_user_id, actor_label, kind, summary, meta)
    VALUES (
      NEW.organization_id, _actor, left(_label, 200), 'staff.active_changed',
      left(format('%s %s %s', _label,
                  CASE WHEN NEW.active THEN 'turned on' ELSE 'turned off' END,
                  NEW.display_name), 500),
      jsonb_build_object('staff_id', NEW.id, 'user_id', NEW.user_id,
                         'from', OLD.active, 'to', NEW.active)
    );
  END IF;

  IF OLD.role IS DISTINCT FROM NEW.role THEN
    INSERT INTO public.activity_log (organization_id, actor_user_id, actor_label, kind, summary, meta)
    VALUES (
      NEW.organization_id, _actor, left(_label, 200), 'staff.role_changed',
      left(format('%s changed %s''s role from %s to %s', _label, NEW.display_name,
                  OLD.role, NEW.role), 500),
      jsonb_build_object('staff_id', NEW.id, 'user_id', NEW.user_id,
                         'from', OLD.role, 'to', NEW.role)
    );
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_log_staff_authority_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS staff_logs_authority_change ON public.staff;
CREATE TRIGGER staff_logs_authority_change
  AFTER UPDATE OF active, role ON public.staff
  FOR EACH ROW
  WHEN (OLD.active IS DISTINCT FROM NEW.active OR OLD.role IS DISTINCT FROM NEW.role)
  EXECUTE FUNCTION public.tg_log_staff_authority_change();

-- ── 4. What this file establishes ───────────────────────────────────────────
DO $check$
BEGIN
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'staff' AND permissive = 'RESTRICTIVE'
         AND policyname IN ('Only an owner changes who is on or their role',
                            'Only an owner adds an owner',
                            'Only an owner removes a person')) <> 3 THEN
    RAISE EXCEPTION 'staff is missing one of the three owner-only restrictive policies';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.set_staff_active(uuid, boolean)'::regprocedure)
       LIKE '%office_manager%' THEN
    RAISE EXCEPTION 'set_staff_active still lets an office manager turn people on or off';
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
