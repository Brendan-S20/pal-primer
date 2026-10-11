-- A walk takes as long as the walk: the planner reads the service's duration.
--
-- Phase 2 of the service catalog (docs/other-trades-service-catalog.md,
-- "Routing durations"). Until now every stop took as long as its YARD:
-- properties.service_duration_min, 8 minutes when unset. That is right for a
-- cleanup and wrong for everything else -- a 60-minute walk at a house with a
-- small yard was planned as an 8-minute stop, and the next six stops were
-- promised an arrival time nobody could keep.
--
-- Now: the visit's service's default_duration_min when the service has one,
-- else the yard's, else 8. Pet waste services leave default_duration_min NULL
-- on purpose (20261009200000: "a cleanup takes as long as the YARD takes"), so
-- for every business on the platform today nothing moves.
--
-- One rule, written once per language:
--   public.stop_service_min(service_min, property_min)   (here)
--   visitServiceMinutes(service, property)               (src/lib/visit-service.ts)
-- and tests/a-visit-knows-its-service.test.tsx holds the two to the same table.
--
-- ── HOW THESE BODIES WERE PRODUCED ───────────────────────────────────────
--
-- route_day_inputs and apply_route_plan are copied verbatim from
-- 20261002090700_the-route-is-solved-outside-the-database.sql (the only
-- definitions of either) and edited in exactly seven lines: four
-- `COALESCE(p.service_duration_min, 8)` became
-- `public.stop_service_min(sv.default_duration_min, p.service_duration_min)`,
-- and each of the three queries that read them gained
-- `LEFT JOIN public.services sv ON sv.id = v.service_id`. A diff against
-- that file shows those and nothing else. Grants are restated as they were.
--
-- What is NOT changed: plan_day_across_staff, its dry run, preview_optimize
-- and plan_route. The app stopped calling them in 20261002090700; the routing
-- trials call them as the benchmark, and a benchmark that moves with the code
-- it measures is not one. P4 (appointment routing) should retire them rather
-- than teach them.
--
-- Replays into an empty database: a function, and two bodies over tables and
-- helpers that exist by this point. Nothing needs a row.

