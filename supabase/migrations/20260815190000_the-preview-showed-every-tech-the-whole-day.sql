-- The preview showed every tech the whole day.
--
-- Follow-on from 20260815170000, which fixed the APPLY and left the PREVIEW
-- describing the old behaviour. The owner report that started it — "3 techs, it
-- doesn't split the route, it assigns it all to one" — is fixed on the writing
-- side. This is the reading side of the same bug, and it is worse in one
-- specific way: a wrong preview is a promise.
--
-- ── WHAT THE DISPATCHER SAW ───────────────────────────────────────────────
--
-- preview_optimize was the only entry point that ever took `_staff_ids uuid[]`,
-- and it spent the array on a loop:
--
--   FOREACH _s IN ARRAY _staff_ids LOOP
--     WHILE _d <= _to LOOP
--       ... FROM public.plan_route(_org_id, _s, _d, _reassign, _level)
--
-- plan_route's candidate set is the WHOLE ORGANISATION's day:
--
--   WHERE v.organization_id = _org_id AND v.scheduled_on = _day
--     AND v.status = 'scheduled'
--     AND (_reassign OR v.assigned_staff_id IS NULL
--                    OR v.assigned_staff_id = _staff_id)
--
-- so each technician was previewed as if they personally did every stop. Three
-- technicians on a twenty-stop day previewed as 20 / 20 / 20, and the card's
-- headline — `days.reduce((n, d) => n + d.stops)` — added them up and said
-- SIXTY stops. Apply then produced 7 / 7 / 6. The driving figures were wrong
-- the same way and in the same direction: each row measured a twenty-stop tour
-- nobody was ever going to drive, so "saves about N minutes" was computed from
-- a route that does not exist.
--
-- Nothing in the UI could have caught it. It renders what it is given.
--
-- ── WHY IT IS NOT A ONE-LINE FIX ──────────────────────────────────────────
--
-- The obvious repair is for the preview to call the thing Apply calls. It
-- cannot: `plan_day_across_staff` WRITES — assignments, sequences, ETAs — and a
-- preview that rearranges the day it was asked to describe is not a preview.
-- Pressing Preview twice would produce two different answers, and pressing it
-- once and then Cancel would have already done the work.
--
-- The second-obvious repair is for the preview to reimplement the split. That
-- is how this bug happened the first time. Two copies of a heuristic agree on
-- the day they are written and drift from then on, invisibly, because the only
-- symptom is a number nobody can check without running both.
--
-- ── WHAT THIS DOES INSTEAD: ONE PLANNER, TWO CALLERS ──────────────────────
--
-- The same shape the single-technician path has had all along, and which
-- 20260815170000 broke at the day level by putting the algorithm inside the
-- function that writes:
--
--   plan_day_across_staff_dryrun   decides the whole day for the whole team
--                                  and writes NOTHING. Sweep, capacity shares,
--                                  cluster-to-technician match, per-technician
--                                  sequencing, measured rebalancing — all of
--                                  it, entirely in temp tables.
--
--   plan_day_across_staff          calls it and writes the result. That is now
--                                  the whole of its body beyond the guards.
--
--   preview_optimize               calls it and measures the result.
--
-- So the preview does not agree with Apply by inspection or by luck. It is the
-- same code, run against the same rows, in the same transaction shape. The only
-- difference between previewing a day and applying it is one UPDATE.
--
-- Two supporting pieces are needed to make a read-only version possible at all:
--
--   plan_visits   the existing single-vehicle solver, restricted to a NAMED
--                 set of visits instead of "everything unassigned or mine".
--                 Derived from plan_route by splicing pg_get_functiondef, not
--                 retyped — see the block that builds it. Apply could restrict
--                 the solver by writing the assignments first and letting
--                 plan_route re-read them; a preview has no such trick, and
--                 giving the solver the list directly is the honest version of
--                 what Apply was doing implicitly.
--
--   staff_start_point(..., _visit_ids)   the four-argument overload. Tiers 3
--                 and 4 of the start-point chain (20260815180000) are measured
--                 against "the work this person is doing", which Apply reads
--                 out of `visits.assigned_staff_id` AFTER it has written it.
--                 With nothing written there is nothing to read, and two of the
--                 three demo technicians have no start address, so a naive
--                 preview would resolve them to 'none' — every candidate a flat
--                 5.0 km, a route from nowhere, and travel minutes that mean
--                 nothing. Passing the planned set in reproduces exactly what
--                 Apply's post-write read returns.
--
-- ── WHAT CHANGES ON SCREEN ────────────────────────────────────────────────
--
-- Stops sum to the day, not to the day times the number of technicians. And
-- with "Also move work between techs" OFF on a day where every stop is already
-- assigned, the preview now correctly returns NOTHING — because applying would
-- do nothing. It used to show one technician's whole day as though it were
-- about to be re-planned. AutoRoutingPanel's empty-state sentence was written
-- for the only case that used to reach it and is corrected alongside this.
--
-- ── ON REPLACING plan_day_across_staff ONE DAY AFTER SHIPPING IT ──────────
--
-- Deliberate, and the smaller risk of the two on offer. The alternative was a
-- second copy of the sweep, the capacity shares, the nearest-start match and
-- the eight-pass rebalance living in the preview — which is precisely the
-- failure this migration exists to repair, rebuilt on purpose.
--
-- The rewrite is behaviour-preserving by construction: the dryrun is the live
-- body of `plan_day_across_staff` with its writes replaced by temp-table
-- bookkeeping, and the writer keeps its guards, its error strings, its
-- nothing-to-do branch and its summary query unchanged. Two differences are
-- real and intended:
--
--   * the busiest/quietest pick and the transferable-visit pick now carry an
--     id tiebreaker. `ORDER BY minutes DESC LIMIT 1` over two equal rows was
--     free to return either, which is exactly the kind of coin-flip that makes
--     a preview and an apply disagree for no reason a person can see.
--   * assignments and sequences are written once, at the end, instead of
--     assignment-then-sequence-then-rebalance. Same final state, fewer writes,
--     and no window in which a day is half-planned.
--
-- Note also that the live `plan_day_across_staff` and the text of
-- 20260815170000 had already drifted cosmetically (aliases, and a dead
-- cluster_lat/cluster_lon assignment the file has and the applied function does
-- not). The dryrun below is derived from what is APPLIED, since that is what
-- produced the 7 / 7 / 6 the fix was verified on.
--
-- `staff_day_minutes` and `resequence_staff_day` are left in place. Nothing
-- calls them now — the rebalance measures its own temp rows — but they are
-- correct, granted to service_role only, and deleting a helper is not this
-- migration's business.

