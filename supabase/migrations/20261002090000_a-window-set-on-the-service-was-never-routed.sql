-- A window set on the service was never routed.
--
-- Since 20260716150000 the app writes a customer's arrival window on the
-- SUBSCRIPTION ("the window belongs to the service, not the property"; the
-- service form in ServicesTab is the only place a person can set one), and
-- every screen that shows a window reads the subscription's first. The
-- planner never moved with it. plan_visits -- the solver behind auto-routing
-- -- and plan_route both read properties.earliest_service_time /
-- latest_service_time, the legacy columns nothing in the app writes any more.
--
-- So every window entered since July was invisible to routing: no penalty for
-- arriving late, no waiting for an earliest time, and window_violated never
-- set, so the "N stops still miss their arrival window" warning could not
-- fire. Found by the routing trials (scripts/routing-trials, scenario
-- `windows`): three of four windows set on the service were missed --
-- 08:00-09:00 arrived at 13:10 -- with the forecast, the flags and the board
-- all saying zero.
--
-- ── 1. READ THE WINDOW THE APP WRITES ────────────────────────────────────
--
-- The rule is the one the screens already use (MobileDayList, VisitsTab,
-- routes.tsx): if the service carries either end of a window, the window is
-- the service's; otherwise the property's legacy pair.
--
-- ── 2. AND ORDER THE DAY BY IT ───────────────────────────────────────────
--
-- Reading the window was not enough, and the trials said so on the first run
-- after step 1. The 'thorough' pass is a 2-opt over route_segment_min, which
-- is DRIVE MINUTES ONLY. Nearest-neighbour picks the first order with a
-- lateness penalty; 2-opt then rearranges it with no idea a window exists.
-- With the window now read, the final timing pass honours an earliest time by
-- WAITING -- so a 15:00-16:00 customer that 2-opt left near the start of the
-- day parked the truck from 08:29 until 15:00, and the 10:00-10:30 customer
-- behind it was reached at 18:54. Before step 1 that day ended at 12:31 with
-- every window silently missed; after step 1 alone, at 19:02 with them
-- honestly flagged. Neither is a plan.
--
-- So on a day that has any window, 2-opt now minimises the day as it will be
-- DRIVEN: route_timeline_cost replays the clock -- each leg, the wait for an
-- earliest time, the service -- and adds a minute for every minute late plus
-- 30 per late stop, the same 30 the nearest-neighbour step already charges.
-- On a day with no window it is the drive plus a constant, so the order is
-- the one route_segment_min picks and the faster function is still used.
--
-- Everything is spliced by name, and raises if a body is not the one this
-- was cut against rather than silently doing nothing.
--
-- Replays into an empty database: both planners exist by this point in the
-- sequence, the new function reads only the planners' own temp tables, and
-- nothing needs a row.

CREATE OR REPLACE FUNCTION public.route_timeline_cost(_ids uuid[], _start_min numeric)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
-- Minutes from the workday start to the end of the day as it would be
-- driven in this order, plus lateness. Reads the caller's _plan and _legs
-- temp tables, exactly as route_segment_min reads _legs. The clock is minutes
-- past local midnight, which is what a TIME window is measured in.
DECLARE
  _clock numeric := _start_min;
  _late numeric := 0;
  _late_stops int := 0;
  _prev uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  _END constant uuid := 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid;
  _r record;
  _e numeric;
  _l numeric;
BEGIN
  FOR _r IN
    SELECT u.id, p.duration_min, p.earliest, p.latest
      FROM unnest(_ids) WITH ORDINALITY AS u(id, ord)
      JOIN _plan p ON p.id = u.id
     ORDER BY u.ord
  LOOP
    -- Rounded per leg, because the timing pass advances its clock that way.
    _clock := _clock + round(COALESCE(
      (SELECT lg.minutes FROM _legs lg WHERE lg.from_id = _prev AND lg.to_id = _r.id), 0));
    IF _r.earliest IS NOT NULL THEN
      _e := EXTRACT(EPOCH FROM _r.earliest) / 60;
      IF _clock < _e THEN _clock := _e; END IF;
    END IF;
    IF _r.latest IS NOT NULL THEN
      _l := EXTRACT(EPOCH FROM _r.latest) / 60;
      IF _clock > _l THEN
        _late := _late + (_clock - _l);
        _late_stops := _late_stops + 1;
      END IF;
    END IF;
    _clock := _clock + COALESCE(_r.duration_min, 8);
    _prev := _r.id;
  END LOOP;

  -- The leg home, as in route_segment_min.
  _clock := _clock + COALESCE(
    (SELECT lg.minutes FROM _legs lg WHERE lg.from_id = _prev AND lg.to_id = _END), 0);

  RETURN (_clock - _start_min) + _late + 30 * _late_stops;
END;
$function$;

REVOKE ALL ON FUNCTION public.route_timeline_cost(uuid[], numeric) FROM PUBLIC, anon, authenticated;

DO $splice$
DECLARE
  _i int;
  _fn regprocedure;
  _def text;
  _new text;
  _step text;
