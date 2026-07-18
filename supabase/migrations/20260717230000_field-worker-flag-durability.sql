-- QA round 3 phase 7 review fix (finding 1, P1): the is_field_tech capability
-- flag was corrected by a ONE-TIME backfill, but nothing kept it correct going
-- forward. staff.is_field_tech defaults to true and every INSERT path omits it,
-- so a newly-invited dispatcher/office_manager defaulted to true; and
-- change_user_role updated user_roles.role only, never staff, so demoting a tech
-- to dispatcher left is_field_tech = true. Either re-introduces the exact C3
-- pollution this fix removed. Make the derivation durable:
--   1) a BEFORE INSERT trigger derives is_field_tech from staff.role (unless an
--      explicit override was set), so new staff are role-correct regardless of
--      the column default or which insert path created them.
--   2) change_user_role syncs the staff row (role + is_field_tech) on a role
--      change, respecting a manual override.

-- ── 1) derive-on-insert ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_staff_field_flag()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  -- A manual override (owner flagged a working owner in, or a tech out) wins;
  -- otherwise the flag follows the role: only techs are field workers.
  IF NOT COALESCE(NEW.is_field_tech_overridden, false) THEN
    NEW.is_field_tech := (NEW.role = 'tech');
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS staff_field_flag ON public.staff;
CREATE TRIGGER staff_field_flag
  BEFORE INSERT ON public.staff
  FOR EACH ROW EXECUTE FUNCTION public.tg_staff_field_flag();

-- ── 2) keep the flag correct across role changes ─────────────────────────────
CREATE OR REPLACE FUNCTION public.change_user_role(_org_id uuid, _user_id uuid, _new_role app_role)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), _org_id, 'owner'::app_role) THEN
    RAISE EXCEPTION 'Only owners can change roles';
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
     SET role = _new_role,
         is_field_tech = CASE WHEN is_field_tech_overridden THEN is_field_tech
                              ELSE (_new_role = 'tech') END
   WHERE user_id = _user_id AND organization_id = _org_id;
END; $$;

REVOKE EXECUTE ON FUNCTION public.change_user_role(uuid, uuid, app_role) FROM anon;
GRANT EXECUTE ON FUNCTION public.change_user_role(uuid, uuid, app_role) TO authenticated;

-- Re-run the role-derived reconciliation once more (override-safe) to catch any
-- staff created between the phase-7 migration and this trigger.
UPDATE public.staff
   SET is_field_tech = (role = 'tech')
 WHERE NOT is_field_tech_overridden
   AND is_field_tech IS DISTINCT FROM (role = 'tech');