-- ── Who can actually be routed ────────────────────────────────────────────
--
-- Was inline in plan_day_across_staff. It is now asked in three places — the
-- writer (which raises when the answer is empty), the dryrun, and through the
-- dryrun the preview (which must NOT raise: one Tuesday when everybody is off
-- cannot be allowed to fail a thirty-one day preview) — so it is one function
-- rather than three copies of a five-line WHERE.
CREATE OR REPLACE FUNCTION public.routable_staff(_org_id uuid, _staff_ids uuid[], _day date)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT COALESCE(array_agg(s.id ORDER BY s.id), '{}'::uuid[])
    FROM public.staff s
   WHERE s.organization_id = _org_id
     AND s.id = ANY(_staff_ids)
     AND COALESCE(s.active, true)
     AND COALESCE(s.is_field_tech, false)
     AND COALESCE(s.routing_available, true)
     AND NOT public.is_staff_off(s.id, _day);
$$;

REVOKE ALL ON FUNCTION public.routable_staff(uuid, uuid[], date) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.routable_staff(uuid, uuid[], date) TO service_role;

-- ── The start-point chain, asked about a PLANNED set of visits ────────────
--
-- Identical to the three-argument version in 20260815180000 for tiers 1 and 2,
-- which need no visits at all. Tiers 3 and 4 differ in one respect: where the
-- original asks "what is assigned to this person", this asks "what is this plan
-- giving this person". After Apply has written, those are the same question —
-- which is the point, and is why the preview and the apply resolve the same
-- start for the same technician on the same day.
CREATE OR REPLACE FUNCTION public.staff_start_point(
  _org_id uuid, _staff_id uuid, _day date, _visit_ids uuid[]
)
RETURNS TABLE(lat double precision, lon double precision, source text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  _lat double precision; _lon double precision;
  _cy double precision; _cx double precision;
BEGIN
  -- 1. The technician's own start address.
  SELECT s.start_latitude, s.start_longitude INTO _lat, _lon
    FROM public.staff s WHERE s.id = _staff_id AND s.organization_id = _org_id;
  IF _lat IS NOT NULL AND _lon IS NOT NULL THEN
    lat := _lat; lon := _lon; source := 'staff'; RETURN NEXT; RETURN;
  END IF;

  -- 2. The business location.
  SELECT o.latitude, o.longitude INTO _lat, _lon
    FROM public.organizations o WHERE o.id = _org_id;
  IF _lat IS NOT NULL AND _lon IS NOT NULL THEN
    lat := _lat; lon := _lon; source := 'business'; RETURN NEXT; RETURN;
  END IF;

  -- The centre of the work this plan gives them, which both remaining tiers
  -- are measured against. The whole day is the fallback, exactly as in the
  -- three-argument version, for a planned set with nothing geocoded in it.
  SELECT avg(p.latitude), avg(p.longitude) INTO _cy, _cx
    FROM public.visits v JOIN public.properties p ON p.id = v.property_id
   WHERE v.organization_id = _org_id AND v.scheduled_on = _day
     AND v.status = 'scheduled' AND v.id = ANY(_visit_ids)
     AND p.latitude IS NOT NULL;

  IF _cy IS NULL THEN
    SELECT avg(p.latitude), avg(p.longitude) INTO _cy, _cx
      FROM public.visits v JOIN public.properties p ON p.id = v.property_id
     WHERE v.organization_id = _org_id AND v.scheduled_on = _day
       AND v.status = 'scheduled' AND p.latitude IS NOT NULL;
  END IF;

  IF _cy IS NULL THEN
    -- Nothing geocoded anywhere. Say so rather than inventing a point.
    lat := NULL; lon := NULL; source := 'none'; RETURN NEXT; RETURN;
  END IF;

  -- 3. The nearest disposal site to that work.
  SELECT f.latitude, f.longitude INTO _lat, _lon
    FROM public.waste_disposal_facilities f
   WHERE f.organization_id = _org_id
     AND COALESCE(f.active, true)
     AND f.latitude IS NOT NULL AND f.longitude IS NOT NULL
   ORDER BY public.haversine_km(_cy, _cx, f.latitude, f.longitude) ASC
   LIMIT 1;
  IF _lat IS NOT NULL AND _lon IS NOT NULL THEN
    lat := _lat; lon := _lon; source := 'disposal'; RETURN NEXT; RETURN;
  END IF;

  -- 4. The edge of the round they are being given. See 20260815180000 for why
  -- this is the periphery and not the centre.
  SELECT p.latitude, p.longitude INTO _lat, _lon
    FROM public.visits v JOIN public.properties p ON p.id = v.property_id
   WHERE v.organization_id = _org_id AND v.scheduled_on = _day
     AND v.status = 'scheduled' AND v.id = ANY(_visit_ids)
     AND p.latitude IS NOT NULL
   ORDER BY public.haversine_km(_cy, _cx, p.latitude, p.longitude) DESC
   LIMIT 1;

  lat := _lat; lon := _lon;
  source := CASE WHEN _lat IS NULL THEN 'none' ELSE 'route' END;
  RETURN NEXT;
END;
$$;

-- Tighter than the three-argument version, which 20260815180000 grants to
-- authenticated. Nothing in the app calls this one: its only caller is the
-- derived solver, which is SECURITY DEFINER and so does not need the grant.
-- One fewer SECURITY DEFINER function reachable at /rest/v1/rpc for a signed-in
-- user, which is the lint 0029 surface, and it costs nothing here.
REVOKE ALL ON FUNCTION public.staff_start_point(uuid, uuid, date, uuid[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_start_point(uuid, uuid, date, uuid[]) TO service_role;

-- ── The solver, restricted to a named set of visits ───────────────────────
--
-- `plan_visits` is `plan_route` with two clauses changed. It is SPLICED out of
-- pg_get_functiondef rather than retyped, for the same reason 20260815180000
-- spliced the start point in: the body is ~150 lines of nearest-neighbour with
-- time-window and time-of-day penalties and a 2-opt pass, and a hand copy would
-- be a second solver that agrees today and diverges the first time anyone
-- touches either. This whole migration exists because two implementations of
-- one idea disagreed.
--
-- Every substitution is asserted to have taken. A splice that silently matched
-- nothing would produce a plausible function that plans the wrong visits, which
-- is far worse than a migration that refuses to apply.
DO $$
DECLARE _def text; _new text;
BEGIN
  _def := pg_get_functiondef('public.plan_route(uuid,uuid,date,boolean,text)'::regprocedure);

  -- The header. `_reassign` is replaced by the visit list rather than kept
  -- alongside it: with the visits named there is nothing left for it to decide,
  -- and a parameter that no longer affects the answer is a trap.
  _new := replace(
    _def,
    'public.plan_route(_org_id uuid, _staff_id uuid, _day date, _reassign boolean DEFAULT false, _level text DEFAULT ''balanced''::text)',
    'public.plan_visits(_org_id uuid, _staff_id uuid, _day date, _visit_ids uuid[], _level text DEFAULT ''balanced''::text)');
  IF _new = _def THEN
    RAISE EXCEPTION 'plan_route does not carry the signature this migration expects';
  END IF;
  _def := _new;

  -- The candidate set: the whole organisation's day becomes these visits.
  _new := replace(
    _def,
    'AND (_reassign OR v.assigned_staff_id IS NULL OR v.assigned_staff_id = _staff_id);',
    'AND v.id = ANY(_visit_ids);');
  IF _new = _def THEN
    RAISE EXCEPTION 'plan_route does not select its candidates the way this migration expects';
  END IF;
  _def := _new;

  -- And the start point, measured against the same named set.
  _new := replace(
    _def,
    'FROM public.staff_start_point(_org_id, _staff_id, _day) sp;',
    'FROM public.staff_start_point(_org_id, _staff_id, _day, _visit_ids) sp;');
  IF _new = _def THEN
    RAISE EXCEPTION 'plan_route does not resolve its start through staff_start_point';
  END IF;
  _def := _new;

  -- Nothing may still consult `_reassign`: it no longer exists as a parameter,
  -- so a surviving mention is a compile error waiting for the first call, and
  -- this says so here instead.
  IF strpos(_def, '_reassign') > 0 THEN
    RAISE EXCEPTION 'the derived solver still mentions _reassign, which it no longer takes';
  END IF;

  EXECUTE _def;
END $$;

DO $$
BEGIN
  -- Guarded, and not because the grant might fail: the function above is
  -- created by EXECUTE, so a bare GRANT here would look — to the scan in
  -- tests/the-wiring-is-connected.test.ts — like granting on something no
  -- migration creates. The guard states the dependency the scan cannot see.
  IF to_regprocedure('public.plan_visits(uuid,uuid,date,uuid[],text)') IS NULL THEN
    RAISE EXCEPTION 'plan_visits was not created';
  END IF;
  REVOKE ALL ON FUNCTION public.plan_visits(uuid, uuid, date, uuid[], text) FROM public, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.plan_visits(uuid, uuid, date, uuid[], text) TO service_role;
END $$;

-- ── The planner: the whole day, the whole team, and no writes ─────────────
--
-- This is the body 20260815170000 shipped, with every write to `public.visits`
-- replaced by a row in `_dry_asn` / `_dry_route`. Read it against that file:
-- the sweep, the capacity shares, the nearest-start match and the eight-pass
-- rebalance are unchanged in substance, and the header of that migration is
-- still the explanation of WHY each of them is there.
--
-- It returns the plan STOP BY STOP rather than as a summary, because its two
-- callers want different things from it — one writes the rows, one counts them
-- — and a summary cannot be turned back into a plan.
CREATE OR REPLACE FUNCTION public.plan_day_across_staff_dryrun(
  _org_id uuid,
  _staff_ids uuid[],
  _day date,
  _reassign boolean DEFAULT false,
  _level text DEFAULT 'balanced'
)
RETURNS TABLE(
  staff_id uuid,
  visit_id uuid,
  seq integer,
  eta_start timestamptz,
  eta_end timestamptz,
  travel_km numeric,
  travel_min numeric,
  window_violated boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
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

  -- No rows rather than an exception when nobody can be routed. The writer
  -- turns that into the refusal a dispatcher sees; the preview turns it into a
  -- day it does not list. Raising here would make the second impossible.
  _eligible := public.routable_staff(_org_id, _staff_ids, _day);
  IF COALESCE(array_length(_eligible, 1), 0) = 0 THEN
    RETURN;
  END IF;

  -- ── The work to divide ──────────────────────────────────────────────────
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
            -- Only among the SELECTED technicians. Somebody left out keeps
            -- their work; this is a re-plan of these people's day, not a
            -- repossession of everybody's.
            THEN v.assigned_staff_id IS NULL OR v.assigned_staff_id = ANY(_eligible)
            ELSE v.assigned_staff_id IS NULL
       END
     );

  -- Nothing to plan is not an error, and it is not "re-sequence everybody
  -- anyway" either: Apply returns here without touching a row, so the preview
  -- has to be able to say that applying would change nothing.
  IF NOT EXISTS (SELECT 1 FROM _dry_grp) THEN
    RETURN;
  END IF;

  -- ── 1. Sweep order, cut at the widest gap ───────────────────────────────
  SELECT avg(g.lat), avg(g.lon) INTO _cy, _cx FROM _dry_grp g WHERE g.lat IS NOT NULL;

  -- A visit with no coordinates cannot be swept. It is parked at the centroid
  -- and lands with whichever arc covers it — visible in the result rather than
  -- dropped on the floor.
  UPDATE _dry_grp SET ang = atan2(COALESCE(lat, _cy) - _cy, COALESCE(lon, _cx) - _cx);

  SELECT COALESCE(
           (SELECT q.ang FROM (
              SELECT g3.ang, g3.ang - LAG(g3.ang) OVER (ORDER BY g3.ang) AS gap FROM _dry_grp g3
            ) q WHERE q.gap IS NOT NULL ORDER BY q.gap DESC LIMIT 1),
           (SELECT min(g4.ang) FROM _dry_grp g4))
    INTO _gap_start;

  UPDATE _dry_grp
     SET ang = CASE WHEN ang - _gap_start < 0
                    THEN ang - _gap_start + 2 * pi()
                    ELSE ang - _gap_start END;

  -- ── 2. Arc sizes from capacity, less what is already booked ─────────────
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

  -- ── 3. Give each arc to the technician who starts nearest it ────────────
  CREATE TEMP TABLE IF NOT EXISTS _dry_match (cluster int, sid uuid) ON COMMIT DROP;
  DELETE FROM _dry_match WHERE true;

  FOR _p IN
    SELECT g.cluster AS cl, count(*) AS n, avg(g.lat) AS lat, avg(g.lon) AS lon
      FROM _dry_grp g GROUP BY g.cluster ORDER BY count(*) DESC
  LOOP
    SELECT sh.sid INTO _s
      FROM _dry_share sh
      JOIN public.staff st ON st.id = sh.sid
     WHERE sh.sid NOT IN (SELECT m.sid FROM _dry_match m)
     ORDER BY COALESCE(
                public.haversine_km(st.start_latitude, st.start_longitude, _p.lat, _p.lon),
                9999) ASC,
              sh.sid
     LIMIT 1;
    IF _s IS NOT NULL THEN
      INSERT INTO _dry_match (cluster, sid) VALUES (_p.cl, _s);
    END IF;
  END LOOP;

  -- The assignment Apply would write. Held here instead.
  CREATE TEMP TABLE IF NOT EXISTS _dry_asn (vid uuid PRIMARY KEY, sid uuid NOT NULL) ON COMMIT DROP;
  DELETE FROM _dry_asn WHERE true;

  INSERT INTO _dry_asn (vid, sid)
  SELECT g.id, m.sid FROM _dry_grp g JOIN _dry_match m ON m.cluster = g.cluster;

  -- Work the plan did not move, but which the technician still drives that
  -- day. With reassign OFF their existing stops are not candidates for the
  -- sweep, and Apply nonetheless re-sequences them, because plan_route reads
  -- the technician's whole day once the clusters are written. Leaving them out
  -- here would make the preview show a shorter, cheaper day than Apply
  -- produces — the same class of lie, in the other direction.
  INSERT INTO _dry_asn (vid, sid)
  SELECT v.id, v.assigned_staff_id
    FROM public.visits v
   WHERE v.organization_id = _org_id
     AND v.scheduled_on = _day
     AND v.status = 'scheduled'
     AND v.assigned_staff_id = ANY(_eligible)
     AND NOT EXISTS (SELECT 1 FROM _dry_asn a WHERE a.vid = v.id);

  -- ── 4. Sequence each technician's own round, with the existing solver ───
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

  -- ── 5. Even out the MEASURED minutes ────────────────────────────────────
  --
  -- The sweep balanced service time. Drive time is the bigger variable and is
  -- only knowable once a round has been sequenced, so the balancing the owner
  -- asked for happens here, on measured numbers — service plus drive, the same
  -- quantity `staff_day_minutes` reads off the written rows, read off the
  -- planned ones instead.
  LOOP
    _pass := _pass + 1;
    EXIT WHEN _pass > 8;

    -- Spread and both ends in one pass. The id tiebreaker is deliberate: two
    -- technicians on identical minutes used to leave the choice to whatever
    -- order the rows came back in, and a preview and an apply that flip a coin
    -- each disagree for a reason nobody can see.
    SELECT max(q.t) - min(q.t),
           (array_agg(q.sid ORDER BY q.t DESC, q.sid))[1],
           (array_agg(q.sid ORDER BY q.t ASC, q.sid))[1]
      INTO _spread, _hi, _lo
      FROM (
        SELECT e.s AS sid,
               (SELECT COALESCE(SUM(COALESCE(p.service_duration_min, 8) + COALESCE(r.t_min, 0)), 0)
                  FROM _dry_route r
                  JOIN public.visits v ON v.id = r.vid
                  LEFT JOIN public.properties p ON p.id = v.property_id
                 WHERE r.sid = e.s) AS t
          FROM unnest(_eligible) AS e(s)
      ) q;

    -- Ten minutes apart is even enough; chasing further just churns routes.
    EXIT WHEN _spread IS NULL OR _spread <= 10;
    EXIT WHEN _hi IS NULL OR _lo IS NULL OR _hi = _lo;

    -- The most transferable visit: the one on the busiest round that sits
    -- closest to where the quietest technician is already working.
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
        SELECT e.s AS sid,
               (SELECT COALESCE(SUM(COALESCE(p.service_duration_min, 8) + COALESCE(r.t_min, 0)), 0)
                  FROM _dry_route r
                  JOIN public.visits v ON v.id = r.vid
                  LEFT JOIN public.properties p ON p.id = v.property_id
                 WHERE r.sid = e.s) AS t
          FROM unnest(_eligible) AS e(s)
      ) q;

    -- Undo a move that did not help, and stop. Without this the loop can hand
    -- the same visit back and forth for eight passes.
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
$$;

REVOKE ALL ON FUNCTION public.plan_day_across_staff_dryrun(uuid, uuid[], date, boolean, text)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plan_day_across_staff_dryrun(uuid, uuid[], date, boolean, text)
  TO service_role;

-- ── Apply: the planner above, written down ────────────────────────────────
--
-- Guards, error strings, the nothing-to-do branch and the summary query are
-- carried over from 20260815170000 unchanged — they are what applyOptimize and
-- the toast on screen are built on. What is gone is the algorithm, which now
-- lives in exactly one place.
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
AS $$
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
$$;

-- Restated rather than relied upon. CREATE OR REPLACE keeps the privileges the
-- function already had, so on this database these two lines change nothing —
-- but a file that creates a function and does not revoke is a file that ships
-- it executable by the publishable key the first time it runs somewhere the
-- earlier migration has not, which is what the lockdown check in
-- tests/the-lockdown-that-only-held-for-the-functions-that-existed-that-day
-- is for. It is right; the exception "it already exists in production" is
-- exactly the reasoning that check exists to refuse.
REVOKE ALL ON FUNCTION public.plan_day_across_staff(uuid, uuid[], date, boolean, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.plan_day_across_staff(uuid, uuid[], date, boolean, text) TO authenticated, service_role;

-- ── Preview: the planner above, counted ───────────────────────────────────
--
-- One call per DAY, with the whole selected team in it — the same correction
-- applyOptimize got in 20260815170000, arriving here a day late.
--
-- `before_min` still comes from route_cost_current, which measures the day as
-- it stands. `after_min` is the drive time of the round this plan gives the
-- technician, so the difference is a comparison between two real routes rather
-- than between one real route and one that was never going to be driven.
CREATE OR REPLACE FUNCTION public.preview_optimize(
  _org_id uuid,
  _staff_ids uuid[],
  _from date,
  _to date,
  _level text DEFAULT 'balanced',
  _reassign boolean DEFAULT false
)
RETURNS TABLE(
  staff_id uuid,
  day date,
  stops integer,
  before_min numeric,
  after_min numeric,
  before_known boolean,
  violations integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE _d date; _cur RECORD; _r RECORD;
BEGIN
  IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _to < _from THEN RAISE EXCEPTION 'End date is before start date'; END IF;
  IF _to - _from > 30 THEN RAISE EXCEPTION 'Preview covers at most 31 days'; END IF;

  _d := _from;
  WHILE _d <= _to LOOP
    -- Days on which nobody is routable, and days with nothing to route, come
    -- back with no rows and are simply not listed. That is the same silence
    -- the old per-technician `IF NOT is_staff_off(_s, _d)` produced, decided
    -- once by routable_staff instead of restated here.
    FOR _r IN
      SELECT d.staff_id AS sid,
             COUNT(*)::int AS n,
             ROUND(COALESCE(SUM(d.travel_min), 0), 1) AS drive_min,
             COALESCE(SUM(CASE WHEN d.window_violated THEN 1 ELSE 0 END), 0)::int AS viol
        FROM public.plan_day_across_staff_dryrun(_org_id, _staff_ids, _d, _reassign, _level) d
       GROUP BY d.staff_id
       ORDER BY d.staff_id
    LOOP
      SELECT * INTO _cur FROM public.route_cost_current(_org_id, _r.sid, _d);
      staff_id := _r.sid;
      day := _d;
      stops := _r.n;
      before_min := ROUND(_cur.minutes, 1);
      after_min := _r.drive_min;
      before_known := _cur.sequenced;
      violations := _r.viol;
      RETURN NEXT;
    END LOOP;
    _d := _d + 1;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.preview_optimize(uuid, uuid[], date, date, text, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.preview_optimize(uuid, uuid[], date, date, text, boolean) TO authenticated, service_role;
