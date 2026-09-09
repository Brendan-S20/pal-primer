-- The route ended wherever the last stop happened to be.
--
-- ── WHAT WAS ALREADY THERE, AND IGNORED ──────────────────────────────────
--
-- `staff.end_latitude` / `end_longitude` have existed since 20260703042557.
-- Settings collects them under a field labelled "Route end (dump, home, shop)"
-- with the placeholder "Landfill or home address"; StaffRoutingDialog collects
-- them too; both show the stored pin back as "Pinned: 42.4726, -83.1255"; and
-- RouteMap.tsx:930 reads them and draws the end marker.
--
-- The solver has never once looked at them. `plan_route` resolves a START
-- through staff_start_point and then plans an OPEN PATH: start, every stop,
-- stop. There is no closing leg in the objective, so the last stop of the day
-- is chosen as though the technician evaporates on arrival.
--
-- So the owner types in the dump address, watches the map draw a marker for it,
-- and gets a route that has never heard of it. That is the whole of this
-- change: the field is real, the map is honest, the objective was not.
--
-- ── AND WHERE THE FALLBACK COMES FROM ────────────────────────────────────
--
-- `waste_disposal_facilities` already exists, with `latitude`, `longitude`,
-- `active` and a name, geocoded by the nightly hook. It is the table behind the
-- waste log and the disposal manifests. For a pet waste business the end of the
-- day is the dump, so when a technician has no end address of their own that is
-- the right default, and it is already in the database.
--
-- Measured against production on 2026-08-31, which is why the fallback matters
-- more than the field:
--
--   7 field technicians      2 with a start point      2 with an end point
--   6 organizations          1 disposal facility       0 of them geocoded
--
-- Five of seven technicians have no end address, and no organization has a
-- usable dump site either. A feature that only works when somebody fills in a
-- form nobody knows to fill in is not a feature yet, which is the argument for
-- the onboarding step that ships alongside this.
--
-- ── WHAT AN END POINT ACTUALLY CHANGES ───────────────────────────────────
--
-- The problem stops being an open path and becomes a fixed-end one. The last
-- stop now has a cost attached to it -- how far it is from the dump -- so the
-- order that was cheapest when the day just stopped is no longer the order that
-- is cheapest when the technician has to drive home afterwards.
--
-- It reaches the answer through the 2-opt, which is where a closing leg can
-- change a decision, and that pass runs only at `thorough`. That is the level
-- the app always sends: AutoRoutingPanel pins `const LEVEL = "thorough"` and
-- there is no control to change it. At `fast` or `balanced` the end point is
-- costed but cannot reorder anything, and that is worth knowing before anyone
-- tests through a different caller.
--
-- Unfreezing the tail in 20260831130000 matters more here than it did there.
-- With an open path, reversing a segment that ends at the last stop changed one
-- edge. With a fixed end it changes two, so the move this planner could not
-- reach until yesterday is exactly the move a dump site makes valuable.
--
-- ── WHAT IS NOT REPORTED, SAID OUT LOUD ──────────────────────────────────
--
-- `plan_route` returns one row per VISIT. The drive from the last stop to the
-- dump is not a visit and gets no row, so it is counted in the objective and
-- absent from the reported per-stop `travel_min`, and from the `total_min` that
-- plan_day_across_staff sums out of those rows.
--
-- The alternative is worse. Folding it into the last visit's `travel_min` would
-- state that the drive TO that stop took a time that includes a drive AFTER it,
-- which is the exact species of incoherence 20260831130000 was written to
-- remove -- a number labelled as one thing carrying another. So the closing leg
-- steers the route and is not reported, and this comment is where that is
-- written down rather than discovered.

