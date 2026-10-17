-- Give the ETA helper the same checked entry point as the routing RPCs.
-- Preserve its clock from 20261015130000 and check the caller before any write.

CREATE OR REPLACE FUNCTION public.recompute_lane_etas(_org_id uuid, _staff_id uuid, _day date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _tz text; _workday_start time; _windows text;
  _honour boolean;
  _vids uuid[];
  _clock timestamptz;
  _cur_lat double precision; _cur_lon double precision;
  _here record;
  _r record;
  _drive numeric; _tkm numeric;
  _es timestamptz; _ee timestamptz;
  _earliest_ts timestamptz; _latest_ts timestamptz;
  _next_seq integer;
  _n integer := 0;
BEGIN
  IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized to plan routes for this organization' USING ERRCODE = '42501';
  END IF;

  IF _org_id IS NULL OR _staff_id IS NULL OR _day IS NULL THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(o.timezone, 'America/Chicago'), o.workday_start, o.route_windows
    INTO _tz, _workday_start, _windows
    FROM public.organizations o WHERE o.id = _org_id;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  _honour := COALESCE(_windows, 'honour') <> 'ignore';

  -- The lane's scheduled stops, in the order the lane has now.
  _vids := ARRAY(
    SELECT v.id FROM public.visits v
     WHERE v.organization_id = _org_id
       AND v.assigned_staff_id = _staff_id
       AND v.scheduled_on = _day
       AND v.status = 'scheduled'
     ORDER BY v.sequence NULLS LAST, v.eta_start NULLS LAST, v.id);
  IF COALESCE(array_length(_vids, 1), 0) = 0 THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(max(v.sequence), 0) + 1 INTO _next_seq
    FROM public.visits v
   WHERE v.organization_id = _org_id
     AND v.assigned_staff_id = _staff_id
     AND v.scheduled_on = _day;

  _clock := (_day + COALESCE(_workday_start, TIME '08:00')) AT TIME ZONE _tz;
  SELECT sp.lat, sp.lon INTO _cur_lat, _cur_lon
    FROM public.staff_start_point(_org_id, _staff_id, _day, _vids) sp;

  -- Today, after the day has started: from where the technician is, now.
  IF _day = (now() AT TIME ZONE _tz)::date AND now() > _clock THEN
    _clock := date_trunc('minute', now());
    SELECT p.latitude AS lat, p.longitude AS lon, v.status, v.started_at,
           public.stop_service_min(sv.default_duration_min, p.service_duration_min) AS svc
      INTO _here
      FROM public.visits v
      JOIN public.properties p ON p.id = v.property_id
      LEFT JOIN public.services sv ON sv.id = v.service_id
     WHERE v.organization_id = _org_id
       AND v.assigned_staff_id = _staff_id
       AND v.scheduled_on = _day
       AND v.status IN ('completed', 'in_progress')
       AND p.latitude IS NOT NULL AND p.longitude IS NOT NULL
     ORDER BY (v.status = 'in_progress') DESC, COALESCE(v.completed_at, v.started_at) DESC NULLS LAST
     LIMIT 1;
    IF FOUND THEN
      _cur_lat := _here.lat;
      _cur_lon := _here.lon;
      IF _here.status = 'in_progress' AND _here.started_at IS NOT NULL THEN
        _clock := GREATEST(_clock, _here.started_at + make_interval(mins => _here.svc));
      END IF;
    END IF;
  END IF;

  FOR _r IN
    SELECT o.vid, v.sequence AS seq, p.latitude AS lat, p.longitude AS lon,
           public.stop_service_min(sv.default_duration_min, p.service_duration_min) AS svc,
           CASE WHEN s.earliest_time IS NOT NULL OR s.latest_time IS NOT NULL
                THEN s.earliest_time ELSE p.earliest_service_time END AS earliest,
           CASE WHEN s.earliest_time IS NOT NULL OR s.latest_time IS NOT NULL
                THEN s.latest_time ELSE p.latest_service_time END AS latest
      FROM unnest(_vids) WITH ORDINALITY AS o(vid, ord)
      JOIN public.visits v ON v.id = o.vid
      LEFT JOIN public.properties p ON p.id = v.property_id
      LEFT JOIN public.subscriptions s ON s.id = v.subscription_id
      LEFT JOIN public.services sv ON sv.id = v.service_id
     ORDER BY (p.latitude IS NULL OR p.longitude IS NULL), o.ord
  LOOP
    _drive := COALESCE(public.drive_minutes(_org_id, _cur_lat, _cur_lon, _r.lat, _r.lon), 0);
    _tkm := COALESCE(public.road_km(_org_id, _cur_lat, _cur_lon, _r.lat, _r.lon), 0);
    _es := _clock + make_interval(mins => _drive::int);
    _earliest_ts := CASE WHEN _r.earliest IS NOT NULL THEN (_day + _r.earliest) AT TIME ZONE _tz END;
    _latest_ts   := CASE WHEN _r.latest   IS NOT NULL THEN (_day + _r.latest)   AT TIME ZONE _tz END;
    IF _honour AND _earliest_ts IS NOT NULL AND _es < _earliest_ts THEN
      _es := _earliest_ts;
    END IF;
    _ee := _es + make_interval(mins => _r.svc);

    UPDATE public.visits
       SET eta_start       = _es,
           eta_end         = _ee,
           travel_km       = LEAST(_tkm, 9999.99),
           travel_min      = LEAST(_drive, 99999.9),
           window_violated = (_latest_ts IS NOT NULL AND _es > _latest_ts),
           sequence        = COALESCE(sequence, _next_seq),
           updated_at      = now()
     WHERE id = _r.vid;
    IF _r.seq IS NULL THEN
      _next_seq := _next_seq + 1;
    END IF;
    _n := _n + 1;

    _clock := _ee;
    IF _r.lat IS NOT NULL AND _r.lon IS NOT NULL THEN
      _cur_lat := _r.lat; _cur_lon := _r.lon;
    END IF;
  END LOOP;

  RETURN _n;
END;
$function$;

COMMENT ON FUNCTION public.recompute_lane_etas(uuid, uuid, date) IS
  'Recomputes one lane after checking can_write_org for the caller. Uses the same clock as apply_route_plan, with a current-time start for today.';

REVOKE ALL ON FUNCTION public.recompute_lane_etas(uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recompute_lane_etas(uuid, uuid, date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.reassign_visit(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reassign_visit(uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.reorder_route(uuid, date, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reorder_route(uuid, date, uuid[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.reschedule_visit(uuid, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reschedule_visit(uuid, date, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.capture_routing_run_undo(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.capture_routing_run_undo(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.seal_routing_run_undo(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seal_routing_run_undo(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.routing_run_undo_state(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.routing_run_undo_state(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.undo_routing_run(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.undo_routing_run(uuid) TO authenticated, service_role;

DO $check$
DECLARE
  _fn text;
BEGIN
  FOREACH _fn IN ARRAY ARRAY[
    'public.recompute_lane_etas(uuid, uuid, date)',
    'public.reassign_visit(uuid, uuid)',
    'public.reorder_route(uuid, date, uuid[])',
    'public.reschedule_visit(uuid, date, text)',
    'public.capture_routing_run_undo(uuid)',
    'public.seal_routing_run_undo(uuid)',
    'public.routing_run_undo_state(uuid)',
    'public.undo_routing_run(uuid)'
  ] LOOP
    IF has_function_privilege('anon', _fn, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'Unexpected routing function privileges: %', _fn;
    END IF;
  END LOOP;
END
$check$;
