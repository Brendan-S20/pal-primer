-- An end point in another state is not an end point.
--
-- ── FOUND IN PRODUCTION, ONE HOUR AFTER SHIPPING THE FEATURE ─────────────
--
-- 20260831150000 taught the solver to cost the drive from the last stop to
-- where the technician's day ends. On 2026-09-01, checking the demo org before
-- giving it a dump site, every one of its five stored end points turned out to
-- be 40.748,-73.986 or 40.676,-74.003 -- the Empire State Building and lower
-- Manhattan -- seeded when that demo data was New York based and left behind
-- when the stops and start points moved to Southfield, Michigan. 784 km from
-- where those people start their day.
--
-- Harmless for as long as the solver ignored the end point. Not harmless from
-- the moment it started costing the leg home.
--
-- ── WHY THE SIZE IS NOT THE PROBLEM, AND THE SPREAD IS ───────────────────
--
-- Measured on that day's twenty stops with the same fallback drive_minutes
-- uses when nothing is cached:
--
--                    closing leg      spread across orderings
--   NYC, as seeded    6195-6249 min           54 min
--   the dump site     15.4-21.6 min            6.2 min
--
-- A constant added to every candidate cancels out of every comparison, so
-- 6,200 minutes on its own would not change a single decision. What changes
-- decisions is the 54 minutes BETWEEN the best and worst last stop -- against a
-- real route improvement worth 2.4 minutes on that same day. The 2-opt would
-- have spent its entire pass deciding which stop sits marginally closer to
-- Manhattan, and returned a confidently wrong route with no warning anywhere.
--
-- ── THE RULE, AND WHY IT IS NOT AN ARBITRARY NUMBER ──────────────────────
--
-- If the CLOSEST stop of the day cannot reach the end point within the
-- organization's own `max_drive_minutes` -- a setting it already has, 240 by
-- default -- then no ordering of that day ends there, and the coordinate is
-- data entry rather than a destination. The closing legs are dropped and the
-- day reverts to the open path it had before the end point existed, which is
-- strictly better than a wrong one. 6,195 > 240 rejects; 15.4 < 240 accepts.
--
-- The minimum is the right statistic, not the average or the maximum. A dump
-- at one edge of a wide rural territory is legitimately far from the stops at
-- the other edge, and that day should still be planned to it. What is never
-- legitimate is an end point too far from EVERY stop.
--
-- ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────
--
-- The dispatcher does not see it. `plan_route` returns one row per visit and
-- has nowhere to put a warning, so this goes to the Postgres log via RAISE
-- WARNING and no further. That is enough to stop the route being wrecked,
-- which is the bug; surfacing it on the board is a separate change and wants
-- a channel that does not exist yet. Said here rather than left to be
-- discovered, because a guard nobody can see is a guard that gets removed by
-- somebody who thinks it never fires.
--
-- Same shape, and the same reasoning, as route-plausibility.ts: "the optimizer
-- would happily schedule a stop 1,850 km / 61 h from the technician's depot
-- with no warning".

