-- The forecast was two and a half hours short of the day.
--
-- ── WHAT WAS WRONG ────────────────────────────────────────────────────────
--
-- Measured on Demo Pet Waste Co's 2026-09-14 — 26 stops, three technicians,
-- every leg fetched from OSRM so nothing here is an estimate:
--
--   the panel said        435.1 min   (service 321 + travel 114.1)
--   the technicians drove 646.6 min   (service 321 + driving 325.6)
--
-- 211.5 minutes of real working day appeared on no screen. It is two
-- omissions, both in the same expression, and they compound:
--
--   1. `travel_min := GREATEST(_drive - _park, 0)`. Every leg was reported
--      `park_walk_min` short — 6 minutes a stop for this organization, 156
--      minutes across the day — and that time was not added to the service
--      duration either. It simply left the arithmetic.
--
--      The clock did not lose it. `_es := _clock + _drive` advances by the
--      FULL leg, so the ETAs were right the whole time and only the totals
--      were wrong. That is worse than both being wrong, because the two
--      disagree: a dispatcher adding up the drive times on screen cannot
--      reproduce the arrival times printed beside them, and there is a
--      six-minute hole at every stop where the reconciliation should be.
--      `findRouteWarnings` in src/lib/route-plausibility.ts asserts exactly
--      that reconciliation — "arrival is earlier than its drive allows" — so
--      its guard has been loose by `park_walk_min` per stop since the day it
--      was written.
--
--   2. The closing leg was never reported at all. Since 20260831150000 the
--      planner ORDERS the day around ending at the dump, and 20260901060000
--      refuses an end point no stop can reach — so the leg is chosen
--      carefully, driven for real, and then counted nowhere. 55.5 minutes
--      across three technicians on the day above.
--
-- ── WHY IT IS NOT MERELY A DISPLAY BUG ────────────────────────────────────
--
-- `plan_day_across_staff_dryrun` balances the team on that same short number.
-- Its rebalance loop moves a visit whenever `max(day) - min(day) > 10`, where
-- `day` is `service + travel_min` — so it is aiming at a figure that omits six
-- minutes per stop and the whole trip to the dump, and the omission is not
-- uniform: it scales with STOP COUNT, so a technician with twelve short stops
-- is undercounted by 72 minutes against a colleague with six long ones at 36.
-- The loop then declares them even.
--
-- Replayed over 24 scenarios on that geography — 16 to 26 stops, two and three
-- technicians, every leg measured — scoring the same loop on the number it
-- reports against scoring it on the real day:
--
--   real spread, balanced on the reported figure   median 24.2 min, worst 55.1
--   real spread, balanced on the real day          median  9.8 min, worst 24.4
--
-- The loop is not weak. It is aimed at the wrong quantity, and lands about two
-- and a half times off target. This migration does not touch the loop.
--
-- ── WHAT THIS IS NOT ──────────────────────────────────────────────────────
--
-- It is not a rewrite of the assignment. The sweep-and-rebalance was suspected
-- and measured: against a swap-and-restart search held to the shipped
-- partition's own balance, over the same 24 scenarios, the shipped split gives
-- up a median of 1.2% of drive time (p90 3.6%, worst 4.2%). That is real and
-- it is small, and it is not what makes the screen wrong. Chasing it would
-- have replaced a working algorithm and left the 211 minutes in place.