CREATE OR REPLACE FUNCTION public.stop_service_min(_service_min integer, _property_min integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(_service_min, _property_min, 8);
$function$;

COMMENT ON FUNCTION public.stop_service_min(integer, integer) IS
  'Minutes on site for a stop: the service''s default_duration_min, else the property''s service_duration_min, else 8. Mirrored by visitServiceMinutes in src/lib/visit-service.ts. Migration 20261009230100.';

REVOKE ALL ON FUNCTION public.stop_service_min(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stop_service_min(integer, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.route_day_inputs(
  _org_id uuid, _staff_ids uuid[], _day date, _reassign boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
-- Not STABLE: it fills a temp table of points, which only a volatile
-- function may write. It changes nothing that outlives the transaction.
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _eligible uuid[];
  _org jsonb;
  _techs jsonb;
  _visits jsonb;
  _dumps jsonb;
  _centroid jsonb;
  _points jsonb;
  _legs jsonb;
BEGIN
  IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized to plan routes for this organization';
  END IF;
  IF _staff_ids IS NULL OR COALESCE(array_length(_staff_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'Select at least one technician to route';
  END IF;

  -- The refusal plan_day_across_staff makes, word for word, so a day nobody
  -- can run is reported the same way it always was.
  _eligible := public.routable_staff(_org_id, _staff_ids, _day);
  IF COALESCE(array_length(_eligible, 1), 0) = 0 THEN
    RAISE EXCEPTION 'None of the selected people can be routed on %: check "Runs routes" and time off', _day;
  END IF;

  SELECT jsonb_build_object(
           'timezone', COALESCE(o.timezone, 'America/Chicago'),
           'workday_start', to_char(COALESCE(o.workday_start, TIME '08:00'), 'HH24:MI'),
           'workday_end', to_char(COALESCE(o.workday_end, TIME '17:00'), 'HH24:MI'),
           'park_walk_min', COALESCE(o.park_walk_min, 2),
           'road_factor', COALESCE(o.measured_road_factor, o.road_factor, 1.35),
           'speed_kmh', COALESCE(o.measured_speed_kmh,
                                 public.effective_speed_kmh(o.area_type, o.traffic_profile)),
           'measured_legs', o.measured_legs,
           'max_drive_minutes', COALESCE(o.max_drive_minutes, 240),
           'route_windows', o.route_windows,
           'latitude', o.latitude,
           'longitude', o.longitude)
    INTO _org
    FROM public.organizations o WHERE o.id = _org_id;

  -- The stops in play: plan_day_across_staff_dryrun's set. With _reassign,
  -- anything unassigned or already on a routable selected person; without
  -- it, the same set, but what is already assigned stays where it is.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', v.id,
           'lat', p.latitude,
           'lon', p.longitude,
           'service_min', public.stop_service_min(sv.default_duration_min, p.service_duration_min),
           'earliest', to_char(CASE WHEN s.earliest_time IS NOT NULL OR s.latest_time IS NOT NULL
                                    THEN s.earliest_time ELSE p.earliest_service_time END, 'HH24:MI'),
           'latest', to_char(CASE WHEN s.earliest_time IS NOT NULL OR s.latest_time IS NOT NULL
                                  THEN s.latest_time ELSE p.latest_service_time END, 'HH24:MI'),
           'pref', COALESCE(s.preferred_time_of_day, 'any'),
           'assigned_staff_id', v.assigned_staff_id,
           'fixed', (NOT COALESCE(_reassign, false) AND v.assigned_staff_id IS NOT NULL))
           ORDER BY v.id), '[]'::jsonb)
    INTO _visits
    FROM public.visits v
    LEFT JOIN public.properties p ON p.id = v.property_id
    LEFT JOIN public.subscriptions s ON s.id = v.subscription_id
    LEFT JOIN public.services sv ON sv.id = v.service_id
   WHERE v.organization_id = _org_id
     AND v.scheduled_on = _day
     AND v.status = 'scheduled'
     AND (v.assigned_staff_id IS NULL OR v.assigned_staff_id = ANY(_eligible));

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', e.s,
           'capacity', COALESCE(st.daily_capacity_minutes, 480),
           'start_lat', st.start_latitude,
           'start_lon', st.start_longitude,
           'end_lat', ep.lat,
           'end_lon', ep.lon,
           'current_min', c.minutes,
           'current_stops', c.stops,
           'current_sequenced', c.sequenced)
           ORDER BY e.s), '[]'::jsonb)
    INTO _techs
    FROM unnest(_eligible) AS e(s)
    JOIN public.staff st ON st.id = e.s
    LEFT JOIN LATERAL (SELECT x.lat, x.lon FROM public.staff_end_point(_org_id, e.s) x LIMIT 1) ep ON true
    LEFT JOIN LATERAL public.route_cost_current(_org_id, e.s, _day) c ON true;

  -- staff_start_point's third tier: nearest disposal site to the work.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('lat', f.latitude, 'lon', f.longitude)
                            ORDER BY f.id), '[]'::jsonb)
    INTO _dumps
    FROM public.waste_disposal_facilities f
   WHERE f.organization_id = _org_id
     AND COALESCE(f.active, true)
     AND f.latitude IS NOT NULL AND f.longitude IS NOT NULL;

  -- And the fallback centre it measures from: the whole day, as it does.
  SELECT CASE WHEN count(*) = 0 THEN NULL
              ELSE jsonb_build_object('lat', avg(p.latitude), 'lon', avg(p.longitude)) END
    INTO _centroid
    FROM public.visits v JOIN public.properties p ON p.id = v.property_id
   WHERE v.organization_id = _org_id AND v.scheduled_on = _day
     AND v.status = 'scheduled' AND p.latitude IS NOT NULL;

  -- Every point the solver may drive between, rounded the way road_legs
  -- stores them, and every measured leg among them that drive_minutes would
  -- still use (90 days). Legs nobody measured are priced in TypeScript from
  -- the profile above, by drive_minutes' own arithmetic.
  CREATE TEMP TABLE IF NOT EXISTS _rdi_pts (i int, lat numeric, lon numeric) ON COMMIT DROP;
  DELETE FROM _rdi_pts WHERE true;
  INSERT INTO _rdi_pts (i, lat, lon)
  SELECT (row_number() OVER (ORDER BY q.lat, q.lon) - 1)::int, q.lat, q.lon
    FROM (
      SELECT DISTINCT round(x.lat::numeric, 5) AS lat, round(x.lon::numeric, 5) AS lon
        FROM (
          SELECT (v->>'lat')::float8 AS lat, (v->>'lon')::float8 AS lon FROM jsonb_array_elements(_visits) v
          UNION ALL
          SELECT (t->>'start_lat')::float8, (t->>'start_lon')::float8 FROM jsonb_array_elements(_techs) t
          UNION ALL
          SELECT (t->>'end_lat')::float8, (t->>'end_lon')::float8 FROM jsonb_array_elements(_techs) t
          UNION ALL
          SELECT (d->>'lat')::float8, (d->>'lon')::float8 FROM jsonb_array_elements(_dumps) d
          UNION ALL
          SELECT (_org->>'latitude')::float8, (_org->>'longitude')::float8
        ) x
       WHERE x.lat IS NOT NULL AND x.lon IS NOT NULL
    ) q;

  SELECT COALESCE(jsonb_agg(jsonb_build_array(pt.lat, pt.lon) ORDER BY pt.i), '[]'::jsonb)
    INTO _points FROM _rdi_pts pt;

  SELECT COALESCE(jsonb_agg(jsonb_build_array(a.i, b.i, rl.seconds) ORDER BY a.i, b.i), '[]'::jsonb)
    INTO _legs
    FROM public.road_legs rl
    JOIN _rdi_pts a ON a.lat = rl.from_lat AND a.lon = rl.from_lon
    JOIN _rdi_pts b ON b.lat = rl.to_lat AND b.lon = rl.to_lon
   WHERE rl.organization_id = _org_id
     AND rl.fetched_at > now() - interval '90 days';

  RETURN jsonb_build_object(
    'org', _org,
    'techs', _techs,
    'visits', _visits,
    'dumps', _dumps,
    'day_centroid', _centroid,
    'points', _points,
    'legs', _legs);