BEGIN
  -- Two named functions, each passed to pg_get_functiondef as a
  -- regprocedure literal: never a variable, never a set.
  FOR _i IN 1 .. 2 LOOP
    _fn := CASE _i WHEN 1 THEN 'public.plan_visits(uuid,uuid,date,uuid[],text)'::regprocedure
                   ELSE 'public.plan_route(uuid,uuid,date,boolean,text)'::regprocedure END;
    _def := pg_get_functiondef(CASE _i WHEN 1 THEN 'public.plan_visits(uuid,uuid,date,uuid[],text)'::regprocedure
                                       ELSE 'public.plan_route(uuid,uuid,date,boolean,text)'::regprocedure END);
    IF strpos(_def, 's.latest_time') > 0 THEN
      CONTINUE;  -- already spliced
    END IF;

    -- 1. The window, from the service first.
    _step := 'reads its arrival window';
    _new := replace(_def,
      E'         p.earliest_service_time, p.latest_service_time,\n',
      E'         CASE WHEN s.earliest_time IS NOT NULL OR s.latest_time IS NOT NULL\n'
      || E'              THEN s.earliest_time ELSE p.earliest_service_time END,\n'
      || E'         CASE WHEN s.earliest_time IS NOT NULL OR s.latest_time IS NOT NULL\n'
      || E'              THEN s.latest_time ELSE p.latest_service_time END,\n');
    IF _new = _def THEN
      RAISE EXCEPTION '% no longer % the way this splice expects; re-cut it against the current body.', _fn, _step;
    END IF;
    _def := _new;

    -- 2. Two variables for the 2-opt to know which cost to use.
    _step := 'declares its timing variables';
    _new := replace(_def,
      E'  _earliest_ts TIMESTAMPTZ; _latest_ts TIMESTAMPTZ;\n',
      E'  _earliest_ts TIMESTAMPTZ; _latest_ts TIMESTAMPTZ;\n'
      || E'  _windows BOOLEAN; _ws NUMERIC;\n');
    IF _new = _def THEN
      RAISE EXCEPTION '% no longer % the way this splice expects; re-cut it against the current body.', _fn, _step;
    END IF;
    _def := _new;

    -- 3. The 2-opt's starting cost.
    _step := 'starts its 2-opt';
    _new := replace(_def,
      E'  IF _level = ''thorough'' AND COALESCE(array_length(_order,1),0) > 3 THEN\n'
      || E'    _base := public.route_segment_min(_order);\n',
      E'  -- A day with a window is ordered by the day as driven, waits and\n'
      || E'  -- lateness included; a day without one by drive time alone.\n'
      || E'  _windows := EXISTS (SELECT 1 FROM _plan w WHERE w.earliest IS NOT NULL OR w.latest IS NOT NULL);\n'
      || E'  _ws := EXTRACT(EPOCH FROM COALESCE(_workday_start, TIME ''08:00'')) / 60;\n'
      || E'  IF _level = ''thorough'' AND COALESCE(array_length(_order,1),0) > 3 THEN\n'
      || E'    _base := CASE WHEN _windows THEN public.route_timeline_cost(_order, _ws)\n'
      || E'                  ELSE public.route_segment_min(_order) END;\n');
    IF _new = _def THEN
      RAISE EXCEPTION '% no longer % the way this splice expects; re-cut it against the current body.', _fn, _step;
    END IF;
    _def := _new;

    -- 4. And every candidate it weighs.
    _step := 'costs its 2-opt candidates';
    _new := replace(_def,
      E'          _cand_min := public.route_segment_min(_cand);\n',
      E'          _cand_min := CASE WHEN _windows THEN public.route_timeline_cost(_cand, _ws)\n'
      || E'                            ELSE public.route_segment_min(_cand) END;\n');
    IF _new = _def THEN
      RAISE EXCEPTION '% no longer % the way this splice expects; re-cut it against the current body.', _fn, _step;
    END IF;

    EXECUTE _new;
  END LOOP;
END
$splice$;

DO $check$
DECLARE
  _src text;
  _fn regprocedure;
BEGIN
  FOREACH _fn IN ARRAY ARRAY[
    'public.plan_visits(uuid,uuid,date,uuid[],text)'::regprocedure,
    'public.plan_route(uuid,uuid,date,boolean,text)'::regprocedure
  ] LOOP
    SELECT prosrc INTO _src FROM pg_proc WHERE oid = _fn;
    IF strpos(_src, 'THEN s.earliest_time ELSE p.earliest_service_time END') = 0
       OR strpos(_src, 'THEN s.latest_time ELSE p.latest_service_time END') = 0 THEN
      RAISE EXCEPTION '% still ignores the arrival window set on the service', _fn;
    END IF;
    IF (length(_src) - length(replace(_src, 'public.route_timeline_cost(', '')))
         / length('public.route_timeline_cost(') <> 2 THEN
      RAISE EXCEPTION '% does not order a day with windows by its timeline', _fn;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.route_timeline_cost(uuid[], numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can call route_timeline_cost';
  END IF;
END
$check$;