-- Where the technician's day ends. The twin of staff_start_point, and
-- deliberately NOT taking a visit list: start has a last-resort tier that
-- borrows the day's first stop, and there is no equivalent worth having here.
-- A day with no end point is an open path, which is what every day is today.
CREATE OR REPLACE FUNCTION public.staff_end_point(_org_id uuid, _staff_id uuid)
RETURNS TABLE(lat double precision, lon double precision)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE _lat double precision; _lon double precision;
BEGIN
  -- 1. What the technician's own record says.
  SELECT s.end_latitude, s.end_longitude INTO _lat, _lon
    FROM public.staff s
   WHERE s.id = _staff_id AND s.organization_id = _org_id;
  IF _lat IS NOT NULL AND _lon IS NOT NULL THEN
    RETURN QUERY SELECT _lat, _lon; RETURN;
  END IF;

  -- 2. The dump. Nearest to where they START, which is stable: picking the one
  --    nearest the LAST STOP would depend on the order, and the order is what
  --    this is being used to choose. Most organizations will have exactly one,
  --    and then the ordering does not arise at all.
  SELECT f.latitude, f.longitude INTO _lat, _lon
    FROM public.waste_disposal_facilities f
    LEFT JOIN public.staff s ON s.id = _staff_id
   WHERE f.organization_id = _org_id
     AND f.active
     AND f.latitude IS NOT NULL AND f.longitude IS NOT NULL
   ORDER BY COALESCE(
              public.haversine_km(s.start_latitude, s.start_longitude, f.latitude, f.longitude),
              9999) ASC,
            f.name, f.id
   LIMIT 1;
  IF _lat IS NOT NULL AND _lon IS NOT NULL THEN
    RETURN QUERY SELECT _lat, _lon; RETURN;
  END IF;

  -- 3. Nothing. The caller plans an open path, exactly as before this file.
  RETURN;
END;
$fn$;

-- Internal to the solver, like road_km and route_segment_min: SECURITY DEFINER,
-- takes an _org_id, never asks who is calling. Closed rather than granted.
REVOKE ALL ON FUNCTION public.staff_end_point(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_end_point(uuid, uuid) TO service_role;

-- Now closes the path. The END sentinel row exists in `_legs` only when an end
-- point resolved, so this adds 0 for every org that has none and the open-path
-- behaviour is bit-identical to 20260831130000.
CREATE OR REPLACE FUNCTION public.route_segment_min(_ids uuid[])
RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE
  _total numeric := 0;
  _prev uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  _END  CONSTANT uuid := 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid;
  _r RECORD;
BEGIN
  FOR _r IN SELECT u.id FROM unnest(_ids) WITH ORDINALITY AS u(id, ord) ORDER BY u.ord
  LOOP
    _total := _total + COALESCE(
      (SELECT lg.minutes FROM _legs lg WHERE lg.from_id = _prev AND lg.to_id = _r.id), 0);
    _prev := _r.id;
  END LOOP;

  -- The leg home, which is what makes this a fixed-end path and not an open
  -- one. Without it the last stop is free wherever it lands.
  _total := _total + COALESCE(
    (SELECT lg.minutes FROM _legs lg WHERE lg.from_id = _prev AND lg.to_id = _END), 0);

  RETURN _total;
END;
$fn$;

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
  _end_lat DOUBLE PRECISION; _end_lon DOUBLE PRECISION;
  _START CONSTANT UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  _END   CONSTANT UUID := 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid;
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
  SELECT ep.lat, ep.lon INTO _end_lat, _end_lon
    FROM public.staff_end_point(_org_id, _staff_id) ep;
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
  IF to_regprocedure('public.staff_end_point(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'staff_end_point is missing after this migration';
  END IF;

  -- Both solvers close the path, or neither does. One of two would be the
  -- Apply/Preview divergence the splice exists to prevent.
  SELECT count(*) INTO _n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('plan_route','plan_visits')
     AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') LIKE '%staff_end_point%';
  IF _n <> 2 THEN
    RAISE EXCEPTION 'expected both plan_route and plan_visits to resolve an end point, found %', _n;
  END IF;

  -- And the closing leg is actually scored, not merely resolved.
  SELECT count(*) INTO _n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'route_segment_min'
     AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') LIKE '%ffffffff-ffff-ffff-ffff-ffffffffffff%';
  IF _n = 0 THEN
    RAISE EXCEPTION 'route_segment_min does not add the closing leg';
  END IF;
END;
$post$;
