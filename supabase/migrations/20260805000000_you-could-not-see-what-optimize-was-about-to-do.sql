-- Optimize was a button that rearranged the day and told you afterwards.
--
-- ── WHAT WAS WRONG ────────────────────────────────────────────────────────
--
-- `optimize_route_v2` computes an order and writes it in the same loop. There
-- is no way to ask "what would this do" — the only way to find out was to do
-- it, and the only way back was to re-drag the day by hand. On a route already
-- sequenced by a dispatcher who knows the neighbourhood, that is destructive.
--
-- It also reported `assigned` — a count of stops touched. That is not the
-- question anybody has. The question is whether the new order is better than
-- the one they have, and by how much.
--
-- ── ONE PLANNER, TWO CALLERS ──────────────────────────────────────────────
--
-- `plan_route` computes an ordering and returns it. It writes nothing.
-- `optimize_route_v3` calls it and writes. `preview_optimize` calls it and
-- measures. The preview therefore cannot drift from what Apply does, because
-- they are not two implementations — the classic failure of preview features
-- is a second code path that slowly stops agreeing with the first.
--
-- `optimize_route_v2` is left in place. It is what the existing single-tech
-- Assign/Optimize buttons call, and rewriting those in the same change that
-- introduces the planner would mean shipping two untested things at once.
--
-- ── LEVELS ────────────────────────────────────────────────────────────────
--
--   fast      Nearest neighbour on travel time alone. Ignores arrival windows
--             and morning/afternoon preferences. Honest name: it is what you
--             want when nothing on the day is constrained.
--   balanced  Nearest neighbour plus window and preference penalties. This is
--             exactly v2's behaviour and stays the default, so "Apply" with
--             the default level produces the order the old button produced.
--   thorough  balanced, then 2-opt: repeatedly reverse any segment of the
--             route that shortens the total. Greedy nearest-neighbour reliably
--             leaves crossings in the path, and reversing the crossed segment
--             is what removes them.
--
-- ── HOW "TIME SAVED" IS MEASURED, AND WHEN IT REFUSES TO SAY ──────────────
--
-- Before = travel along the CURRENT sequence, from the tech's start address.
-- After  = travel along the planned sequence, same start, same stop set.
--
-- If the day is not fully sequenced, `before` is not a route — it is a bag of
-- visits in insertion order — and any "saved 45 minutes" computed against it
-- is fiction. `route_cost_current` reports `sequenced` alongside the number so
-- the UI can say "new route" instead of inventing a saving. This is the whole
-- reason that flag is returned rather than the number alone.

-- ── The planner. Computes, returns, writes nothing. ───────────────────────

