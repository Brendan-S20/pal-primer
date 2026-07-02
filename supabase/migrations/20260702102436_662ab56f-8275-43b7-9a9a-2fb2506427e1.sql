
-- Fix reassign_visit: can_write_org requires (user_id, org_id)
CREATE OR REPLACE FUNCTION public.reassign_visit(_visit_id uuid, _staff_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.visits WHERE id = _visit_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'visit not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), v_org) THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF _staff_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.staff WHERE id = _staff_id AND organization_id = v_org) THEN
    RAISE EXCEPTION 'staff not in org';
  END IF;
  UPDATE public.visits SET assigned_staff_id = _staff_id, sequence = NULL, updated_at = now() WHERE id = _visit_id;
END;
$function$;

-- Fix reorder_route: same bug
CREATE OR REPLACE FUNCTION public.reorder_route(_staff_id uuid, _day date, _ordered_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_org uuid; v_id uuid; v_seq integer := 1; v_updated integer := 0;
BEGIN
  SELECT organization_id INTO v_org FROM public.staff WHERE id = _staff_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'staff not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), v_org) THEN RAISE EXCEPTION 'forbidden'; END IF;
  FOREACH v_id IN ARRAY _ordered_ids LOOP
    UPDATE public.visits
       SET assigned_staff_id = _staff_id, sequence = v_seq, updated_at = now()
     WHERE id = v_id AND organization_id = v_org AND scheduled_on = _day;
    IF FOUND THEN v_updated := v_updated + 1; END IF;
    v_seq := v_seq + 1;
  END LOOP;
  RETURN v_updated;
END;
$function$;

-- Users management RPCs for owners
CREATE OR REPLACE FUNCTION public.list_org_users(_org_id uuid)
 RETURNS TABLE(user_id uuid, email text, role app_role, staff_id uuid, display_name text, active boolean, created_at timestamptz)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), _org_id, 'owner'::app_role)
     AND NOT public.has_role(auth.uid(), _org_id, 'office_manager'::app_role) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  RETURN QUERY
    SELECT ur.user_id, au.email::text, ur.role,
           s.id, s.display_name, COALESCE(s.active, true), ur.created_at
      FROM public.user_roles ur
      LEFT JOIN auth.users au ON au.id = ur.user_id
      LEFT JOIN public.staff s ON s.user_id = ur.user_id AND s.organization_id = ur.organization_id
     WHERE ur.organization_id = _org_id
     ORDER BY ur.created_at;
END; $$;

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
END; $$;

CREATE OR REPLACE FUNCTION public.set_staff_active(_staff_id uuid, _active boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
DECLARE _org uuid;
BEGIN
  SELECT organization_id INTO _org FROM public.staff WHERE id = _staff_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'staff not found'; END IF;
  IF NOT public.has_role(auth.uid(), _org, 'owner'::app_role)
     AND NOT public.has_role(auth.uid(), _org, 'office_manager'::app_role) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  UPDATE public.staff SET active = _active, updated_at = now() WHERE id = _staff_id;
END; $$;

REVOKE EXECUTE ON FUNCTION public.list_org_users(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.change_user_role(uuid, uuid, app_role) FROM anon;
REVOKE EXECUTE ON FUNCTION public.set_staff_active(uuid, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.list_org_users(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.change_user_role(uuid, uuid, app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_staff_active(uuid, boolean) TO authenticated;