CREATE OR REPLACE FUNCTION public.plan_route(
  _org_id uuid, _staff_id uuid, _day date, _reassign boolean DEFAULT false, _level text DEFAULT 'balanced'
) RETURNS TABLE(
  visit_id uuid, seq integer,
  eta_start timestamptz, eta_end timestamptz,
  travel_km numeric, travel_min numeric, window_violated boolean
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE
  _start_lat DOUBLE PRECISION; _start_lon DOUBLE PRECISION;
  _cur_lat DOUBLE PRECISION;   _cur_lon DOUBLE PRECISION;
  _cur_id UUID;
  _end_lat DOUBLE PRECISION; _end_lon DOUBLE PRECISION;
  _START CONSTANT UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  _END   CONSTANT UUID := 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid;
  _workday_start TIME; _workday_end TIME;
  _speed NUMERIC; _traffic TEXT; _tz TEXT; _traffic_mult NUMERIC;
  _park NUMERIC; _max_drive NUMERIC; _nearest_close NUMERIC;
  _clock TIMESTAMPTZ; _day_start_ts TIMESTAMPTZ;
  _use_penalties BOOLEAN;
  _order uuid[] := '{}';
  _rev uuid[];
  _picked uuid; _remaining INT; _v RECORD;
  _i INT; _j INT; _improved BOOLEAN; _pass INT := 0;
  _cand uuid[]; _cand_min NUMERIC; _base NUMERIC;
  _seq INT := 0;
  _tkm NUMERIC; _tmin NUMERIC; _drive NUMERIC;
  _es TIMESTAMPTZ; _ee TIMESTAMPTZ;
  _earliest_ts TIMESTAMPTZ; _latest_ts TIMESTAMPTZ;
BEGIN
  IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.staff WHERE id=_staff_id AND organization_id=_org_id) THEN
    RAISE EXCEPTION 'Staff not in organization';
  END IF;

  _level := COALESCE(NULLIF(_level, ''), 'balanced');
  IF _level NOT IN ('fast','balanced','thorough') THEN
    RAISE EXCEPTION 'Unknown optimization level: %', _level;
  END IF;
  _use_penalties := (_level <> 'fast');

  SELECT sp.lat, sp.lon INTO _start_lat, _start_lon
    FROM public.staff_start_point(_org_id, _staff_id, _day) sp;
  SELECT ep.lat, ep.lon INTO _end_lat, _end_lon
    FROM public.staff_end_point(_org_id, _staff_id) ep;
  SELECT workday_start, workday_end, avg_speed_kmh, traffic_profile, timezone,
         COALESCE(park_walk_min, 2), COALESCE(max_drive_minutes, 240)
    INTO _workday_start, _workday_end, _speed, _traffic, _tz, _park, _max_drive
    FROM public.organizations WHERE id = _org_id;

  _tz := COALESCE(_tz, 'America/Chicago');
  _park := COALESCE(_park, 2);
  _traffic_mult := CASE _traffic WHEN 'light' THEN 1.15 WHEN 'heavy' THEN 0.7 ELSE 1.0 END;
  _day_start_ts := (_day + COALESCE(_workday_start, TIME '08:00')) AT TIME ZONE _tz;
  _clock := _day_start_ts;
  _cur_lat := _start_lat; _cur_lon := _start_lon; _cur_id := _START;

  CREATE TEMP TABLE IF NOT EXISTS _plan (
    id UUID PRIMARY KEY, lat DOUBLE PRECISION, lon DOUBLE PRECISION,
    duration_min INT, earliest TIME, latest TIME, pref TEXT,
    picked BOOLEAN NOT NULL DEFAULT false
  ) ON COMMIT DROP;
  DELETE FROM _plan WHERE true;

  INSERT INTO _plan(id, lat, lon, duration_min, earliest, latest, pref)
  SELECT v.id, p.latitude, p.longitude,
         COALESCE(p.service_duration_min, 8),
         p.earliest_service_time, p.latest_service_time,
         COALESCE(s.preferred_time_of_day, 'any')
    FROM public.visits v
    LEFT JOIN public.properties p ON p.id = v.property_id
    LEFT JOIN public.subscriptions s ON s.id = v.subscription_id
   WHERE v.organization_id = _org_id
     AND v.scheduled_on = _day
     AND v.status = 'scheduled'
     AND (_reassign OR v.assigned_staff_id IS NULL OR v.assigned_staff_id = _staff_id);

  -- ── Every leg, once ───────────────────────────────────────────────────
  --
  -- Built before the construction loop because that loop reads it too. n+1
  -- origins by n destinations; for a 21-stop day that is 462 rows and 462
  -- drive_minutes() calls, against the tens of thousands the 2-opt would
  -- otherwise make on its own.
  CREATE TEMP TABLE IF NOT EXISTS _legs (
    from_id UUID NOT NULL, to_id UUID NOT NULL, minutes NUMERIC,
    PRIMARY KEY (from_id, to_id)
  ) ON COMMIT DROP;
  DELETE FROM _legs WHERE true;

  INSERT INTO _legs (from_id, to_id, minutes)
  SELECT a.id, b.id,
         COALESCE(
           public.drive_minutes(_org_id, a.lat, a.lon, b.lat, b.lon),
           (COALESCE(public.haversine_km(a.lat, a.lon, b.lat, b.lon), 5.0)
              / NULLIF(_speed, 0)) * 60.0 / _traffic_mult)
    FROM (
      SELECT p.id, p.lat, p.lon FROM _plan p
      UNION ALL
      SELECT _START, _start_lat, _start_lon
    ) a
    CROSS JOIN _plan b
   WHERE a.id <> b.id;

  -- The closing leg. Inserted only when an end point resolved, so an org with
  -- neither a technician end address nor a dump site keeps the open path it
  -- has today and route_segment_min finds nothing to add.
  IF _end_lat IS NOT NULL AND _end_lon IS NOT NULL THEN
    INSERT INTO _legs (from_id, to_id, minutes)
    SELECT p.id, _END,
           COALESCE(
             public.drive_minutes(_org_id, p.lat, p.lon, _end_lat, _end_lon),
             (COALESCE(public.haversine_km(p.lat, p.lon, _end_lat, _end_lon), 5.0)
                / NULLIF(_speed, 0)) * 60.0 / _traffic_mult)
      FROM _plan p;

    -- ── AN END POINT IN ANOTHER STATE IS NOT AN END POINT ───────────────
    --
    -- If the CLOSEST stop of the day cannot reach the end point inside the
    -- organization's own `max_drive_minutes`, no ordering of this day ends
    -- there and the coordinate is data entry, not a destination. Found in
    -- production on 2026-09-01: five technicians on the demo org carried
    -- 40.748,-73.986 -- the Empire State Building -- seeded when that data was
    -- New York based and left behind when the stops moved to Michigan, 784 km
    -- away. Inert while the solver ignored the end point, and not inert from
    -- the moment 20260831150000 started costing the leg home.
    --
    -- Measured on that day's twenty stops, with the same fallback drive_minutes
    -- uses when nothing is cached: closing legs of 6,195 to 6,249 minutes. The
    -- absolute size is not the damage -- a constant would cancel out of every
    -- comparison. The SPREAD is: 54 minutes between the best and worst last
    -- stop, against a real route improvement worth 2.4 minutes on the same day.
    -- The 2-opt would have spent the whole pass choosing which stop sits
    -- marginally closer to Manhattan, and produced a confidently wrong route.
    --
    -- Dropping the rows restores the open path, which is what this day had
    -- before the end point existed and is strictly better than a wrong one.
    -- The same shape as route-plausibility.ts, which exists because "the
    -- optimizer would happily schedule a stop 1,850 km from the technician's
    -- depot with no warning".
    SELECT min(lg.minutes) INTO _nearest_close FROM _legs lg WHERE lg.to_id = _END;
    IF _nearest_close IS NOT NULL AND _nearest_close > _max_drive THEN
      DELETE FROM _legs WHERE to_id = _END;
      RAISE WARNING 'plan_route: end point for staff % is % minutes from the nearest stop of %, beyond max_drive_minutes of %; planning an open path instead',
        _staff_id, round(_nearest_close), _day, _max_drive;
    END IF;
  END IF;

  LOOP
    SELECT COUNT(*) INTO _remaining FROM _plan WHERE NOT picked;
    EXIT WHEN _remaining = 0;

    WITH cand AS (
      SELECT o.id, o.lat, o.lon, o.earliest, o.latest, o.pref,
             COALESCE(
               (SELECT lg.minutes FROM _legs lg WHERE lg.from_id = _cur_id AND lg.to_id = o.id),
               (COALESCE(public.haversine_km(_cur_lat,_cur_lon,o.lat,o.lon), 5.0)
                  / NULLIF(_speed,0)) * 60.0 / _traffic_mult) AS tmin
        FROM _plan o WHERE NOT o.picked
    ),
    scored AS (
      SELECT c.*,
             -- Projected on the SAME minutes this row is about to be ranked
             -- by. It used to project on (km / avg_speed_kmh), a journey the
             -- planner had already replaced with the measured one.
             CASE WHEN _use_penalties AND c.latest IS NOT NULL
                  AND ((_clock + make_interval(mins => COALESCE(c.tmin,0)::int)) AT TIME ZONE _tz)::time > c.latest
                  THEN 30 ELSE 0 END AS window_pen,
             CASE WHEN NOT _use_penalties THEN 0
                  ELSE CASE c.pref
                    WHEN 'morning'   THEN CASE WHEN EXTRACT(HOUR FROM _clock AT TIME ZONE _tz) < 12  THEN 0 ELSE 15 END
                    WHEN 'afternoon' THEN CASE WHEN EXTRACT(HOUR FROM _clock AT TIME ZONE _tz) >= 12 THEN 0 ELSE 15 END
                    ELSE 0 END
             END AS pref_pen
        FROM cand c
    )
    SELECT id INTO _picked FROM scored ORDER BY tmin + window_pen + pref_pen ASC LIMIT 1;

    SELECT * INTO _v FROM _plan WHERE id = _picked;
    UPDATE _plan SET picked = true WHERE id = _picked;
    _order := _order || _picked;
    _clock := _clock
            + make_interval(mins => COALESCE(
                (SELECT lg.minutes FROM _legs lg WHERE lg.from_id = _cur_id AND lg.to_id = _picked), 0)::int)
            + make_interval(mins => COALESCE(_v.duration_min,8));
    _cur_id := _picked;
    IF _v.lat IS NOT NULL AND _v.lon IS NOT NULL THEN
      _cur_lat := _v.lat; _cur_lon := _v.lon;
    END IF;
  END LOOP;

  -- ── The improvement pass, on the quantity the van actually spends ──────
  --
  -- route_segment_min, not route_segment_km. `_j` runs to array_length, not
  -- array_length - 1, so a segment ending at the last stop is reachable: this
  -- is an open path, so reversing the tail changes one edge and is an ordinary
  -- move that was simply never offered.
  IF _level = 'thorough' AND COALESCE(array_length(_order,1),0) > 3 THEN
    _base := public.route_segment_min(_order);
    LOOP
      _pass := _pass + 1;
      EXIT WHEN _pass > 8;
      _improved := false;
      FOR _i IN 1 .. array_length(_order,1) - 1 LOOP
        FOR _j IN _i + 1 .. array_length(_order,1) LOOP
          SELECT array_agg(x ORDER BY ord DESC) INTO _rev
            FROM unnest(_order[_i:_j]) WITH ORDINALITY AS t(x, ord);
          _cand := _order[1:_i-1] || _rev || _order[_j+1:array_length(_order,1)];
          -- Full re-evaluation, not the usual O(1) two-edge delta. Road legs
          -- are DIRECTED -- A->B and B->A are separate cache rows precisely
          -- because one-way systems make them different journeys -- so
          -- reversing a segment re-costs every edge inside it, not just the
          -- two at its ends. `_base` is carried instead of recomputed, which
          -- is the half of the work that can honestly be saved.
          _cand_min := public.route_segment_min(_cand);
          IF _cand_min < _base THEN
            _order := _cand;
            _base := _cand_min;
            _improved := true;
          END IF;
        END LOOP;
      END LOOP;
      EXIT WHEN NOT _improved;
    END LOOP;
  END IF;

  _clock := _day_start_ts;
  _cur_lat := _start_lat; _cur_lon := _start_lon; _cur_id := _START;
  FOREACH _picked IN ARRAY _order LOOP
    SELECT * INTO _v FROM _plan WHERE id = _picked;

    -- Distance and time from the same cached leg, so the pair the route screen
    -- prints side by side describes one journey. `_drive` still carries
    -- park_walk_min because the CLOCK below must spend it; `_tmin`, the number
    -- reported as travel, does not, because parking is not distance covered
    -- and dividing one by the other is what produced 1.8 km/h.
    _tkm   := COALESCE(public.road_km(_org_id, _cur_lat, _cur_lon, _v.lat, _v.lon), 0);
    _drive := COALESCE(
                (SELECT lg.minutes FROM _legs lg WHERE lg.from_id = _cur_id AND lg.to_id = _picked),
                0);
    _tmin  := GREATEST(_drive - _park, 0);

    _es := _clock + make_interval(mins => COALESCE(_drive,0)::int);
    _ee := _es + make_interval(mins => COALESCE(_v.duration_min,8));
    _earliest_ts := CASE WHEN _v.earliest IS NOT NULL THEN (_day + _v.earliest) AT TIME ZONE _tz END;
    _latest_ts   := CASE WHEN _v.latest   IS NOT NULL THEN (_day + _v.latest)   AT TIME ZONE _tz END;
    IF _earliest_ts IS NOT NULL AND _es < _earliest_ts THEN
      _es := _earliest_ts;
      _ee := _es + make_interval(mins => COALESCE(_v.duration_min,8));
    END IF;

    _seq := _seq + 1;
    visit_id := _picked; seq := _seq;
    eta_start := _es; eta_end := _ee;
    travel_km := _tkm; travel_min := _tmin;
    window_violated := (_latest_ts IS NOT NULL AND _es > _latest_ts);
    RETURN NEXT;

    _clock := _ee;
    _cur_id := _picked;
    IF _v.lat IS NOT NULL AND _v.lon IS NOT NULL THEN
      _cur_lat := _v.lat; _cur_lon := _v.lon;
    END IF;
  END LOOP;
