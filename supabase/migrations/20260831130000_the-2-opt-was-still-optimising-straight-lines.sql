-- The 2-opt was still optimising straight lines, and the screen said 0.2 km in 7 minutes.
--
-- ── WHAT THE OWNER SAW ───────────────────────────────────────────────────
--
-- "The auto-routing doesn't make much sense." Today's run, Taylor Tech's ten
-- stops, exactly as the route screen renders them -- `Drive {travel_km} km ·
-- {travel_min} min`, routes.tsx:2203 and VisitDetailDrawer.tsx:357:
--
--   seq   km shown   min shown   implied speed
--    6      0.60        8.4         4.3 km/h
--    9      0.69        8.3         5.0 km/h
--   10      0.21        7.1         1.8 km/h
--
-- A van does not cover 210 metres in seven minutes. Nothing about the ROUTE
-- was wrong there; the two numbers printed beside each other were measuring
-- different things, and neither was what the label said.
--
-- ── THE TWO NUMBERS ──────────────────────────────────────────────────────
--
-- `travel_km` was the straight line. `travel_min` was the real road time from
-- the OSRM cache, PLUS `park_walk_min`, a flat per-stop constant. Measured on
-- the same five legs, against the cache rows those legs actually hit:
--
--   seq   km stored   km haversine   km OSRM   min stored   min OSRM   diff
--    2      1.31         1.31         1.90       10.20        4.16      6.04
--    3      1.83         1.83         3.52       11.70        5.65      6.05
--    4      1.13         1.13         1.69        8.90        2.86      6.04
--    5      2.75         2.75         4.44       14.20        8.17      6.04
--    6      0.60         0.60         0.89        8.40        2.44      5.96
--
-- `km stored` is `km haversine` to the penny in every row, while the road is
-- 1.4x to 1.9x longer and sitting in the cache the same query already read for
-- the time. And `min stored - min OSRM` is 6.0 every time, which is this org's
-- `park_walk_min`. Parking is real and it stays in the schedule; it is not
-- distance travelled, and dividing one by the other is what produced 1.8 km/h.
--
-- So: `travel_km` now comes from the cached road metres, via `road_km()`
-- below, which is the distance twin of `drive_minutes()` and misses the same
-- way -- haversine x `road_factor` when nothing is cached. `travel_min` is the
-- drive alone. The CLOCK is untouched: `eta_start` still advances by the full
-- drive-plus-parking, so no schedule moves and no day gets shorter. Only the
-- reported pair becomes two measurements of the same journey.
--
-- ── AND THE HALF OF 20260826180000 THAT WAS NEVER FINISHED ───────────────
--
-- That migration said it plainly:
--
--   "the solver minimises the WRONG QUANTITY. Nearest-neighbour and 2-opt
--    over straight-line distance produce a good straight-line route"
--
-- It then fixed nearest-neighbour -- the candidate scan calls `drive_minutes`
-- and has since -- and left the 2-opt calling `route_segment_km`, which is
-- haversine and nothing else. So `thorough` built a route on road time and
-- then reordered it to shorten a straight line. The improvement pass was
-- undoing the objective the construction pass had just been taught.
--
-- Corrected against today's 26 stops, three technicians, using the cache rows
-- those routes actually hit: 93.3 drive minutes as shipped, 90.9 with the
-- 2-opt reading the same road minutes the rest of the planner does. 2.4
-- minutes, 2.6%. Small on a day whose stops sit inside four kilometres of each
-- other, which is the case where a straight line and a road agree; the point
-- is that the pass can no longer trade a real minute for an imaginary metre,
-- and on a spread-out day there is nothing bounding how bad that trade gets.
--
-- Two smaller things, found while reading it:
--
-- THE TAIL WAS FROZEN. `_j` ran to `array_length(_order,1) - 1`, so no segment
-- ending at the last stop was ever reversed. On an open path -- this planner
-- does not return to a depot -- reversing the tail changes exactly one edge
-- and is a perfectly ordinary improving move. It was simply unreachable.
--
-- THE WINDOW CHECK RAN ON A DIFFERENT CLOCK. The arrival-window penalty
-- projected arrival with `(km / avg_speed_kmh) * 60 / traffic_mult` -- the
-- straight-line estimate at 30 km/h -- while `tmin`, on the very next line of
-- the same SELECT, held the real drive. So the penalty decided whether a stop
-- would miss its window using a journey the planner had already replaced. It
-- now uses the same number it sequences on.
--
-- ── WHERE THE FIX GOES, WHICH IS NOT WHERE THE BUG IS READ ───────────────
--
-- Both changes land in `plan_route`, and `plan_visits` is respliced from it at
-- the bottom of this file. plan_visits is not written out anywhere in this
-- repo and must not be -- see the splice block for what a first draft of this
-- migration got wrong, and which test caught it.
--
-- ── WHAT THIS DOES NOT CHANGE, HAVING CHECKED ────────────────────────────
--
-- The ASSIGNMENT. The sweep in `plan_day_across_staff_dryrun` was the first
-- suspect and it is not guilty: 4,000 random move-and-swap reassignments of
-- today's 26 stops, scored on real road minutes with each candidate resequenced
-- by nearest-neighbour and a road-minute 2-opt, found nothing better than the
-- 10/8/8 split it already produces. Zero improvement. The arcs are not the
-- problem and are left alone.
--
-- ── COST ─────────────────────────────────────────────────────────────────
--
-- A road-minute 2-opt evaluates whole paths, and every leg is a `road_legs`
-- lookup rather than arithmetic -- for 21 stops and eight passes that is tens
-- of thousands of index probes against a `statement_timeout` of 8s, where the
-- haversine version measured 394ms. So the legs are read ONCE into a temp
-- matrix and both passes read from it. The nearest-neighbour scan uses it too,
-- which is why it is built before the construction loop rather than beside the
-- 2-opt that needed it.
--
-- `park_walk_min` rides along inside those matrix minutes, and deliberately.
-- Every ordering of n stops has exactly n legs, so a per-leg constant is the
-- same in every candidate and cancels out of the comparison. It is subtracted
-- once, at the end, from the number that gets REPORTED.

