-- A visit moved to another day keeps its technician when it can (QA row 16).
--
-- reschedule_visit (20260717160000) set assigned_staff_id = NULL on every
-- move. "Move to Thursday" from the visit drawer took the stop off its
-- technician's route even when Thursday is a day that technician works, so
-- the dispatcher moved it and then had to find it again in Unassigned and
-- hand it back. The weather reschedule and its Undo go through the same
-- function, so an Undo of a rained-off day put every visit back on the right
-- date and on nobody's route.
--
-- Now the technician stays when all of these hold on the new day:
--
--   * it is one of the organization's work days (organizations.work_days;
--     there are no per-technician work days in this schema, so this is the
--     whole of "a day they work");
--   * they are not on time off that day (is_staff_off, the same rule the
--     visits_respect_time_off trigger enforces, so keeping them never trips
--     it);
--   * they are still an active member who runs routes.
--
-- Otherwise it is left unassigned, as before, and the server function says
-- so to the person who moved it.
--
-- Either way the visit's old order and times go (they belonged to the old
-- day; bulk_reschedule_visits already cleared them, this did not), and both
-- lanes are recomputed with recompute_lane_etas (20261015130000): the day it
-- left, and the day it joined when the technician was kept.
--
-- Authorization is unchanged: can_write_org, as before.
--
-- Replays into an empty database: one function over helpers that exist by
-- this point (can_write_org, is_staff_off, recompute_lane_etas).

CREATE OR REPLACE FUNCTION public.reschedule_visit(_visit_id uuid, _new_date date, _note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid; _old date; _status public.visit_status; _tech uuid;
  _work integer[];
  _keep boolean := false;
BEGIN
  SELECT organization_id, scheduled_on, status, assigned_staff_id
    INTO _org, _old, _status, _tech
    FROM public.visits WHERE id = _visit_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Visit not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _status NOT IN ('scheduled','in_progress','missed') THEN
    RAISE EXCEPTION 'Only scheduled or missed visits can be rescheduled';
  END IF;
  IF _new_date = _old THEN RETURN; END IF;

  IF _tech IS NOT NULL THEN
    SELECT o.work_days INTO _work FROM public.organizations o WHERE o.id = _org;
    _keep := (_work IS NULL OR EXTRACT(dow FROM _new_date)::integer = ANY(_work))
             AND EXISTS (SELECT 1 FROM public.staff s
                          WHERE s.id = _tech AND s.organization_id = _org
                            AND s.active AND s.is_field_tech)
             AND NOT public.is_staff_off(_tech, _new_date);
  END IF;

  UPDATE public.visits
     SET scheduled_on = _new_date,
         status = 'scheduled',
         rescheduled_from = COALESCE(rescheduled_from, _old),
         weather_flagged = COALESCE(_note IS NOT NULL, false) OR weather_flagged,
         weather_note = COALESCE(_note, weather_note),
         assigned_staff_id = CASE WHEN _keep THEN _tech ELSE NULL END,
         sequence = NULL,
         eta_start = NULL,
         eta_end = NULL,
         travel_km = NULL,
         travel_min = NULL,
         window_violated = false,
         updated_at = now()
   WHERE id = _visit_id;

  IF _tech IS NOT NULL THEN
    PERFORM public.recompute_lane_etas(_org, _tech, _old);
    IF _keep THEN
      PERFORM public.recompute_lane_etas(_org, _tech, _new_date);
    END IF;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.reschedule_visit(uuid, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reschedule_visit(uuid, date, text) TO authenticated, service_role;

DO $check$
BEGIN
  IF position('assigned_staff_id = NULL' IN (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid = 'public.reschedule_visit(uuid, date, text)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'reschedule_visit still drops the technician on every move';
  END IF;
END
$check$;
