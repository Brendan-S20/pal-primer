-- Filter platform_admin rows out of tenant-scoped user listings.
-- platform admins should never appear in the tenant Settings → Users & roles view.
CREATE OR REPLACE FUNCTION public.list_org_users(_org_id uuid)
 RETURNS TABLE(user_id uuid, email text, role app_role, staff_id uuid, display_name text, active boolean, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
       AND ur.role <> 'platform_admin'::app_role
     ORDER BY ur.created_at;
END; $function$;