END;
$fn$;

-- ── plan_visits, respliced ────────────────────────────────────────────────
--
-- Same three substitutions as 20260815190000 and 20260831130000, for the same
-- reason: plan_visits is never written out by hand, so that Apply and Preview
-- cannot drift onto different objectives. An end point one of them honours and
-- the other does not is precisely that drift.

DO $splice$
DECLARE _def text; _new text;
BEGIN
  _def := pg_get_functiondef('public.plan_route(uuid,uuid,date,boolean,text)'::regprocedure);

  _new := replace(
    _def,
    'public.plan_route(_org_id uuid, _staff_id uuid, _day date, _reassign boolean DEFAULT false, _level text DEFAULT ''balanced''::text)',
    'public.plan_visits(_org_id uuid, _staff_id uuid, _day date, _visit_ids uuid[], _level text DEFAULT ''balanced''::text)');
  IF _new = _def THEN
    RAISE EXCEPTION 'plan_route does not carry the signature this migration expects';
  END IF;
  _def := _new;

  _new := replace(
    _def,
    'AND (_reassign OR v.assigned_staff_id IS NULL OR v.assigned_staff_id = _staff_id);',
    'AND v.id = ANY(_visit_ids);');
  IF _new = _def THEN
    RAISE EXCEPTION 'plan_route does not select its candidates the way this migration expects';
  END IF;
  _def := _new;

  _new := replace(
    _def,
    'FROM public.staff_start_point(_org_id, _staff_id, _day) sp;',
    'FROM public.staff_start_point(_org_id, _staff_id, _day, _visit_ids) sp;');
  IF _new = _def THEN
    RAISE EXCEPTION 'plan_route does not resolve its start through staff_start_point';
  END IF;
  _def := _new;

  IF strpos(_def, '_reassign') > 0 THEN
    RAISE EXCEPTION 'the derived solver still mentions _reassign, which it no longer takes';
  END IF;

  EXECUTE _def;
