-- Auto-routing gave the whole day to one technician.
--
-- Owner report, 2026-08-15: "I am attempting to utilize the functions with 3
-- techs; it doesn't split the route, it assigns it all to one."
--
-- ── WHY, AND IT IS NOT A UI SLIP ──────────────────────────────────────────
--
-- Every planning entry point this database has takes ONE technician:
--
--   plan_route(_org_id, _staff_id uuid, _day, _reassign, _level)
--   optimize_route_v3(_org_id, _staff_id uuid, _day, _reassign, _level)
--   assign_route_for_day(_org_id, _staff_id uuid, _day, _reassign)
--
-- and each of them selects the candidate visits like this:
--
--   WHERE v.organization_id = _org_id AND v.scheduled_on = _day
--     AND v.status = 'scheduled'
--     AND (_reassign OR v.assigned_staff_id IS NULL
--                    OR v.assigned_staff_id = _staff_id)
--
-- which is the WHOLE DAY for the WHOLE ORGANISATION. The solver is single
-- vehicle by design — nearest neighbour on drive time, with time-window and
-- morning/afternoon penalties and a 2-opt pass at 'thorough'. It is a decent
-- solver. Nothing anywhere divides work BETWEEN technicians.
--
-- So selecting three technicians runs three independent single-vehicle solves,
-- each claiming the entire day:
--
--   _reassign = true   the technician processed LAST ends up with everything
--   _reassign = false  the FIRST takes everything, the other two find nothing
--
-- Either way one technician gets the lot, which is exactly what was reported,
-- and re-running never helps. `preview_optimize` is the only entry point that
-- accepts `_staff_ids uuid[]`, and it loops them calling plan_route once per
-- technician — so even the PREVIEW shows each of the three the whole day.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────
--
-- The missing step: partition the day across the selected technicians, then
-- hand each partition to the existing per-technician solver. The solver did
-- not need replacing; it needed to be given a third of the stops.
--
--   1. SWEEP the visits into k geographically compact clusters. Ordering by
--      bearing around the day's centroid and cutting the ring into arcs is the
--      classic vehicle-routing sweep, and it is chosen here because a cluster
--      that is compact on the map is what makes each technician's own route
--      short. The ring is rotated to start at the widest angular gap, so the
--      cut falls in empty space rather than through the middle of a
--      neighbourhood.
--
--   2. SIZE the arcs by each technician's share of capacity, not by 1/k.
--      `staff.daily_capacity_minutes` already exists; somebody on a six-hour
--      day gets proportionally fewer stops than somebody on a nine-hour day,
--      and work already on their calendar counts against their share.
--
--   3. MATCH clusters to technicians by start location. `staff` carries
--      start_latitude/start_longitude, so the cluster nearest somebody's home
--      is the one they get. Largest cluster is placed first, since it is the
--      one with least freedom.
--
--   4. SEQUENCE each technician's cluster with plan_route, unchanged.
--
--   5. REBALANCE on measured minutes. Owner call, 2026-08-15: even means EQUAL
--      WORKING TIME — service plus drive — not equal stop count. That cannot
--      be settled by the sweep alone, because the sweep only knows service
--      minutes; drive time is not known until a cluster has been sequenced,
--      and it is the larger variable. So after sequencing, the busiest
--      technician hands its most transferable visit to the quietest, both are
--      re-sequenced, and the move is KEPT ONLY IF the spread actually fell.
--      Up to eight moves, then it stops. A move that does not help is undone,
--      so this cannot wander.
--
-- ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────
--
-- It does not touch a visit assigned to somebody who is NOT in the selected
-- set, even with _reassign. Somebody on leave, or a technician the dispatcher
-- left out on purpose, keeps their work. `_reassign` is the dispatcher's
-- choice of whether to disturb assignments among the SELECTED technicians —
-- owner call: both are offered as separate controls rather than one of them
-- being assumed.
--
-- It is a heuristic, not an optimum. Vehicle routing with time windows is
-- NP-hard and this runs inside a request. Sweep + per-cluster 2-opt +
-- measured rebalancing is the honest description.