CREATE OR REPLACE FUNCTION public.plan_route(
  _org_id   uuid,
  _staff_id uuid,
  _day      date,
  _reassign boolean DEFAULT false,
  _level    text    DEFAULT 'balanced'
)
RETURNS TABLE (
  visit_id        uuid,
  seq             integer,
  eta_start       timestamptz,
  eta_end         timestamptz,
  travel_km       numeric,
  travel_min      numeric,
  window_violated boolean
)
LANGUAGE plpgsql
-- VOLATILE (the default), not STABLE: this builds and clears a temp table, and
-- Postgres forbids that inside a STABLE function. It still writes nothing to
-- any real table — "volatile" here is a statement about _plan, not about the
-- schedule.
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _start_lat DOUBLE PRECISION; _start_lon DOUBLE PRECISION;
  _cur_lat DOUBLE PRECISION;   _cur_lon DOUBLE PRECISION;
  _workday_start TIME; _workday_end TIME;
  _speed NUMERIC; _traffic TEXT; _tz TEXT; _traffic_mult NUMERIC;
  _clock TIMESTAMPTZ; _day_start_ts TIMESTAMPTZ;
  _use_penalties BOOLEAN;
  _order uuid[] := '{}';
  -- The reversed slice, held in a variable rather than inlined twice. plpgsql
  -- cannot use a sub-SELECT directly inside an expression the way SQL can, and
  -- computing it once is also the honest thing: the version compared and the
  -- version assigned must be the same array.
  _rev uuid[];
  _picked uuid; _remaining INT; _v RECORD;
  _i INT; _j INT; _improved BOOLEAN; _pass INT := 0;
  _seq INT := 0;
  _tkm NUMERIC; _tmin NUMERIC;
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
  -- 'fast' is the ONLY level that drops the penalties. 'thorough' keeps them
  -- and adds a pass on top — a "better" level that quietly stopped honouring
  -- arrival windows would be worse, not better.
  _use_penalties := (_level <> 'fast');

  SELECT start_latitude, start_longitude INTO _start_lat, _start_lon
    FROM public.staff WHERE id = _staff_id;
  SELECT workday_start, workday_end, avg_speed_kmh, traffic_profile, timezone
    INTO _workday_start, _workday_end, _speed, _traffic, _tz
    FROM public.organizations WHERE id = _org_id;

  _tz := COALESCE(_tz, 'America/Chicago');
  _traffic_mult := CASE _traffic WHEN 'light' THEN 1.15 WHEN 'heavy' THEN 0.7 ELSE 1.0 END;
  _day_start_ts := (_day + COALESCE(_workday_start, TIME '08:00')) AT TIME ZONE _tz;
  _clock := _day_start_ts;
  _cur_lat := _start_lat; _cur_lon := _start_lon;

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

  -- ── Greedy nearest neighbour ────────────────────────────────────────────
  LOOP
    SELECT COUNT(*) INTO _remaining FROM _plan WHERE NOT picked;
    EXIT WHEN _remaining = 0;

    WITH cand AS (
      SELECT o.id, o.lat, o.lon, o.earliest, o.latest, o.pref,
             COALESCE(public.haversine_km(_cur_lat,_cur_lon,o.lat,o.lon), 5.0) AS km
        FROM _plan o WHERE NOT o.picked
    ),
    scored AS (
      SELECT c.*,
             (c.km / NULLIF(_speed,0)) * 60.0 / _traffic_mult AS tmin,
             CASE WHEN _use_penalties AND c.latest IS NOT NULL
                  AND ((_clock + make_interval(mins => ((c.km/NULLIF(_speed,0))*60.0/_traffic_mult)::int)) AT TIME ZONE _tz)::time > c.latest
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
            + make_interval(mins => (COALESCE(public.haversine_km(_cur_lat,_cur_lon,_v.lat,_v.lon),0) / NULLIF(_speed,0) * 60.0 / _traffic_mult)::int)
            + make_interval(mins => COALESCE(_v.duration_min,8));
    IF _v.lat IS NOT NULL AND _v.lon IS NOT NULL THEN
      _cur_lat := _v.lat; _cur_lon := _v.lon;
    END IF;
  END LOOP;

  -- ── 2-opt, thorough only ────────────────────────────────────────────────
  --
  -- Reverse any segment whose reversal shortens the total. Bounded at 8 passes:
  -- 2-opt converges quickly and this runs inside a request, so an unbounded
  -- loop on a pathological day would hold a connection rather than finish.
  IF _level = 'thorough' AND COALESCE(array_length(_order,1),0) > 3 THEN
    LOOP
      _pass := _pass + 1;
      EXIT WHEN _pass > 8;
      _improved := false;
      FOR _i IN 1 .. array_length(_order,1) - 2 LOOP
        FOR _j IN _i + 1 .. array_length(_order,1) - 1 LOOP
          SELECT array_agg(x ORDER BY ord DESC) INTO _rev
            FROM unnest(_order[_i:_j]) WITH ORDINALITY AS t(x, ord);
          IF public.route_segment_km(_order, _start_lat, _start_lon)
             > public.route_segment_km(
                 _order[1:_i-1] || _rev || _order[_j+1:array_length(_order,1)],
                 _start_lat, _start_lon)
          THEN
            _order := _order[1:_i-1] || _rev || _order[_j+1:array_length(_order,1)];
            _improved := true;
          END IF;
        END LOOP;
      END LOOP;
      EXIT WHEN NOT _improved;
    END LOOP;
  END IF;

  -- ── Walk the final order and emit ───────────────────────────────────────
  _clock := _day_start_ts;
  _cur_lat := _start_lat; _cur_lon := _start_lon;
  FOREACH _picked IN ARRAY _order LOOP
    SELECT * INTO _v FROM _plan WHERE id = _picked;
    _tkm  := COALESCE(public.haversine_km(_cur_lat,_cur_lon,_v.lat,_v.lon), 0);
    _tmin := (_tkm / NULLIF(_speed,0)) * 60.0 / _traffic_mult;
    _es := _clock + make_interval(mins => COALESCE(_tmin,0)::int);
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
    IF _v.lat IS NOT NULL AND _v.lon IS NOT NULL THEN
      _cur_lat := _v.lat; _cur_lon := _v.lon;
    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.plan_route(uuid, uuid, date, boolean, text) IS
  'Computes a route ordering and returns it. Writes nothing. Shared by '
  'optimize_route_v3 (applies it) and preview_optimize (measures it), so the '
  'preview cannot drift from what Apply does.';

-- Total km along an ordered stop list, starting from the depot. Used only by
-- 2-opt's comparison, where consistency between the two sides matters more
-- than absolute accuracy — both are measured the same way.
--
-- COUPLED TO plan_route: it reads `_plan`, the temp table plan_route builds,
-- which is why `pg_temp` is on the search_path. It is callable only from
-- inside a plan_route call and will raise "relation _plan does not exist"
-- anywhere else. That is deliberate — passing forty stops' coordinates
-- through an array argument on every one of 2-opt's O(n^2) comparisons would
-- cost more than the pass saves — but it is not a general-purpose function
-- and must not be reused as one.
CREATE OR REPLACE FUNCTION public.route_segment_km(
  _ids uuid[], _start_lat double precision, _start_lon double precision
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE _total NUMERIC := 0; _lat DOUBLE PRECISION := _start_lat; _lon DOUBLE PRECISION := _start_lon; _r RECORD;
BEGIN
  FOR _r IN SELECT p.id, p.lat, p.lon FROM unnest(_ids) WITH ORDINALITY AS u(id, ord)
              JOIN _plan p ON p.id = u.id ORDER BY u.ord
  LOOP
    _total := _total + COALESCE(public.haversine_km(_lat,_lon,_r.lat,_r.lon), 0);
    IF _r.lat IS NOT NULL THEN _lat := _r.lat; _lon := _r.lon; END IF;
  END LOOP;
  RETURN _total;
END;
$$;

-- ── What the day costs as it stands ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.route_cost_current(
  _org_id uuid, _staff_id uuid, _day date
)
RETURNS TABLE (stops integer, minutes numeric, sequenced boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _lat DOUBLE PRECISION; _lon DOUBLE PRECISION;
  _speed NUMERIC; _traffic TEXT; _mult NUMERIC;
  _total NUMERIC := 0; _n INT := 0; _unseq INT := 0; _r RECORD;
BEGIN
  IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT start_latitude, start_longitude INTO _lat, _lon FROM public.staff WHERE id = _staff_id;
  SELECT avg_speed_kmh, traffic_profile INTO _speed, _traffic
    FROM public.organizations WHERE id = _org_id;
  _mult := CASE _traffic WHEN 'light' THEN 1.15 WHEN 'heavy' THEN 0.7 ELSE 1.0 END;

  FOR _r IN
    SELECT v.id, v.sequence, p.latitude AS lat, p.longitude AS lon
      FROM public.visits v
      LEFT JOIN public.properties p ON p.id = v.property_id
     WHERE v.organization_id = _org_id
       AND v.assigned_staff_id = _staff_id
       AND v.scheduled_on = _day
       AND v.status = 'scheduled'
     -- Insertion order for the unsequenced tail, which is what the board
     -- actually shows them in.
     ORDER BY v.sequence NULLS LAST, v.created_at
  LOOP
    _n := _n + 1;
    IF _r.sequence IS NULL THEN _unseq := _unseq + 1; END IF;
    _total := _total + COALESCE(public.haversine_km(_lat,_lon,_r.lat,_r.lon), 0);
    IF _r.lat IS NOT NULL THEN _lat := _r.lat; _lon := _r.lon; END IF;
  END LOOP;

  stops := _n;
  minutes := ROUND((_total / NULLIF(_speed,0)) * 60.0 / _mult, 1);
  -- FALSE when any stop lacks a sequence. The caller must not present a
  -- "time saved" against an unsequenced day: that is not a route, it is a bag
  -- of visits in insertion order, and the difference is fiction.
  sequenced := (_n > 0 AND _unseq = 0);
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.route_cost_current(uuid, uuid, date) IS
  'Travel minutes along the CURRENT sequence. `sequenced` is false when any '
  'stop is unordered — callers must then report "new route" rather than a '
  'saving, because there is no prior route to have saved anything against.';

-- ── Preview: measure without touching anything ────────────────────────────

CREATE OR REPLACE FUNCTION public.preview_optimize(
  _org_id    uuid,
  _staff_ids uuid[],
  _from      date,
  _to        date,
  _level     text DEFAULT 'balanced',
  _reassign  boolean DEFAULT false
)
RETURNS TABLE (
  staff_id uuid, day date, stops integer,
  before_min numeric, after_min numeric, before_known boolean,
  violations integer
)
LANGUAGE plpgsql
-- VOLATILE for the same reason plan_route is: it calls it. Still read-only
-- with respect to visits, which is the property that matters here.
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE _s uuid; _d date; _cur RECORD; _after NUMERIC; _n INT; _viol INT;
BEGIN
  IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _to < _from THEN RAISE EXCEPTION 'End date is before start date'; END IF;
  -- 31 days x N techs of greedy-plus-2-opt inside one request is already
  -- generous; beyond that the preview stops being interactive.
  IF _to - _from > 30 THEN RAISE EXCEPTION 'Preview covers at most 31 days'; END IF;

  FOREACH _s IN ARRAY _staff_ids LOOP
    _d := _from;
    WHILE _d <= _to LOOP
      -- Skip days the tech is away. Planning a route for somebody on leave
      -- would produce a preview whose Apply the trigger then refuses.
      IF NOT public.is_staff_off(_s, _d) THEN
        SELECT * INTO _cur FROM public.route_cost_current(_org_id, _s, _d);
        SELECT COALESCE(SUM(p.travel_min),0), COUNT(*), COALESCE(SUM(CASE WHEN p.window_violated THEN 1 ELSE 0 END),0)
          INTO _after, _n, _viol
          FROM public.plan_route(_org_id, _s, _d, _reassign, _level) p;

        IF _n > 0 THEN
          staff_id := _s; day := _d; stops := _n;
          before_min := ROUND(_cur.minutes, 1);
          after_min := ROUND(_after, 1);
          before_known := _cur.sequenced;
          violations := _viol;
          RETURN NEXT;
        END IF;
      END IF;
      _d := _d + 1;
    END LOOP;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.preview_optimize(uuid, uuid[], date, date, text, boolean) IS
  'Per tech per day: stops, current travel minutes, planned travel minutes. '
  'Writes nothing. `before_known` false means the day was not fully sequenced '
  'and no saving should be shown. Skips days the tech has booked off.';

-- ── Apply: the same plan, written ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.optimize_route_v3(
  _org_id uuid, _staff_id uuid, _day date,
  _reassign boolean DEFAULT false, _level text DEFAULT 'balanced'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE _n INT := 0; _p RECORD;
BEGIN
  IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  -- Both existing guards, in the order the rest of the codebase uses them:
  -- eligibility first, then availability, so "doesn't run routes" wins over
  -- "is away" for somebody who is both.
  PERFORM public.assert_runs_routes(_staff_id);
  PERFORM public.assert_available_on(_staff_id, _day);

  FOR _p IN SELECT * FROM public.plan_route(_org_id, _staff_id, _day, _reassign, _level) LOOP
    UPDATE public.visits
       SET assigned_staff_id = _staff_id,
           sequence          = _p.seq,
           eta_start         = _p.eta_start,
           eta_end           = _p.eta_end,
           travel_km         = _p.travel_km,
           travel_min        = _p.travel_min,
           window_violated   = _p.window_violated,
           updated_at        = now()
     WHERE id = _p.visit_id;
    _n := _n + 1;
  END LOOP;
  RETURN _n;
END;
$$;

COMMENT ON FUNCTION public.optimize_route_v3(uuid, uuid, date, boolean, text) IS
  'Applies plan_route''s ordering. Same planner the preview measured, so the '
  'two cannot disagree.';

GRANT EXECUTE ON FUNCTION public.plan_route(uuid, uuid, date, boolean, text)               TO authenticated;
GRANT EXECUTE ON FUNCTION public.route_segment_km(uuid[], double precision, double precision) TO authenticated;
GRANT EXECUTE ON FUNCTION public.route_cost_current(uuid, uuid, date)                      TO authenticated;
GRANT EXECUTE ON FUNCTION public.preview_optimize(uuid, uuid[], date, date, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.optimize_route_v3(uuid, uuid, date, boolean, text)        TO authenticated;