END $splice$;

DO $grant$
BEGIN
  IF to_regprocedure('public.plan_visits(uuid,uuid,date,uuid[],text)') IS NULL THEN
    RAISE EXCEPTION 'plan_visits was not created';
  END IF;
  REVOKE ALL ON FUNCTION public.plan_visits(uuid, uuid, date, uuid[], text) FROM public, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.plan_visits(uuid, uuid, date, uuid[], text) TO service_role;
END $grant$;

REVOKE ALL ON FUNCTION public.plan_route(uuid, uuid, date, boolean, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plan_route(uuid, uuid, date, boolean, text) TO service_role;

-- Every assertion is about what THIS migration establishes, so a replay into an
-- empty database can prove all of them with no tenant and no rows. Comments are
-- stripped before matching, because the prose below names the very thing it is
-- checking for the absence of -- the fault 20260831130000 hit head-on.
DO $post$
DECLARE _n int;
BEGIN
  -- Both solvers carry the guard, or neither does. One of two is the
  -- Apply/Preview divergence the splice exists to prevent. Comments stripped
  -- first: the prose above names max_drive_minutes in order to explain it.
  SELECT count(*) INTO _n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('plan_route','plan_visits')
     AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') LIKE '%DELETE FROM _legs WHERE to_id = _END%';
  IF _n <> 2 THEN
    RAISE EXCEPTION 'expected both plan_route and plan_visits to drop an unreachable end point, found %', _n;
  END IF;

  -- And that the threshold is the organization's own setting rather than a
  -- literal somebody has to remember to keep in step.
  SELECT count(*) INTO _n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('plan_route','plan_visits')
     AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') LIKE '%max_drive_minutes%';
  IF _n <> 2 THEN
    RAISE EXCEPTION 'expected both solvers to read max_drive_minutes, found %', _n;
  END IF;
END;
$post$;