CREATE OR REPLACE FUNCTION public.plan_day_across_staff(
  _org_id uuid,
  _staff_ids uuid[],
  _day date,
  _reassign boolean DEFAULT false,
  _level text DEFAULT 'balanced'
)
RETURNS TABLE(
  staff_id uuid,
  stops integer,
  service_min numeric,
  travel_min numeric,
  total_min numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _eligible uuid[] := '{}';
  _k int;
  _s uuid;
  _cy double precision; _cx double precision;
  _gap_start double precision;
  _total_service numeric;
  _cap_total numeric;
  _p record;
  _seq int;
  _pass int := 0;
  _hi uuid; _lo uuid;
  _spread numeric; _new_spread numeric;
  _move_id uuid;
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

  -- Eligible, with the reason stated rather than silently dropping people:
  -- routing someone who is off, or who is not set up to run routes, is how a
  -- day silently lands on the wrong person.
  SELECT array_agg(s.id ORDER BY s.id) INTO _eligible
    FROM public.staff s
   WHERE s.organization_id = _org_id
     AND s.id = ANY(_staff_ids)
     AND COALESCE(s.active, true)
     AND COALESCE(s.is_field_tech, false)
     AND COALESCE(s.routing_available, true)
     AND NOT public.is_staff_off(s.id, _day);

  _k := COALESCE(array_length(_eligible, 1), 0);
  IF _k = 0 THEN
    RAISE EXCEPTION 'None of the selected people can be routed on %: check "Runs routes" and time off', _day;
  END IF;

  -- ── The work to divide ──────────────────────────────────────────────────
  CREATE TEMP TABLE IF NOT EXISTS _grp (
    id uuid PRIMARY KEY,
    lat double precision,
    lon double precision,
    svc_min numeric,
    ang double precision,
    cluster int
  ) ON COMMIT DROP;
  DELETE FROM _grp WHERE true;

  INSERT INTO _grp (id, lat, lon, svc_min)
  SELECT v.id, p.latitude, p.longitude, COALESCE(p.service_duration_min, 8)
    FROM public.visits v
    LEFT JOIN public.properties p ON p.id = v.property_id
   WHERE v.organization_id = _org_id
     AND v.scheduled_on = _day
     AND v.status = 'scheduled'
     AND (
       CASE WHEN _reassign
            -- Only among the SELECTED technicians. Somebody left out keeps
            -- their work; this is a re-plan of these people's day, not a
            -- repossession of everybody's.
            THEN v.assigned_staff_id IS NULL OR v.assigned_staff_id = ANY(_eligible)
            ELSE v.assigned_staff_id IS NULL
       END
     );

  IF NOT EXISTS (SELECT 1 FROM _grp) THEN
    -- Not an error: "nothing to do" is a normal answer, and the caller still
    -- gets each technician's current load back.
    RETURN QUERY
      SELECT e.s, c.stops, 0::numeric, c.minutes, c.minutes
        FROM unnest(_eligible) AS e(s),
             LATERAL public.route_cost_current(_org_id, e.s, _day) c;
    RETURN;
  END IF;

  -- ── 1. Sweep order, cut at the widest gap ───────────────────────────────
  SELECT avg(lat), avg(lon) INTO _cy, _cx FROM _grp WHERE lat IS NOT NULL;

  -- A visit with no coordinates cannot be swept. It still has to go somewhere,
  -- so it is parked at the centroid and lands with whichever arc covers it —
  -- visible in the result rather than dropped on the floor.
  UPDATE _grp SET ang = atan2(COALESCE(lat, _cy) - _cy, COALESCE(lon, _cx) - _cx);

  SELECT COALESCE(
           (SELECT ang FROM (
              SELECT ang, ang - LAG(ang) OVER (ORDER BY ang) AS gap FROM _grp
            ) g WHERE g.gap IS NOT NULL ORDER BY g.gap DESC LIMIT 1),
           (SELECT min(ang) FROM _grp))
    INTO _gap_start;

  -- Rotate so the sweep begins just after the widest empty wedge.
  UPDATE _grp
     SET ang = CASE WHEN ang - _gap_start < 0
                    THEN ang - _gap_start + 2 * pi()
                    ELSE ang - _gap_start END;

  -- ── 2. Arc sizes from capacity, less what is already booked ─────────────
  SELECT sum(g.svc_min) INTO _total_service FROM _grp g;

  CREATE TEMP TABLE IF NOT EXISTS _share (
    ord int, sid uuid, capacity numeric, upto numeric, cluster_lat double precision, cluster_lon double precision
  ) ON COMMIT DROP;
  DELETE FROM _share WHERE true;

  INSERT INTO _share (ord, sid, capacity)
  SELECT row_number() OVER (ORDER BY e.s), e.s,
         GREATEST(
           COALESCE(st.daily_capacity_minutes, 480)
             - COALESCE((SELECT c.minutes FROM public.route_cost_current(_org_id, e.s, _day) c), 0),
           30)
    FROM unnest(_eligible) AS e(s)
    JOIN public.staff st ON st.id = e.s;

  SELECT sum(capacity) INTO _cap_total FROM _share;

  UPDATE _share sh
     SET upto = x.running
    FROM (
      SELECT ord, _total_service * (SUM(capacity) OVER (ORDER BY ord)) / NULLIF(_cap_total, 0) AS running
        FROM _share
    ) x
   WHERE x.ord = sh.ord;

  -- Cut the swept ring into those arcs.
  UPDATE _grp g
     SET cluster = COALESCE(
       (SELECT min(sh.ord) FROM _share sh WHERE sh.upto >= c.cum),
       (SELECT max(ord) FROM _share))
    FROM (
      SELECT g2.id, SUM(g2.svc_min) OVER (ORDER BY g2.ang, g2.id) AS cum FROM _grp g2
    ) c
   WHERE c.id = g.id;

  -- ── 3. Give each arc to the technician who starts nearest it ────────────
  UPDATE _share sh
     SET cluster_lat = c.lat, cluster_lon = c.lon
    FROM (SELECT cluster, avg(lat) AS lat, avg(lon) AS lon FROM _grp GROUP BY cluster) c
   WHERE c.cluster = sh.ord;

  CREATE TEMP TABLE IF NOT EXISTS _match (cluster int, sid uuid) ON COMMIT DROP;
  DELETE FROM _match WHERE true;

  FOR _p IN
    SELECT g.cluster, count(*) AS n, avg(g.lat) AS lat, avg(g.lon) AS lon
      FROM _grp g GROUP BY g.cluster ORDER BY count(*) DESC
  LOOP
    SELECT sh.sid INTO _s
      FROM _share sh
      JOIN public.staff st ON st.id = sh.sid
     WHERE sh.sid NOT IN (SELECT m.sid FROM _match m)
     ORDER BY COALESCE(
                public.haversine_km(st.start_latitude, st.start_longitude, _p.lat, _p.lon),
                9999) ASC,
              sh.sid
     LIMIT 1;
    IF _s IS NOT NULL THEN
      INSERT INTO _match (cluster, sid) VALUES (_p.cluster, _s);
    END IF;
  END LOOP;

  UPDATE public.visits v
     SET assigned_staff_id = m.sid,
         sequence = NULL,
         updated_at = now()
    FROM _grp g JOIN _match m ON m.cluster = g.cluster
   WHERE v.id = g.id;

  -- ── 4. Sequence each technician's own day, with the existing solver ─────
  FOREACH _s IN ARRAY _eligible LOOP
    _seq := 0;
    FOR _p IN SELECT * FROM public.plan_route(_org_id, _s, _day, false, _level) LOOP
      UPDATE public.visits
         SET sequence        = _p.seq,
             eta_start       = _p.eta_start,
             eta_end         = _p.eta_end,
             travel_km       = _p.travel_km,
             travel_min      = _p.travel_min,
             window_violated = _p.window_violated,
             updated_at      = now()
       WHERE id = _p.visit_id;
    END LOOP;
  END LOOP;

  -- ── 5. Even out the MEASURED minutes ────────────────────────────────────
  --
  -- The sweep balanced service time. Drive time is the bigger variable and is
  -- only knowable once a cluster has been sequenced, so the balancing that the
  -- owner actually asked for happens here, on measured numbers.
  LOOP
    _pass := _pass + 1;
    EXIT WHEN _pass > 8;

    SELECT max(t) - min(t) INTO _spread FROM (
      SELECT public.staff_day_minutes(_org_id, s, _day) AS t FROM unnest(_eligible) AS e(s)
    ) q;
    -- Ten minutes apart is even enough; chasing further just churns routes.
    EXIT WHEN _spread IS NULL OR _spread <= 10;

    SELECT s INTO _hi FROM unnest(_eligible) AS e(s)
     ORDER BY public.staff_day_minutes(_org_id, s, _day) DESC LIMIT 1;
    SELECT s INTO _lo FROM unnest(_eligible) AS e(s)
     ORDER BY public.staff_day_minutes(_org_id, s, _day) ASC LIMIT 1;
    EXIT WHEN _hi IS NULL OR _lo IS NULL OR _hi = _lo;

    -- The most transferable visit: the one on the busiest route that sits
    -- closest to where the quietest technician is already working.
    SELECT v.id INTO _move_id
      FROM public.visits v
      LEFT JOIN public.properties p ON p.id = v.property_id
     WHERE v.organization_id = _org_id
       AND v.scheduled_on = _day
       AND v.status = 'scheduled'
       AND v.assigned_staff_id = _hi
     ORDER BY COALESCE(
                public.haversine_km(
                  p.latitude, p.longitude,
                  (SELECT avg(p2.latitude) FROM public.visits v2
                     JOIN public.properties p2 ON p2.id = v2.property_id
                    WHERE v2.assigned_staff_id = _lo AND v2.scheduled_on = _day
                      AND v2.status = 'scheduled'),
                  (SELECT avg(p2.longitude) FROM public.visits v2
                     JOIN public.properties p2 ON p2.id = v2.property_id
                    WHERE v2.assigned_staff_id = _lo AND v2.scheduled_on = _day
                      AND v2.status = 'scheduled')),
                9999) ASC
     LIMIT 1;
    EXIT WHEN _move_id IS NULL;

    UPDATE public.visits SET assigned_staff_id = _lo WHERE id = _move_id;
    PERFORM public.resequence_staff_day(_org_id, _hi, _day, _level);
    PERFORM public.resequence_staff_day(_org_id, _lo, _day, _level);

    SELECT max(t) - min(t) INTO _new_spread FROM (
      SELECT public.staff_day_minutes(_org_id, s, _day) AS t FROM unnest(_eligible) AS e(s)
    ) q;

    -- Undo a move that did not help, and stop. Without this the loop can
    -- hand the same visit back and forth for eight passes.
    IF _new_spread >= _spread THEN
      UPDATE public.visits SET assigned_staff_id = _hi WHERE id = _move_id;
      PERFORM public.resequence_staff_day(_org_id, _hi, _day, _level);
      PERFORM public.resequence_staff_day(_org_id, _lo, _day, _level);
      EXIT;
    END IF;
  END LOOP;

  RETURN QUERY
    SELECT e.s,
           COUNT(v.id)::int,
           ROUND(COALESCE(SUM(COALESCE(p.service_duration_min, 8)), 0), 1),
           ROUND(COALESCE(SUM(v.travel_min), 0), 1),
           ROUND(COALESCE(SUM(COALESCE(p.service_duration_min, 8)), 0)
                 + COALESCE(SUM(v.travel_min), 0), 1)
      FROM unnest(_eligible) AS e(s)
      LEFT JOIN public.visits v
             ON v.assigned_staff_id = e.s
            AND v.scheduled_on = _day
            AND v.status = 'scheduled'
            AND v.organization_id = _org_id
      LEFT JOIN public.properties p ON p.id = v.property_id
     GROUP BY e.s
     ORDER BY e.s;
END;
$function$;

-- ── Two helpers the rebalancing loop needs ────────────────────────────────
--
-- Both exist so the loop above reads as what it is. staff_day_minutes is the
-- measure being equalised: service plus drive, from what is actually stored on
-- the visits after sequencing.
CREATE OR REPLACE FUNCTION public.staff_day_minutes(_org_id uuid, _staff_id uuid, _day date)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(SUM(COALESCE(p.service_duration_min, 8) + COALESCE(v.travel_min, 0)), 0)
    FROM public.visits v
    LEFT JOIN public.properties p ON p.id = v.property_id
   WHERE v.organization_id = _org_id
     AND v.assigned_staff_id = _staff_id
     AND v.scheduled_on = _day
     AND v.status = 'scheduled';
$function$;

CREATE OR REPLACE FUNCTION public.resequence_staff_day(
  _org_id uuid, _staff_id uuid, _day date, _level text DEFAULT 'balanced'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE _p record; _n int := 0;
BEGIN
  FOR _p IN SELECT * FROM public.plan_route(_org_id, _staff_id, _day, false, _level) LOOP
    UPDATE public.visits
       SET sequence        = _p.seq,
           eta_start       = _p.eta_start,
           eta_end         = _p.eta_end,
           travel_km       = _p.travel_km,
           travel_min      = _p.travel_min,
           window_violated = _p.window_violated,
           updated_at      = now()
     WHERE id = _p.visit_id;
    _n := _n + 1;
  END LOOP;
  RETURN _n;
END;
$function$;

-- ── Permissions ───────────────────────────────────────────────────────────
--
-- Same shape as the single-technician planners: office callers only, enforced
-- inside by can_write_org, and never reachable by anon. The two helpers are
-- internal to the planner and are not granted to authenticated at all.
REVOKE ALL ON FUNCTION public.plan_day_across_staff(uuid, uuid[], date, boolean, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.plan_day_across_staff(uuid, uuid[], date, boolean, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.staff_day_minutes(uuid, uuid, date) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_day_minutes(uuid, uuid, date) TO service_role;

REVOKE ALL ON FUNCTION public.resequence_staff_day(uuid, uuid, date, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resequence_staff_day(uuid, uuid, date, text) TO service_role;
