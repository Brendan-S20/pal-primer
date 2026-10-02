-- A stop with no location hid the drive around it.
--
-- A visit whose property never geocoded has NULL coordinates. Every leg to or
-- from it is NULL, and the solver costs a NULL leg as ZERO (route_segment_min
-- and the clock both COALESCE it away). Nearest-neighbour already put such a
-- stop last, but the 2-opt pass that follows minimises total minutes -- and a
-- stop that is free to reach and free to leave is worth most in the MIDDLE of
-- the longest leg of the day, where it makes that leg vanish. So 2-opt moved
-- it there.
--
-- Found by the routing trials (scripts/routing-trials, scenario `edge-cases`):
-- one un-geocoded stop was parked between two stops 40 minutes apart, the
-- 40-minute drive disappeared from the route's total and from every ETA after
-- it, and the technician was told to arrive 40 minutes before they could.
--
-- The order of the stops that DO have a location is left exactly as the
-- solver chose it; the ones that do not are moved to the end, in their own
-- order, where a zero-cost leg hides nothing. Nobody knows where they are,
-- and the end of the day is the honest place to say so.
--
-- plan_visits (auto-routing) and plan_route (the single-technician planner)
-- share the passage, and both are spliced by name. Replays into an empty
-- database: both exist by this point and neither needs a row.

DO $splice$
DECLARE
  _i int;
  _fn regprocedure;
  _def text;
  _new text;
  _anchor constant text :=
    E'  _clock := _day_start_ts;\n'
    || E'  _cur_lat := _start_lat; _cur_lon := _start_lon; _cur_id := _START;\n'
    || E'  FOREACH _picked IN ARRAY _order LOOP\n';
BEGIN
  -- Two named functions, each passed to pg_get_functiondef as a
  -- regprocedure literal: never a variable, never a set.
  FOR _i IN 1 .. 2 LOOP
    _fn := CASE _i WHEN 1 THEN 'public.plan_visits(uuid,uuid,date,uuid[],text)'::regprocedure
                   ELSE 'public.plan_route(uuid,uuid,date,boolean,text)'::regprocedure END;
    _def := pg_get_functiondef(CASE _i WHEN 1 THEN 'public.plan_visits(uuid,uuid,date,uuid[],text)'::regprocedure
                                       ELSE 'public.plan_route(uuid,uuid,date,boolean,text)'::regprocedure END);
    IF strpos(_def, 'ORDER BY (pl.lat IS NULL OR pl.lon IS NULL), u.o') > 0 THEN
      CONTINUE;  -- already spliced
    END IF;
    _new := replace(_def, _anchor,
      E'  -- Stops with no location go last: a NULL leg costs nothing, so\n'
      || E'  -- anywhere else they hide the drive around them.\n'
      || E'  _order := ARRAY(\n'
      || E'    SELECT u.x FROM unnest(_order) WITH ORDINALITY AS u(x, o)\n'
      || E'      JOIN _plan pl ON pl.id = u.x\n'
      || E'     ORDER BY (pl.lat IS NULL OR pl.lon IS NULL), u.o);\n\n'
      || _anchor);
    IF _new = _def THEN
      RAISE EXCEPTION '% no longer replays its order the way this splice expects; re-cut it against the current body.', _fn;
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
    -- Exactly once, and before the pass that writes the ETAs.
    IF (length(_src) - length(replace(_src, 'ORDER BY (pl.lat IS NULL OR pl.lon IS NULL), u.o', '')))
         / length('ORDER BY (pl.lat IS NULL OR pl.lon IS NULL), u.o') <> 1
       OR strpos(_src, 'ORDER BY (pl.lat IS NULL OR pl.lon IS NULL), u.o')
          > strpos(_src, 'FOREACH _picked IN ARRAY _order LOOP') THEN
      RAISE EXCEPTION '% does not move unlocated stops to the end before timing the day', _fn;
    END IF;
  END LOOP;
END
$check$;