-- The distance twin of drive_minutes(). Same cache, same rounding, same
-- fallback, so a row that answers one answers the other and the pair can never
-- again describe two different journeys.
CREATE OR REPLACE FUNCTION public.road_km(
  _org_id uuid,
  _lat1 double precision, _lon1 double precision,
  _lat2 double precision, _lon2 double precision
) RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE _meters numeric; _factor numeric;
BEGIN
  IF _lat1 IS NULL OR _lon1 IS NULL OR _lat2 IS NULL OR _lon2 IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT rl.meters INTO _meters
    FROM public.road_legs rl
   WHERE rl.organization_id = _org_id
     AND rl.from_lat = round(_lat1::numeric, 5) AND rl.from_lon = round(_lon1::numeric, 5)
     AND rl.to_lat   = round(_lat2::numeric, 5) AND rl.to_lon   = round(_lon2::numeric, 5)
     AND rl.fetched_at > now() - interval '90 days';

  IF _meters IS NOT NULL THEN
    RETURN _meters / 1000.0;
  END IF;

  SELECT COALESCE(o.road_factor, 1.30) INTO _factor
    FROM public.organizations o WHERE o.id = _org_id;

  RETURN public.haversine_km(_lat1, _lon1, _lat2, _lon2) * COALESCE(_factor, 1.30);
END;
$fn$;