END;
$function$;

REVOKE ALL ON FUNCTION public.route_day_inputs(uuid, uuid[], date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.route_day_inputs(uuid, uuid[], date, boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apply_route_plan(
  _org_id uuid, _staff_ids uuid[], _day date, _reassign boolean,
  _routes jsonb, _honour_windows boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _eligible uuid[];
  _tz text; _workday_start time;
  _day_start_ts timestamptz;
  _s uuid; _vids uuid[];
  _start_lat double precision; _start_lon double precision;
  _cur_lat double precision; _cur_lon double precision;
  _clock timestamptz;
  _r record;
  _seq int;
  _drive numeric; _tkm numeric;
  _es timestamptz; _ee timestamptz;
  _earliest_ts timestamptz; _latest_ts timestamptz;
  _bad text;
  _summary jsonb;
  _misses jsonb;
BEGIN
  IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized to plan routes for this organization';
  END IF;
  IF _staff_ids IS NULL OR COALESCE(array_length(_staff_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'Select at least one technician to route';
  END IF;
  _eligible := public.routable_staff(_org_id, _staff_ids, _day);
  IF COALESCE(array_length(_eligible, 1), 0) = 0 THEN
    RAISE EXCEPTION 'None of the selected people can be routed on %: check "Runs routes" and time off', _day;
  END IF;
  IF _routes IS NULL OR jsonb_typeof(_routes) <> 'array' THEN
    RAISE EXCEPTION 'A plan is a list of routes';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _arp_in (sid uuid, vid uuid, ord int) ON COMMIT DROP;
  DELETE FROM _arp_in WHERE true;
  INSERT INTO _arp_in (sid, vid, ord)
  SELECT (r->>'staff_id')::uuid, x.vid::uuid, x.ord::int
    FROM jsonb_array_elements(_routes) r
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(r->'visit_ids', '[]'::jsonb))
         WITH ORDINALITY AS x(vid, ord);

  -- Only people who can run today.
  SELECT string_agg(DISTINCT a.sid::text, ', ') INTO _bad
    FROM _arp_in a WHERE NOT (a.sid = ANY(_eligible));
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'The plan routes someone who cannot be routed on %: %', _day, _bad;
  END IF;

  -- Each stop once.
  IF EXISTS (SELECT 1 FROM _arp_in GROUP BY vid HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'The plan visits a stop twice';
  END IF;

  -- Exactly the stops in play, as route_day_inputs read them. Anything else
  -- means the day changed between the read and this write (a visit added,
  -- cancelled, reassigned by hand), and a plan for a different day is not
  -- written over this one.
  IF EXISTS (
       SELECT 1 FROM public.visits v
        WHERE v.organization_id = _org_id AND v.scheduled_on = _day
          AND v.status = 'scheduled'
          AND (v.assigned_staff_id IS NULL OR v.assigned_staff_id = ANY(_eligible))
          AND NOT EXISTS (SELECT 1 FROM _arp_in a WHERE a.vid = v.id))
     OR EXISTS (
       SELECT 1 FROM _arp_in a
        WHERE NOT EXISTS (
          SELECT 1 FROM public.visits v
           WHERE v.id = a.vid AND v.organization_id = _org_id AND v.scheduled_on = _day
             AND v.status = 'scheduled'
             AND (v.assigned_staff_id IS NULL OR v.assigned_staff_id = ANY(_eligible)))) THEN
    RAISE EXCEPTION 'The day changed while it was being planned. Run auto-routing again.';
  END IF;

  -- Without reassign, what was already somebody's stays theirs.
  IF NOT COALESCE(_reassign, false) AND EXISTS (
       SELECT 1 FROM _arp_in a JOIN public.visits v ON v.id = a.vid
        WHERE v.assigned_staff_id IS NOT NULL AND v.assigned_staff_id <> a.sid) THEN
    RAISE EXCEPTION 'The plan moves a stop between technicians without permission to reassign';
  END IF;

  SELECT COALESCE(o.timezone, 'America/Chicago'), o.workday_start
    INTO _tz, _workday_start
    FROM public.organizations o WHERE o.id = _org_id;
  _day_start_ts := (_day + COALESCE(_workday_start, TIME '08:00')) AT TIME ZONE _tz;

  CREATE TEMP TABLE IF NOT EXISTS _arp_out (
    sid uuid, vid uuid, s_no int, e_start timestamptz, e_end timestamptz,
    t_km numeric, t_min numeric, w_viol boolean, early boolean,
    earliest_ts timestamptz, latest_ts timestamptz
  ) ON COMMIT DROP;
  DELETE FROM _arp_out WHERE true;

  -- The clock, replayed as plan_visits' final pass replays it: from the
  -- start staff_start_point gives for THIS set of stops, each leg by
  -- drive_minutes rounded to a whole minute, the service duration on site,
  -- and stops with no location last (a NULL leg costs nothing, so anywhere
  -- else they hide the drive around them).
  FOREACH _s IN ARRAY _eligible LOOP
    _vids := ARRAY(SELECT a.vid FROM _arp_in a WHERE a.sid = _s ORDER BY a.ord);
    CONTINUE WHEN COALESCE(array_length(_vids, 1), 0) = 0;

    SELECT sp.lat, sp.lon INTO _start_lat, _start_lon
      FROM public.staff_start_point(_org_id, _s, _day, _vids) sp;
    _cur_lat := _start_lat; _cur_lon := _start_lon;
    _clock := _day_start_ts;
    _seq := 0;

    FOR _r IN
      SELECT a.vid, p.latitude AS lat, p.longitude AS lon,
             public.stop_service_min(sv.default_duration_min, p.service_duration_min) AS svc,
             CASE WHEN s.earliest_time IS NOT NULL OR s.latest_time IS NOT NULL
                  THEN s.earliest_time ELSE p.earliest_service_time END AS earliest,
             CASE WHEN s.earliest_time IS NOT NULL OR s.latest_time IS NOT NULL
                  THEN s.latest_time ELSE p.latest_service_time END AS latest
        FROM _arp_in a
        JOIN public.visits v ON v.id = a.vid
        LEFT JOIN public.properties p ON p.id = v.property_id
        LEFT JOIN public.subscriptions s ON s.id = v.subscription_id
        LEFT JOIN public.services sv ON sv.id = v.service_id
       WHERE a.sid = _s
       ORDER BY (p.latitude IS NULL OR p.longitude IS NULL), a.ord
    LOOP
      _drive := COALESCE(public.drive_minutes(_org_id, _cur_lat, _cur_lon, _r.lat, _r.lon), 0);
      _tkm := COALESCE(public.road_km(_org_id, _cur_lat, _cur_lon, _r.lat, _r.lon), 0);
      _es := _clock + make_interval(mins => _drive::int);
      _earliest_ts := CASE WHEN _r.earliest IS NOT NULL THEN (_day + _r.earliest) AT TIME ZONE _tz END;
      _latest_ts   := CASE WHEN _r.latest   IS NOT NULL THEN (_day + _r.latest)   AT TIME ZONE _tz END;
      IF COALESCE(_honour_windows, true) AND _earliest_ts IS NOT NULL AND _es < _earliest_ts THEN
        _es := _earliest_ts;
      END IF;
      _ee := _es + make_interval(mins => _r.svc);
      _seq := _seq + 1;

      INSERT INTO _arp_out VALUES (
        _s, _r.vid, _seq, _es, _ee, _tkm, _drive,
        (_latest_ts IS NOT NULL AND _es > _latest_ts),
        (_earliest_ts IS NOT NULL AND _es < _earliest_ts),
        _earliest_ts, _latest_ts);

      _clock := _ee;
      IF _r.lat IS NOT NULL AND _r.lon IS NOT NULL THEN
        _cur_lat := _r.lat; _cur_lon := _r.lon;
      END IF;
    END LOOP;
  END LOOP;

  -- The only statement here that changes a customer's day, column for column
  -- what plan_day_across_staff writes.
  UPDATE public.visits v
     SET assigned_staff_id = w.sid,
         sequence          = w.s_no,
         eta_start         = w.e_start,
         eta_end           = w.e_end,
         travel_km         = LEAST(w.t_km, 9999.99),
         travel_min        = LEAST(w.t_min, 99999.9),
         window_violated   = w.w_viol,
         updated_at        = now()
    FROM _arp_out w
   WHERE v.id = w.vid;

  -- The per-person summary plan_day_across_staff returns, plus the count of
  -- late stops each person's day now has.
  WITH assigned AS (
    SELECT e.s AS sid,
           ARRAY(SELECT o.vid FROM _arp_out o WHERE o.sid = e.s ORDER BY o.s_no) AS vids,
           (SELECT o.vid FROM _arp_out o WHERE o.sid = e.s ORDER BY o.s_no DESC LIMIT 1) AS last_vid
      FROM unnest(_eligible) AS e(s)
  ),
  closed AS (
    SELECT a.sid, public.closing_drive_min(_org_id, a.sid, a.vids, a.last_vid) AS close_min
      FROM assigned a
  ),
  per AS (
    SELECT e.s AS sid,
           count(o.vid)::int AS stops,
           round(COALESCE(sum(public.stop_service_min(sv.default_duration_min, p.service_duration_min)), 0), 1) AS service_min,
           round(COALESCE(sum(LEAST(o.t_min, 99999.9)), 0) + COALESCE(max(cl.close_min), 0), 1) AS travel_min,
           round(COALESCE(sum(public.stop_service_min(sv.default_duration_min, p.service_duration_min)), 0)
                 + COALESCE(sum(LEAST(o.t_min, 99999.9)), 0)
                 + COALESCE(max(cl.close_min), 0), 1) AS total_min,
           count(*) FILTER (WHERE o.w_viol)::int AS late
      FROM unnest(_eligible) AS e(s)
      LEFT JOIN _arp_out o ON o.sid = e.s
      LEFT JOIN public.visits v ON v.id = o.vid
      LEFT JOIN public.properties p ON p.id = v.property_id
      LEFT JOIN public.services sv ON sv.id = v.service_id
      LEFT JOIN closed cl ON cl.sid = e.s
     GROUP BY e.s
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'staff_id', per.sid, 'stops', per.stops, 'service_min', per.service_min,
           'travel_min', per.travel_min, 'total_min', per.total_min, 'late', per.late)
           ORDER BY per.sid), '[]'::jsonb)
    INTO _summary FROM per;

  -- Every window the plan misses, either way, named. With windows honoured
  -- that is only the impossible ones; with them set aside it is the price of
  -- the shorter drive, and the dispatcher sees it before the customer does.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'visit_id', o.vid,
           'staff_id', o.sid,
           'client', c.display_name,
           'kind', CASE WHEN o.w_viol THEN 'late' ELSE 'early' END,
           'eta_start', o.e_start,
           'earliest', o.earliest_ts,
           'latest', o.latest_ts)
           ORDER BY o.e_start, o.vid), '[]'::jsonb)
    INTO _misses
    FROM _arp_out o
    JOIN public.visits v ON v.id = o.vid
    LEFT JOIN public.clients c ON c.id = v.client_id
   WHERE o.w_viol OR o.early;

  RETURN jsonb_build_object('staff', _summary, 'misses', _misses);
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_route_plan(uuid, uuid[], date, boolean, jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_route_plan(uuid, uuid[], date, boolean, jsonb, boolean) TO authenticated, service_role;


-- ── What this file establishes, checked from any starting state ───────────
DO $check$
DECLARE
  _fn text;
  _src text;
BEGIN
  IF public.stop_service_min(60, 12) <> 60
     OR public.stop_service_min(NULL, 12) <> 12
     OR public.stop_service_min(NULL, NULL) <> 8 THEN
    RAISE EXCEPTION 'stop_service_min does not prefer the service, then the yard, then 8';
  END IF;

  FOREACH _fn IN ARRAY ARRAY[
    'public.route_day_inputs(uuid, uuid[], date, boolean)',
    'public.apply_route_plan(uuid, uuid[], date, boolean, jsonb, boolean)'] LOOP
    IF has_function_privilege('anon', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% is executable with the publishable key', _fn;
    END IF;
    IF NOT has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% is not callable by a signed-in dispatcher', _fn;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(_fn)) THEN
      RAISE EXCEPTION '% must run as its owner: it reads drive_minutes and staff_start_point', _fn;
    END IF;
    _src := (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(_fn));
    IF strpos(_src, 'can_write_org(auth.uid(), _org_id)') = 0 THEN
      RAISE EXCEPTION '% must refuse a caller who cannot write the organization', _fn;
    END IF;
    -- Every duration it reads goes through the one rule.
    IF strpos(_src, 'p.service_duration_min, 8)') > 0
       OR strpos(_src, 'public.stop_service_min(sv.default_duration_min, p.service_duration_min)') = 0 THEN
      RAISE EXCEPTION '% still reads a stop''s duration from the yard alone', _fn;
    END IF;
  END LOOP;
END
$check$;