-- ── The closing leg, as a thing with a name ───────────────────────────────
--
-- plan_route decides whether the day ends at the end point by testing the
-- NEAREST stop against max_drive_minutes; if nothing is close enough the end
-- point is data entry rather than a destination and the route stays open. Any
-- other place that costs the closing leg has to apply the same rule or it will
-- add a leg the planner deliberately refused. So the rule lives here once,
-- takes the whole planned set to test and the last stop to measure, and
-- returns 0 rather than NULL when there is no leg to add — the callers are all
-- summing.
CREATE OR REPLACE FUNCTION public.closing_drive_min(
  _org_id uuid, _staff_id uuid, _visit_ids uuid[], _last_visit_id uuid
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  _elat double precision; _elon double precision;
  _max_drive numeric; _nearest numeric; _close numeric;
BEGIN
  IF _last_visit_id IS NULL OR _visit_ids IS NULL
     OR COALESCE(array_length(_visit_ids, 1), 0) = 0 THEN
    RETURN 0;
  END IF;

  SELECT ep.lat, ep.lon INTO _elat, _elon
    FROM public.staff_end_point(_org_id, _staff_id) ep;
  IF _elat IS NULL OR _elon IS NULL THEN
    RETURN 0;                                   -- an open path costs nothing to close
  END IF;

  SELECT COALESCE(max_drive_minutes, 240) INTO _max_drive
    FROM public.organizations WHERE id = _org_id;

  -- The same test plan_route makes, over the same set, so the two agree about
  -- whether this day ends anywhere at all.
  SELECT min(public.drive_minutes(_org_id, p.latitude, p.longitude, _elat, _elon))
    INTO _nearest
    FROM public.visits v
    JOIN public.properties p ON p.id = v.property_id
   WHERE v.id = ANY(_visit_ids);
  IF _nearest IS NULL OR _nearest > COALESCE(_max_drive, 240) THEN
    RETURN 0;
  END IF;

  SELECT public.drive_minutes(_org_id, p.latitude, p.longitude, _elat, _elon)
    INTO _close
    FROM public.visits v
    JOIN public.properties p ON p.id = v.property_id
   WHERE v.id = _last_visit_id;

  RETURN COALESCE(_close, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.closing_drive_min(uuid, uuid, uuid[], uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.closing_drive_min(uuid, uuid, uuid[], uuid) TO service_role;

-- ── The solver, reporting the leg it actually drove ───────────────────────
--
-- One expression changes. `_park` goes with it: it was read from the
-- organization for the sole purpose of being subtracted here, and
-- drive_minutes() — which is where park_walk_min belongs and where it still
-- lives — has already added it to every leg in `_legs`. Subtracting it back
-- out at the reporting step was the whole fault.
CREATE OR REPLACE FUNCTION public.plan_route(_org_id uuid, _staff_id uuid, _day date, _reassign boolean DEFAULT false, _level text DEFAULT 'balanced'::text)
RETURNS TABLE(visit_id uuid, seq integer, eta_start timestamp with time zone, eta_end timestamp with time zone, travel_km numeric, travel_min numeric, window_violated boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _start_lat DOUBLE PRECISION; _start_lon DOUBLE PRECISION;
  _cur_lat DOUBLE PRECISION;   _cur_lon DOUBLE PRECISION;
  _cur_id UUID;
  _end_lat DOUBLE PRECISION; _end_lon DOUBLE PRECISION;
  _START CONSTANT UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  _END   CONSTANT UUID := 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid;
  _workday_start TIME; _workday_end TIME;
  _speed NUMERIC; _traffic TEXT; _tz TEXT; _traffic_mult NUMERIC;
  _max_drive NUMERIC; _nearest_close NUMERIC;
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
         COALESCE(max_drive_minutes, 240)
    INTO _workday_start, _workday_end, _speed, _traffic, _tz, _max_drive
    FROM public.organizations WHERE id = _org_id;

  _tz := COALESCE(_tz, 'America/Chicago');
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

    -- If the CLOSEST stop of the day cannot reach the end point inside the
    -- organization's own max_drive_minutes, no ordering of this day ends there
    -- and the coordinate is data entry, not a destination. Dropping the rows
    -- restores the open path, which is strictly better than a wrong one.
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

    _tkm   := COALESCE(public.road_km(_org_id, _cur_lat, _cur_lon, _v.lat, _v.lon), 0);
    _drive := COALESCE(
                (SELECT lg.minutes FROM _legs lg WHERE lg.from_id = _cur_id AND lg.to_id = _picked),
                0);
    -- The leg as driven. It used to be reported `park_walk_min` short while
    -- the clock below advanced by the whole thing, so the arrival times and
    -- the drive times beside them described different journeys.
    _tmin  := COALESCE(_drive, 0);

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
$function$;

REVOKE ALL ON FUNCTION public.plan_route(uuid, uuid, date, boolean, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plan_route(uuid, uuid, date, boolean, text) TO service_role;

-- ── plan_visits, respliced ────────────────────────────────────────────────
--
-- Byte for byte the block from 20260815190000, run again for the same reason:
-- plan_visits is never written out by hand, so that Apply and Preview cannot
-- drift. plan_route changed above, so its derivative is rebuilt from the new
-- body. Every substitution is still asserted, because a splice that matched
-- nothing would leave yesterday's plan_visits in place — agreeing with a
-- plan_route that no longer exists.
DO $$
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
END $$;

DO $grant$
BEGIN
  IF to_regprocedure('public.plan_visits(uuid,uuid,date,uuid[],text)') IS NULL THEN
    RAISE EXCEPTION 'plan_visits was not created';
  END IF;
  REVOKE ALL ON FUNCTION public.plan_visits(uuid, uuid, date, uuid[], text) FROM public, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.plan_visits(uuid, uuid, date, uuid[], text) TO service_role;
END $grant$;

-- Both solvers must have stopped subtracting it. Asserted on the BODY with
-- comments stripped, because the prose above this line mentions the old
-- expression and a naive LIKE would match the explanation of the fix rather
-- than the fix.
DO $check$
DECLARE _n int;
BEGIN
  SELECT count(*) INTO _n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('plan_route','plan_visits')
     AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') LIKE '%GREATEST(_drive%';
  IF _n <> 0 THEN
    RAISE EXCEPTION 'expected neither solver to discount the reported leg, found % that still do', _n;
  END IF;
END $check$;

-- ── One answer to "what does this technician's day cost" ──────────────────
--
-- The dryrun asks it twice per pass -- once before a move and once after -- and
-- the two must be the same question or the loop compares a day to a different
-- day and reverts on noise. They were two copies of one SELECT, which is the
-- arrangement this repo has been bitten by before, so they are now one
-- function called twice.
--
-- It reads `_dry_route`, an unqualified temp table, exactly as
-- route_segment_min reads `_legs`. That is a real constraint and worth stating:
-- it is callable only from inside the dryrun, which is why it is named for it.
CREATE OR REPLACE FUNCTION public.dry_day_min(_org_id uuid, _staff_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE _t numeric; _ids uuid[]; _last uuid;
BEGIN
  SELECT COALESCE(SUM(COALESCE(p.service_duration_min, 8) + COALESCE(r.t_min, 0)), 0)
    INTO _t
    FROM _dry_route r
    JOIN public.visits v ON v.id = r.vid
    LEFT JOIN public.properties p ON p.id = v.property_id
   WHERE r.sid = _staff_id;

  _ids := ARRAY(SELECT r2.vid FROM _dry_route r2 WHERE r2.sid = _staff_id);
  SELECT r3.vid INTO _last
    FROM _dry_route r3 WHERE r3.sid = _staff_id ORDER BY r3.s_no DESC LIMIT 1;

  -- The trip to the dump. Driven since 20260831150000, planned for since then,
  -- and until now weighed by nobody.
  RETURN _t + public.closing_drive_min(_org_id, _staff_id, _ids, _last);
END;
$$;

REVOKE ALL ON FUNCTION public.dry_day_min(uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dry_day_min(uuid, uuid) TO service_role;

-- ── The balance, weighed on the whole day ─────────────────────────────────
--
-- Three expressions in the dryrun compute "what does this technician's day
-- cost": the spread before a move, the spread after it, and nothing else. All
-- three read `service + t_min`, which now carries the parking time, and all
-- three gain the closing leg. The loop, its eight-pass cap, its ten-minute
-- threshold, its nearest-to-the-centroid pick and its revert-and-stop are
-- untouched — the finding was that it aims well at the wrong number.
CREATE OR REPLACE FUNCTION public.plan_day_across_staff_dryrun(_org_id uuid, _staff_ids uuid[], _day date, _reassign boolean DEFAULT false, _level text DEFAULT 'balanced'::text)
RETURNS TABLE(staff_id uuid, visit_id uuid, seq integer, eta_start timestamp with time zone, eta_end timestamp with time zone, travel_km numeric, travel_min numeric, window_violated boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _eligible uuid[];
  _s uuid;
  _cy double precision; _cx double precision;
  _gap_start double precision;
  _total_service numeric;
  _cap_total numeric;
  _p record;
  _pass int := 0;
  _hi uuid; _lo uuid;
  _spread numeric; _new_spread numeric;
  _move_id uuid;
BEGIN
  IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized to plan routes for this organization';
  END IF;
  _level := COALESCE(NULLIF(_level, ''), 'balanced');
  IF _level NOT IN ('fast', 'balanced', 'thorough') THEN
    RAISE EXCEPTION 'Unknown optimization level: %', _level;
  END IF;

  _eligible := public.routable_staff(_org_id, _staff_ids, _day);
  IF COALESCE(array_length(_eligible, 1), 0) = 0 THEN
    RETURN;
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _dry_grp (
    id uuid PRIMARY KEY,
    lat double precision,
    lon double precision,
    svc_min numeric,
    ang double precision,
    cluster int
  ) ON COMMIT DROP;
  DELETE FROM _dry_grp WHERE true;

  INSERT INTO _dry_grp (id, lat, lon, svc_min)
  SELECT v.id, p.latitude, p.longitude, COALESCE(p.service_duration_min, 8)
    FROM public.visits v
    LEFT JOIN public.properties p ON p.id = v.property_id
   WHERE v.organization_id = _org_id
     AND v.scheduled_on = _day
     AND v.status = 'scheduled'
     AND (
       CASE WHEN _reassign
            THEN v.assigned_staff_id IS NULL OR v.assigned_staff_id = ANY(_eligible)
            ELSE v.assigned_staff_id IS NULL
       END
     );

  IF NOT EXISTS (SELECT 1 FROM _dry_grp) THEN
    RETURN;
  END IF;

  SELECT avg(g.lat), avg(g.lon) INTO _cy, _cx FROM _dry_grp g WHERE g.lat IS NOT NULL;

  UPDATE _dry_grp SET ang = atan2(COALESCE(lat, _cy) - _cy, COALESCE(lon, _cx) - _cx)
   WHERE true;

  SELECT COALESCE(
           (SELECT q.ang FROM (
              SELECT g3.ang, g3.ang - LAG(g3.ang) OVER (ORDER BY g3.ang) AS gap FROM _dry_grp g3
            ) q WHERE q.gap IS NOT NULL ORDER BY q.gap DESC LIMIT 1),
           (SELECT min(g4.ang) FROM _dry_grp g4))
    INTO _gap_start;

  UPDATE _dry_grp
     SET ang = CASE WHEN ang - _gap_start < 0
                    THEN ang - _gap_start + 2 * pi()
                    ELSE ang - _gap_start END
   WHERE true;

  SELECT sum(g.svc_min) INTO _total_service FROM _dry_grp g;

  CREATE TEMP TABLE IF NOT EXISTS _dry_share (
    ord int, sid uuid, capacity numeric, upto numeric
  ) ON COMMIT DROP;
  DELETE FROM _dry_share WHERE true;

  INSERT INTO _dry_share (ord, sid, capacity)
  SELECT row_number() OVER (ORDER BY e.s), e.s,
         GREATEST(
           COALESCE(st.daily_capacity_minutes, 480)
             - COALESCE((SELECT c.minutes FROM public.route_cost_current(_org_id, e.s, _day) c), 0),
           30)
    FROM unnest(_eligible) AS e(s)
    JOIN public.staff st ON st.id = e.s;

  SELECT sum(sh.capacity) INTO _cap_total FROM _dry_share sh;

  UPDATE _dry_share sh
     SET upto = x.running
    FROM (
      SELECT s2.ord, _total_service * (SUM(s2.capacity) OVER (ORDER BY s2.ord)) / NULLIF(_cap_total, 0) AS running
        FROM _dry_share s2
    ) x
   WHERE x.ord = sh.ord;

  UPDATE _dry_grp g
     SET cluster = COALESCE(
       (SELECT min(sh.ord) FROM _dry_share sh WHERE sh.upto >= c.cum),
       (SELECT max(s3.ord) FROM _dry_share s3))
    FROM (
      SELECT g2.id, SUM(g2.svc_min) OVER (ORDER BY g2.ang, g2.id) AS cum FROM _dry_grp g2
    ) c
   WHERE c.id = g.id;

  CREATE TEMP TABLE IF NOT EXISTS _dry_match (cluster int, sid uuid) ON COMMIT DROP;
  DELETE FROM _dry_match WHERE true;

  FOR _p IN
    SELECT g.cluster AS cl, count(*) AS n, avg(g.lat) AS lat, avg(g.lon) AS lon
      FROM _dry_grp g GROUP BY g.cluster ORDER BY count(*) DESC
  LOOP
    -- Which technician is nearest this arc. Through staff_start_point rather
    -- than staff.start_latitude: the raw column is NULL for anyone without a
    -- start address, COALESCE(...,9999) then sorted them behind everybody with
    -- one, and they took whatever arc was left over however far away it was.
    -- The four-tier chain resolves the same point plan_route will actually
    -- start them from -- their address, the business, the nearest dump, the
    -- edge of the day -- so the match and the route agree about where this
    -- person begins. Demo Pet Waste Co has such a technician today.
    SELECT sh.sid INTO _s
      FROM _dry_share sh
      CROSS JOIN LATERAL public.staff_start_point(_org_id, sh.sid, _day) sp
     WHERE sh.sid NOT IN (SELECT m.sid FROM _dry_match m)
     ORDER BY COALESCE(
                public.haversine_km(sp.lat, sp.lon, _p.lat, _p.lon),
                9999) ASC,
              sh.sid
     LIMIT 1;
    IF _s IS NOT NULL THEN
      INSERT INTO _dry_match (cluster, sid) VALUES (_p.cl, _s);
    END IF;
  END LOOP;

  CREATE TEMP TABLE IF NOT EXISTS _dry_asn (vid uuid PRIMARY KEY, sid uuid NOT NULL) ON COMMIT DROP;
  DELETE FROM _dry_asn WHERE true;

  INSERT INTO _dry_asn (vid, sid)
  SELECT g.id, m.sid FROM _dry_grp g JOIN _dry_match m ON m.cluster = g.cluster;

  INSERT INTO _dry_asn (vid, sid)
  SELECT v.id, v.assigned_staff_id
    FROM public.visits v
   WHERE v.organization_id = _org_id
     AND v.scheduled_on = _day
     AND v.status = 'scheduled'
     AND v.assigned_staff_id = ANY(_eligible)
     AND NOT EXISTS (SELECT 1 FROM _dry_asn a WHERE a.vid = v.id);

  CREATE TEMP TABLE IF NOT EXISTS _dry_route (
    sid uuid, vid uuid, s_no int,
    e_start timestamptz, e_end timestamptz,
    t_km numeric, t_min numeric, w_viol boolean
  ) ON COMMIT DROP;
  DELETE FROM _dry_route WHERE true;

  FOREACH _s IN ARRAY _eligible LOOP
    INSERT INTO _dry_route (sid, vid, s_no, e_start, e_end, t_km, t_min, w_viol)
    SELECT _s, r.visit_id, r.seq, r.eta_start, r.eta_end, r.travel_km, r.travel_min, r.window_violated
      FROM public.plan_visits(_org_id, _s, _day,
             ARRAY(SELECT a.vid FROM _dry_asn a WHERE a.sid = _s), _level) r;
  END LOOP;

  LOOP
    _pass := _pass + 1;
    EXIT WHEN _pass > 8;

    SELECT max(q.t) - min(q.t),
           (array_agg(q.sid ORDER BY q.t DESC, q.sid))[1],
           (array_agg(q.sid ORDER BY q.t ASC, q.sid))[1]
      INTO _spread, _hi, _lo
      FROM (
        SELECT e.s AS sid, public.dry_day_min(_org_id, e.s) AS t
          FROM unnest(_eligible) AS e(s)
      ) q;

    EXIT WHEN _spread IS NULL OR _spread <= 10;
    EXIT WHEN _hi IS NULL OR _lo IS NULL OR _hi = _lo;

    SELECT r.vid INTO _move_id
      FROM _dry_route r
      JOIN public.visits v ON v.id = r.vid
      LEFT JOIN public.properties p ON p.id = v.property_id
     WHERE r.sid = _hi
     ORDER BY COALESCE(
                public.haversine_km(
                  p.latitude, p.longitude,
                  (SELECT avg(p2.latitude)
                     FROM _dry_route r2
                     JOIN public.visits v2 ON v2.id = r2.vid
                     JOIN public.properties p2 ON p2.id = v2.property_id
                    WHERE r2.sid = _lo),
                  (SELECT avg(p2.longitude)
                     FROM _dry_route r2
                     JOIN public.visits v2 ON v2.id = r2.vid
                     JOIN public.properties p2 ON p2.id = v2.property_id
                    WHERE r2.sid = _lo)),
                9999) ASC,
              r.vid
     LIMIT 1;
    EXIT WHEN _move_id IS NULL;

    UPDATE _dry_asn SET sid = _lo WHERE vid = _move_id;
    FOREACH _s IN ARRAY ARRAY[_hi, _lo] LOOP
      DELETE FROM _dry_route WHERE sid = _s;
      INSERT INTO _dry_route (sid, vid, s_no, e_start, e_end, t_km, t_min, w_viol)
      SELECT _s, r.visit_id, r.seq, r.eta_start, r.eta_end, r.travel_km, r.travel_min, r.window_violated
        FROM public.plan_visits(_org_id, _s, _day,
               ARRAY(SELECT a.vid FROM _dry_asn a WHERE a.sid = _s), _level) r;
    END LOOP;

    SELECT max(q.t) - min(q.t) INTO _new_spread
      FROM (
        SELECT e.s AS sid, public.dry_day_min(_org_id, e.s) AS t
          FROM unnest(_eligible) AS e(s)
      ) q;

    IF _new_spread >= _spread THEN
      UPDATE _dry_asn SET sid = _hi WHERE vid = _move_id;
      FOREACH _s IN ARRAY ARRAY[_hi, _lo] LOOP
        DELETE FROM _dry_route WHERE sid = _s;
        INSERT INTO _dry_route (sid, vid, s_no, e_start, e_end, t_km, t_min, w_viol)
        SELECT _s, r.visit_id, r.seq, r.eta_start, r.eta_end, r.travel_km, r.travel_min, r.window_violated
          FROM public.plan_visits(_org_id, _s, _day,
                 ARRAY(SELECT a.vid FROM _dry_asn a WHERE a.sid = _s), _level) r;
      END LOOP;
      EXIT;
    END IF;
  END LOOP;

  RETURN QUERY
    SELECT r.sid, r.vid, r.s_no, r.e_start, r.e_end, r.t_km, r.t_min, r.w_viol
      FROM _dry_route r
     ORDER BY r.sid, r.s_no;
END;
$function$;

REVOKE ALL ON FUNCTION public.plan_day_across_staff_dryrun(uuid, uuid[], date, boolean, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plan_day_across_staff_dryrun(uuid, uuid[], date, boolean, text) TO service_role;

-- ── And the number the panel prints ───────────────────────────────────────
--
-- The writer's summary is what AutoRoutingPanel shows as "balance": stops,
-- service minutes, travel minutes, total. `travel_min` on each visit now
-- carries the parking time, which fixes most of the gap by itself; the closing
-- leg is added on top, to travel and to the total both, so that the three
-- columns still add up. Nothing else in this function changes -- same guards,
-- same error strings, same nothing-to-do branch, same single UPDATE.
CREATE OR REPLACE FUNCTION public.plan_day_across_staff(_org_id uuid, _staff_ids uuid[], _day date, _reassign boolean DEFAULT false, _level text DEFAULT 'balanced'::text)
RETURNS TABLE(staff_id uuid, stops integer, service_min numeric, travel_min numeric, total_min numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _eligible uuid[];
BEGIN
  IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized to plan routes for this organization';
  END IF;
  IF _staff_ids IS NULL OR COALESCE(array_length(_staff_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'Select at least one technician to route';
  END IF;
  _level := COALESCE(NULLIF(_level, ''), 'balanced');
  IF _level NOT IN ('fast', 'balanced', 'thorough') THEN
    RAISE EXCEPTION 'Unknown optimization level: %', _level;
  END IF;

  -- Asked here as well as inside the planner, because the two callers want
  -- different things from the same answer: Apply must refuse, out loud, with
  -- the reason. applyOptimize collects that per day and the panel shows it.
  _eligible := public.routable_staff(_org_id, _staff_ids, _day);
  IF COALESCE(array_length(_eligible, 1), 0) = 0 THEN
    RAISE EXCEPTION 'None of the selected people can be routed on %: check "Runs routes" and time off', _day;
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _apply_plan (
    sid uuid, vid uuid, s_no int,
    e_start timestamptz, e_end timestamptz,
    t_km numeric, t_min numeric, w_viol boolean
  ) ON COMMIT DROP;
  DELETE FROM _apply_plan WHERE true;

  INSERT INTO _apply_plan (sid, vid, s_no, e_start, e_end, t_km, t_min, w_viol)
  SELECT d.staff_id, d.visit_id, d.seq, d.eta_start, d.eta_end, d.travel_km, d.travel_min, d.window_violated
    FROM public.plan_day_across_staff_dryrun(_org_id, _staff_ids, _day, _reassign, _level) d;

  IF NOT EXISTS (SELECT 1 FROM _apply_plan) THEN
    -- Not an error: "nothing to do" is a normal answer, and the caller still
    -- gets each technician's current load back.
    RETURN QUERY
      SELECT e.s, c.stops, 0::numeric, c.minutes, c.minutes
        FROM unnest(_eligible) AS e(s),
             LATERAL public.route_cost_current(_org_id, e.s, _day) c;
    RETURN;
  END IF;

  -- The only line in this file that changes a customer's day.
  UPDATE public.visits v
     SET assigned_staff_id = w.sid,
         sequence          = w.s_no,
         eta_start         = w.e_start,
         eta_end           = w.e_end,
         travel_km         = w.t_km,
         travel_min        = w.t_min,
         window_violated   = w.w_viol,
         updated_at        = now()
    FROM _apply_plan w
   WHERE v.id = w.vid;

  RETURN QUERY
    WITH assigned AS (
      SELECT e.s AS sid,
             ARRAY(SELECT v2.id
                     FROM public.visits v2
                    WHERE v2.assigned_staff_id = e.s
                      AND v2.scheduled_on = _day
                      AND v2.status = 'scheduled'
                      AND v2.organization_id = _org_id) AS vids,
             (SELECT v3.id
                FROM public.visits v3
               WHERE v3.assigned_staff_id = e.s
                 AND v3.scheduled_on = _day
                 AND v3.status = 'scheduled'
                 AND v3.organization_id = _org_id
               ORDER BY v3.sequence DESC NULLS LAST, v3.created_at DESC
               LIMIT 1) AS last_vid
        FROM unnest(_eligible) AS e(s)
    ),
    closed AS (
      SELECT a.sid,
             public.closing_drive_min(_org_id, a.sid, a.vids, a.last_vid) AS close_min
        FROM assigned a
    )
    SELECT e.s,
           COUNT(v.id)::int,
           ROUND(COALESCE(SUM(COALESCE(p.service_duration_min, 8)), 0), 1),
           ROUND(COALESCE(SUM(v.travel_min), 0) + COALESCE(MAX(cl.close_min), 0), 1),
           ROUND(COALESCE(SUM(COALESCE(p.service_duration_min, 8)), 0)
                 + COALESCE(SUM(v.travel_min), 0)
                 + COALESCE(MAX(cl.close_min), 0), 1)
      FROM unnest(_eligible) AS e(s)
      LEFT JOIN public.visits v
             ON v.assigned_staff_id = e.s
            AND v.scheduled_on = _day
            AND v.status = 'scheduled'
            AND v.organization_id = _org_id
      LEFT JOIN public.properties p ON p.id = v.property_id
      LEFT JOIN closed cl ON cl.sid = e.s
     GROUP BY e.s
     ORDER BY e.s;
END;
$function$;

REVOKE ALL ON FUNCTION public.plan_day_across_staff(uuid, uuid[], date, boolean, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plan_day_across_staff(uuid, uuid[], date, boolean, text) TO service_role;

-- ── What a technician's day already costs ─────────────────────────────────
--
-- Two callers: the sweep, which subtracts this from daily_capacity_minutes to
-- decide how big an arc each person gets, and the writer's nothing-to-do
-- branch, which shows it. Both wanted the whole day and were given part of it.
--
-- Two changes, the same two as everywhere else in this file. The start point
-- is resolved through staff_start_point instead of read raw, so the first leg
-- is measured from where the person will actually be rather than from NULL --
-- which made the first leg free and every subsequent capacity share wrong for
-- anyone without a start address. And the trip to the dump is counted.
CREATE OR REPLACE FUNCTION public.route_cost_current(_org_id uuid, _staff_id uuid, _day date)
RETURNS TABLE(stops integer, minutes numeric, sequenced boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _lat DOUBLE PRECISION; _lon DOUBLE PRECISION;
  _total NUMERIC := 0; _n INT := 0; _unseq INT := 0; _r RECORD;
  _ids uuid[]; _last uuid;
BEGIN
  IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT sp.lat, sp.lon INTO _lat, _lon
    FROM public.staff_start_point(_org_id, _staff_id, _day) sp;

  FOR _r IN
    SELECT v.id, v.sequence, p.latitude AS lat, p.longitude AS lon
      FROM public.visits v
      LEFT JOIN public.properties p ON p.id = v.property_id
     WHERE v.organization_id = _org_id
       AND v.assigned_staff_id = _staff_id
       AND v.scheduled_on = _day
       AND v.status = 'scheduled'
     ORDER BY v.sequence NULLS LAST, v.created_at
  LOOP
    _n := _n + 1;
    IF _r.sequence IS NULL THEN _unseq := _unseq + 1; END IF;
    _total := _total + COALESCE(public.drive_minutes(_org_id,_lat,_lon,_r.lat,_r.lon), 0);
    IF _r.lat IS NOT NULL THEN _lat := _r.lat; _lon := _r.lon; END IF;
    _ids := _ids || _r.id;
    _last := _r.id;
  END LOOP;

  _total := _total + public.closing_drive_min(_org_id, _staff_id, _ids, _last);

  stops := _n;
  minutes := ROUND(_total, 1);
  sequenced := (_n > 0 AND _unseq = 0);
  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.route_cost_current(uuid, uuid, date) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.route_cost_current(uuid, uuid, date) TO service_role;

-- ── What this migration establishes ───────────────────────────────────────
--
-- Provable from any starting state, including an empty one, which is why these
-- are exceptions rather than warnings: none of them counts a row.
DO $est$
DECLARE _n int;
BEGIN
  -- Nothing may still read the raw start column where the resolved point is
  -- what the route will use. Comments stripped first: the prose above says
  -- `staff.start_latitude` while explaining why it is gone, and a guard
  -- answered by its own explanation is not a guard.
  SELECT count(*) INTO _n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('plan_day_across_staff_dryrun','route_cost_current')
     AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') LIKE '%st.start_latitude%';
  IF _n <> 0 THEN
    RAISE EXCEPTION 'expected the planner to resolve start points through staff_start_point, % still read the column', _n;
  END IF;

  -- Every place that adds up a day now asks the same function for the leg
  -- home, so there is one rule about max_drive_minutes rather than three.
  SELECT count(*) INTO _n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('dry_day_min','plan_day_across_staff','route_cost_current')
     AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') LIKE '%closing_drive_min%';
  IF _n <> 3 THEN
    RAISE EXCEPTION 'expected all three day-cost sites to count the closing leg, found %', _n;
  END IF;

  -- And the dryrun asks its one question once.
  SELECT count(*) INTO _n
    FROM regexp_matches(
           regexp_replace(
             (SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = 'plan_day_across_staff_dryrun'),
             '--[^\n]*', '', 'g'),
           'dry_day_min', 'g');
  IF _n <> 2 THEN
    RAISE EXCEPTION 'expected the rebalance to weigh the day twice through one function, found % call sites', _n;
  END IF;
END $est$;

-- What the day looked like when this was written, which is a measurement of a
-- database and not something a replay can reproduce. It prints so that a person
-- reading the log can see whether it still holds.
DO $obs$
DECLARE _park numeric; _orgs int;
BEGIN
  SELECT count(*) INTO _orgs FROM public.organizations;
  IF _orgs = 0 THEN
    RAISE WARNING 'no organizations to measure: the park/walk observation below was not checked on this build';
    RETURN;
  END IF;
  SELECT max(COALESCE(park_walk_min, 2)) INTO _park FROM public.organizations;
  RAISE WARNING 'largest park_walk_min in this database is % min per stop; on a 26-stop day that is % minutes that used to leave the totals', _park, _park * 26;
END $obs$;