-- Closed rather than authorised, and the guard in
-- tests/six-helpers-that-answered-questions-about-other-peoples-tenants.test.ts
-- is right to have insisted: road_km is SECURITY DEFINER, takes an _org_id and
-- never asks who is calling, so granting it to `authenticated` would let any
-- signed-in user of any tenant probe any other tenant's cached legs -- which
-- are, as 20260826200000 puts it, a record of where somebody lives. Nothing in
-- src/ calls it by RPC; its only caller is the solver below, which has already
-- checked can_write_org.
REVOKE ALL ON FUNCTION public.road_km(uuid, double precision, double precision, double precision, double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.road_km(uuid, double precision, double precision, double precision, double precision) TO service_role;

-- The road-minute cost of an ordering, read from the caller's `_legs` matrix.
-- Same shape as route_segment_km() -- a function over a temp table the caller
-- owns -- because the 2-opt needs to score a candidate array without writing
-- it anywhere. `_legs` uses the all-zeroes uuid for the technician's start,
-- because a NULL cannot be joined on.
CREATE OR REPLACE FUNCTION public.route_segment_min(_ids uuid[])
RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE
  _total numeric := 0;
  _prev uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  _r RECORD;
BEGIN
  FOR _r IN SELECT u.id FROM unnest(_ids) WITH ORDINALITY AS u(id, ord) ORDER BY u.ord
  LOOP
    _total := _total + COALESCE(
      (SELECT lg.minutes FROM _legs lg WHERE lg.from_id = _prev AND lg.to_id = _r.id), 0);
    _prev := _r.id;
  END LOOP;
  RETURN _total;
END;
$fn$;

-- Same posture as road_km, and for a second reason: it reads `_legs`, a temp
-- table only the solver populates, so a caller reaching it directly gets an
-- error or somebody else's scratch space depending on what their session has
-- left lying around.
REVOKE ALL ON FUNCTION public.route_segment_min(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.route_segment_min(uuid[]) TO service_role;

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
  _START CONSTANT UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  _workday_start TIME; _workday_end TIME;
  _speed NUMERIC; _traffic TEXT; _tz TEXT; _traffic_mult NUMERIC;
  _park NUMERIC;
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
  SELECT workday_start, workday_end, avg_speed_kmh, traffic_profile, timezone,
         COALESCE(park_walk_min, 2)
    INTO _workday_start, _workday_end, _speed, _traffic, _tz, _park
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

-- ── And plan_visits, respliced from the solver above ──────────────────────
--
-- `plan_visits` is not written out anywhere in this repo and must not be. It is
-- `plan_route` with three clauses changed, spliced out of pg_get_functiondef by
-- 20260815190000, whose reasoning is worth repeating because this migration
-- nearly broke it: "a hand copy would be a second solver that agrees today and
-- diverges the first time anyone touches either."
--
-- That is exactly what a first draft of this file did -- it fixed plan_visits
-- directly and left plan_route on the straight-line 2-opt, which would have
-- given Apply and Preview two different objectives, which is the same class of
-- fault 20260815190000 was written to end. The test that caught it asserts the
-- PREMISE ("still has no literal CREATE") rather than the conclusion, which is
-- the only reason it could catch it at all.
--
-- So: the fix goes into plan_route, and plan_visits is regenerated here by the
-- same three substitutions, each still asserted to have taken.
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
  -- Guarded for the reason 20260815190000 gives: the function above is created
  -- by EXECUTE, so a bare GRANT would look, to the scan in
  -- tests/the-wiring-is-connected.test.ts, like granting on something no
  -- migration creates.
  IF to_regprocedure('public.plan_visits(uuid,uuid,date,uuid[],text)') IS NULL THEN
    RAISE EXCEPTION 'plan_visits was not created';
  END IF;
  REVOKE ALL ON FUNCTION public.plan_visits(uuid, uuid, date, uuid[], text) FROM public, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.plan_visits(uuid, uuid, date, uuid[], text) TO service_role;
END $grant$;

REVOKE ALL ON FUNCTION public.plan_route(uuid, uuid, date, boolean, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plan_route(uuid, uuid, date, boolean, text) TO service_role;

-- Every assertion below is about what THIS migration establishes, so a replay
-- into an empty database can prove all of them with no tenant and no rows.
DO $post$
DECLARE _n int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'road_km'
  ) THEN
    RAISE EXCEPTION 'road_km is missing after this migration';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'route_segment_min'
  ) THEN
    RAISE EXCEPTION 'route_segment_min is missing after this migration';
  END IF;

  -- The point of the change, asserted rather than described: the sequencer no
  -- longer scores an ordering in straight-line kilometres. prosrc, not
  -- pg_get_functiondef -- see the working agreement in CLAUDE.md.
  --
  -- COMMENTS ARE STRIPPED FIRST, and that is not defensive tidiness: the first
  -- version of this block failed against the correct function, because the
  -- comment above the 2-opt reads "route_segment_min, not route_segment_km"
  -- and prosrc is the whole body, comments included. Same fault as the unpkg
  -- guard in tests/, and the prosrc assertion before that -- a check answered
  -- by the prose that describes it rather than by the code that does it. It
  -- fails in both directions and this one happened to fail loudly.
  SELECT count(*) INTO _n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('plan_route','plan_visits')
     AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') LIKE '%route_segment_km%';
  IF _n > 0 THEN
    RAISE EXCEPTION 'a solver still scores orderings with route_segment_km (straight-line km)';
  END IF;

  SELECT count(*) INTO _n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('plan_route','plan_visits')
     AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') LIKE '%route_segment_min%';
  -- BOTH of them, because the whole point of the splice is that they cannot
  -- drift apart; one of two passing here would be the drift itself.
  IF _n <> 2 THEN
    RAISE EXCEPTION 'expected both plan_route and plan_visits to score on route_segment_min, found %', _n;
  END IF;
END;
$post$;
