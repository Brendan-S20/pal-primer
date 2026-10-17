-- A dragged stop keeps the right arrival time (#430, QA row 15).
--
-- Dragging a visit to another technician, or reordering a lane on the
-- Schedule board, called reassign_visit and reorder_route. Neither touched
-- eta_start, eta_end, travel_km, travel_min or window_violated, so every stop
-- kept the time the last auto-routing run gave it, in the old order, on the
-- old technician's route. The customer's "on my way" text and the live
-- tracking page both read eta_start (on-my-way.server.ts, live-tracking.ts),
-- so a stop moved from tenth to first still told its customer "around 3:40".
--
-- This adds one helper and calls it at the end of both functions:
--
--   recompute_lane_etas(org, staff, day)
--       Replays the clock apply_route_plan uses (20261010200000) over ONE
--       technician's scheduled stops on one day, in the order the lane
--       already has (sequence, then the old ETA, then id). Same start point
--       (staff_start_point), same legs (drive_minutes, road_km, rounded to a
--       whole minute), same time on site (stop_service_min), same windows
--       (the subscription's, else the property's; honoured unless the
--       organization set route_windows to 'ignore'), stops with no location
--       last. It does not re-order anything: the dispatcher's order is the
--       point of a drag.
--
--       One difference, on purpose: on the organization's TODAY, once the
--       workday has started, the clock starts at now (or at the end of a stop
--       still in progress) from the last stop the technician finished, rather
--       than at the workday start from home. A drag at 11:00 that replayed
--       from 08:00 would write arrival times that have already passed, and
--       etaPhrase drops a passed window, so the customer would be told
--       nothing at all.
--
--       Stops with no sequence (a visit just handed over by reassign_visit)
--       are numbered after the lane's last one, so the board and the clock
--       agree on where they are.
--
--   reassign_visit   recomputes the lane the visit left and the lane it
--                    joined. A visit taken off everybody (unassigned) loses
--                    its time: it is on no route, so it has no arrival.
--   reorder_route    recomputes the lane it ordered, and any lane a visit in
--                    the list was taken from.
--
-- Neither function's authorization changes: both still ask can_write_org,
-- and reassign_visit still asks assert_runs_routes. The helper is not
-- granted to authenticated; it is reached only through those two (and
-- reschedule_visit, 20261015131000), which have already asked.
--
-- Replays into an empty database: functions over helpers that exist by this
-- point (staff_start_point, drive_minutes, road_km, stop_service_min,
-- can_write_org, assert_runs_routes). Nothing here needs a row. The check at
-- the bottom asserts only what this file establishes.

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
  'Replays apply_route_plan''s clock over one technician''s scheduled stops on one day, in the lane''s current order, and writes eta_start, eta_end, travel and window_violated. Internal: called by reassign_visit, reorder_route and reschedule_visit after their own authorization.';

REVOKE ALL ON FUNCTION public.recompute_lane_etas(uuid, uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_lane_etas(uuid, uuid, date) TO service_role;

-- ── reassign_visit ───────────────────────────────────────────────────────
-- 20260804170000's body, plus: the times go with an unassign, and both lanes
-- are recomputed.
CREATE OR REPLACE FUNCTION public.reassign_visit(_visit_id uuid, _staff_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_org uuid; v_old uuid; v_day date;
BEGIN
  SELECT organization_id, assigned_staff_id, scheduled_on INTO v_org, v_old, v_day
    FROM public.visits WHERE id = _visit_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'visit not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), v_org) THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF _staff_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.staff WHERE id = _staff_id AND organization_id = v_org) THEN
    RAISE EXCEPTION 'staff not in org';
  END IF;
  -- Null is the unassign path and stays open (20260804170000).
  IF _staff_id IS NOT NULL THEN
    PERFORM public.assert_runs_routes(_staff_id);
  END IF;
  UPDATE public.visits
     SET assigned_staff_id = _staff_id,
         sequence = NULL,
         -- On nobody's route, a visit has no arrival time to tell anyone.
         eta_start       = CASE WHEN _staff_id IS NULL THEN NULL ELSE eta_start END,
         eta_end         = CASE WHEN _staff_id IS NULL THEN NULL ELSE eta_end END,
         travel_km       = CASE WHEN _staff_id IS NULL THEN NULL ELSE travel_km END,
         travel_min      = CASE WHEN _staff_id IS NULL THEN NULL ELSE travel_min END,
         window_violated = CASE WHEN _staff_id IS NULL THEN false ELSE window_violated END,
         updated_at = now()
   WHERE id = _visit_id;

  -- The lane it left closes up; the lane it joined takes it at the end
  -- (reorder_route puts it where it was dropped, and recomputes again).
  IF v_old IS NOT NULL AND v_old IS DISTINCT FROM _staff_id THEN
    PERFORM public.recompute_lane_etas(v_org, v_old, v_day);
  END IF;
  IF _staff_id IS NOT NULL THEN
    PERFORM public.recompute_lane_etas(v_org, _staff_id, v_day);
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.reassign_visit(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reassign_visit(uuid, uuid) TO authenticated, service_role;

-- ── reorder_route ────────────────────────────────────────────────────────
-- 20260702102436's body, plus the recompute.
CREATE OR REPLACE FUNCTION public.reorder_route(_staff_id uuid, _day date, _ordered_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_org uuid; v_id uuid; v_seq integer := 1; v_updated integer := 0;
        v_prev uuid[]; v_s uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.staff WHERE id = _staff_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'staff not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), v_org) THEN RAISE EXCEPTION 'forbidden'; END IF;
  -- Lanes a listed visit is taken from, so they close up too.
  v_prev := ARRAY(
    SELECT DISTINCT v.assigned_staff_id FROM public.visits v
     WHERE v.id = ANY(_ordered_ids) AND v.organization_id = v_org AND v.scheduled_on = _day
       AND v.assigned_staff_id IS NOT NULL AND v.assigned_staff_id <> _staff_id);
  FOREACH v_id IN ARRAY _ordered_ids LOOP
    UPDATE public.visits
       SET assigned_staff_id = _staff_id, sequence = v_seq, updated_at = now()
     WHERE id = v_id AND organization_id = v_org AND scheduled_on = _day;
    IF FOUND THEN v_updated := v_updated + 1; END IF;
    v_seq := v_seq + 1;
  END LOOP;
  PERFORM public.recompute_lane_etas(v_org, _staff_id, _day);
  FOREACH v_s IN ARRAY v_prev LOOP
    PERFORM public.recompute_lane_etas(v_org, v_s, _day);
  END LOOP;
  RETURN v_updated;
END;
$function$;

REVOKE ALL ON FUNCTION public.reorder_route(uuid, date, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reorder_route(uuid, date, uuid[]) TO authenticated, service_role;

-- ── What this file establishes ──────────────────────────────────────────
DO $check$
BEGIN
  IF has_function_privilege('authenticated', 'public.recompute_lane_etas(uuid, uuid, date)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.recompute_lane_etas(uuid, uuid, date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'recompute_lane_etas must not be callable by the API roles';
  END IF;
  IF position('recompute_lane_etas' IN (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid = 'public.reassign_visit(uuid, uuid)'::regprocedure)) = 0
     OR position('recompute_lane_etas' IN (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid = 'public.reorder_route(uuid, date, uuid[])'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'reassign_visit and reorder_route must recompute the lanes they change';
  END IF;
END
$check$;
