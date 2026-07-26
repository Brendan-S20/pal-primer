-- Dispatch settings saves silently no-oped for non-owners (P1 audit finding):
-- updateDispatchSettings wrote organizations directly, but the only UPDATE RLS
-- policy on organizations is owner-only, so an office manager's save was a
-- 0-row no-op that PostgREST reported as success. Mirror the
-- 20260715150000_org-pricing-settings-rpc.sql pattern: a narrowly-scoped
-- SECURITY DEFINER function that enforces the role check in the database and
-- can touch ONLY the dispatch settings columns — no broad RLS widening.

CREATE OR REPLACE FUNCTION public.update_org_dispatch_settings(
  _org_id uuid,
  _workday_start time DEFAULT NULL,
  _workday_end time DEFAULT NULL,
  _avg_speed_kmh integer DEFAULT NULL,
  _traffic_profile text DEFAULT NULL,
  _max_drive_minutes integer DEFAULT NULL,
  _timezone text DEFAULT NULL,
  _work_days integer[] DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), _org_id, 'owner')
    OR public.has_role(auth.uid(), _org_id, 'office_manager')
  ) THEN
    RAISE EXCEPTION 'Not authorized to update dispatch settings';
  END IF;
  IF _avg_speed_kmh IS NOT NULL AND (_avg_speed_kmh < 5 OR _avg_speed_kmh > 120) THEN
    RAISE EXCEPTION 'Invalid average speed';
  END IF;
  IF _traffic_profile IS NOT NULL AND _traffic_profile NOT IN ('light', 'normal', 'heavy') THEN
    RAISE EXCEPTION 'Invalid traffic profile';
  END IF;
  IF _max_drive_minutes IS NOT NULL AND (_max_drive_minutes < 15 OR _max_drive_minutes > 1440) THEN
    RAISE EXCEPTION 'Invalid max drive minutes';
  END IF;
  IF _work_days IS NOT NULL AND (
    array_length(_work_days, 1) IS NULL
    OR array_length(_work_days, 1) > 7
    OR EXISTS (SELECT 1 FROM unnest(_work_days) d WHERE d < 0 OR d > 6)
  ) THEN
    RAISE EXCEPTION 'Invalid work days';
  END IF;

  -- Only the provided (non-null) settings change; the rest keep their values.
  UPDATE public.organizations
     SET workday_start = COALESCE(_workday_start, workday_start),
         workday_end = COALESCE(_workday_end, workday_end),
         avg_speed_kmh = COALESCE(_avg_speed_kmh, avg_speed_kmh),
         traffic_profile = COALESCE(_traffic_profile, traffic_profile),
         max_drive_minutes = COALESCE(_max_drive_minutes, max_drive_minutes),
         timezone = COALESCE(_timezone, timezone),
         work_days = COALESCE(_work_days, work_days)
   WHERE id = _org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization not found';
  END IF;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.update_org_dispatch_settings(uuid, time, time, integer, text, integer, text, integer[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_org_dispatch_settings(uuid, time, time, integer, text, integer, text, integer[]) TO authenticated;
