
CREATE OR REPLACE FUNCTION public.assign_demo_visits_to_staff(_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  staff_ids uuid[];
  v_id uuid;
  idx int := 0;
  n int;
BEGIN
  -- authorize: platform admin or org owner/manager
  IF NOT (public.is_platform_admin(auth.uid())
    OR EXISTS (SELECT 1 FROM public.user_roles
                WHERE user_id = auth.uid()
                  AND organization_id = _org_id
                  AND role IN ('owner','office_manager'))) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Field staff we actually want on routes: tech first, dispatcher, manager.
  -- Owner is excluded so they're not clogged with route work.
  SELECT array_agg(id ORDER BY
           CASE role WHEN 'tech' THEN 1
                     WHEN 'dispatcher' THEN 2
                     WHEN 'office_manager' THEN 3
                     ELSE 4 END,
           display_name)
    INTO staff_ids
  FROM public.staff
  WHERE organization_id = _org_id
    AND active
    AND role IN ('tech','dispatcher','office_manager');

  IF staff_ids IS NULL OR array_length(staff_ids, 1) = 0 THEN
    RETURN;
  END IF;
  n := array_length(staff_ids, 1);

  -- Round-robin over today + future scheduled visits
  FOR v_id IN
    SELECT id FROM public.visits
     WHERE organization_id = _org_id
       AND scheduled_on >= current_date
     ORDER BY scheduled_on, eta_start NULLS LAST, id
  LOOP
    UPDATE public.visits
       SET assigned_staff_id = staff_ids[(idx % n) + 1]
     WHERE id = v_id;
    idx := idx + 1;
  END LOOP;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.assign_demo_visits_to_staff(uuid) TO authenticated;

-- Fix current demo org data so tech@demo.test has work today
DO $$
DECLARE
  demo_org uuid;
  tech_staff uuid;
  today_ids uuid[];
BEGIN
  SELECT id INTO demo_org FROM public.organizations WHERE slug = 'demo' LIMIT 1;
  IF demo_org IS NULL THEN RETURN; END IF;

  SELECT id INTO tech_staff
    FROM public.staff
   WHERE organization_id = demo_org AND role = 'tech' AND active
   ORDER BY created_at LIMIT 1;
  IF tech_staff IS NULL THEN RETURN; END IF;

  -- Assign at least the first 2 of today's visits to the tech
  SELECT array_agg(id ORDER BY eta_start NULLS LAST, id)
    INTO today_ids
    FROM public.visits
   WHERE organization_id = demo_org
     AND scheduled_on = current_date;

  IF today_ids IS NOT NULL AND array_length(today_ids, 1) >= 1 THEN
    UPDATE public.visits
       SET assigned_staff_id = tech_staff
     WHERE id = ANY(today_ids[1:LEAST(2, array_length(today_ids,1))]);
  END IF;
END $$;
