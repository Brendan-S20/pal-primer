-- Finding #10: (1) "Auto-assign for tech" (assign_route_for_day) only set
-- staff + sequence, leaving each visit's eta_start / eta_end / travel_km /
-- travel_min / window_violated at STALE values computed for a *different*
-- technician's depot — that's why a card showed "ETA 05:48 PM" next to a
-- "3708 min drive": the ETA was left over, not derived from the new drive.
-- Now clear those fields on every (re)assignment. (2) Add a configurable
-- max_drive_minutes plausibility threshold. Applied to live via Supabase MCP
-- on 2026-07-10. Idempotent.
CREATE OR REPLACE FUNCTION public.assign_route_for_day(_org_id uuid, _staff_id uuid, _day date, _reassign boolean DEFAULT false)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _v record;
  _seq integer := 0;
BEGIN
  IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized to assign routes for this organization';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.staff WHERE id = _staff_id AND organization_id = _org_id
  ) THEN
    RAISE EXCEPTION 'Staff not in organization';
  END IF;

  FOR _v IN
    SELECT v.id
      FROM public.visits v
      LEFT JOIN public.zones z ON z.id = v.zone_id
      LEFT JOIN public.properties p ON p.id = v.property_id
     WHERE v.organization_id = _org_id
       AND v.scheduled_on = _day
       AND v.status = 'scheduled'
       AND (_reassign OR v.assigned_staff_id IS NULL)
     ORDER BY COALESCE(z.postal_prefix, ''), COALESCE(p.postal_code, ''), v.created_at
  LOOP
    _seq := _seq + 1;
    UPDATE public.visits
       SET assigned_staff_id = _staff_id,
           sequence = _seq,
           eta_start = NULL,
           eta_end = NULL,
           travel_km = NULL,
           travel_min = NULL,
           window_violated = false
     WHERE id = _v.id;
  END LOOP;

  RETURN _seq;
END;
$function$;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS max_drive_minutes integer NOT NULL DEFAULT 240;
