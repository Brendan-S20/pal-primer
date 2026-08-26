-- Auto-routing could not run at all through the API.
--
-- Owner report, 2026-08-26: "Even when I try all the options, I still receive
-- an error" -- and the error named an UPDATE clause.
--
-- ── WHAT IT ACTUALLY WAS ─────────────────────────────────────────────────
--
-- plan_day_across_staff_dryrun updates its sweep scratch table twice with no
-- WHERE clause:
--
--   UPDATE _dry_grp SET ang = atan2(...);
--   UPDATE _dry_grp SET ang = CASE WHEN ang - _gap_start < 0 ... END;
--
-- Both are correct SQL and both are meant to touch every row. Supabase runs
-- the PostgREST role with pg_safeupdate loaded, which refuses an unqualified
-- UPDATE or DELETE outright:
--
--   ERROR 21000: UPDATE requires a WHERE clause
--   CONTEXT: SQL statement "UPDATE _dry_grp SET ang = atan2(...)"
--            PL/pgSQL function plan_day_across_staff_dryrun line 72
--            ... plan_day_across_staff line 31
--   user_name = authenticator
--
-- So EVERY route through the planner failed for a signed-in user: Apply, via
-- plan_day_across_staff, and Preview, via preview_optimize. Both call the same
-- dry run, and it raises before it can return a single row.
--
-- ── WHY NOBODY CAUGHT IT ─────────────────────────────────────────────────
--
-- Because it cannot be reproduced anywhere except through the API. The SQL
-- editor, psql, a migration, `supabase db reset`, and the replay in
-- sandboxes.yml all connect as a role WITHOUT pg_safeupdate, and there the
-- same statement runs perfectly. I called this function four different ways
-- while diagnosing it -- as postgres, as authenticated, with the JWT claims
-- set, apply and dry run -- and every one of them returned the correct 8/7/6
-- split across three technicians. The planner was never wrong. The extension
-- that only the API loads is the whole difference, and the only artefact that
-- showed it was the postgres log.
--
-- ── THE FIX, AND WHY `WHERE true` ────────────────────────────────────────
--
-- pg_safeupdate wants a WHERE clause, not a selective one. `WHERE true` is
-- already the idiom in this very function -- `DELETE FROM _dry_share WHERE
-- true` on the line below sits there for exactly this reason and has always
-- worked, which is how we know this build accepts it. The rows affected are
-- unchanged: all of them, deliberately, because a sweep angle is defined for
-- every stop in the day.
--
-- Nothing else in `public` has this shape. Every UPDATE and DELETE in every
-- function was checked statement by statement, with comments stripped so a
-- statement introduced by a comment still starts with its verb -- the first
-- scan missed this exact one for that reason.

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

-- CREATE OR REPLACE keeps the existing ACL on a database that already has this
-- function, so this changes nothing in production -- but a REPLAY creates it
-- from nothing, where the default is EXECUTE to PUBLIC. Caught by
-- the-lockdown-that-only-held-for-the-functions-that-existed-that-day, which is
-- exactly the fresh-build blindness CLAUDE.md describes: the omission is
-- invisible on the grown database and wide open on a new one.
-- EXACTLY as 20260815190000 had it, including the part that is easy to get
-- wrong: `authenticated` is REVOKED, not granted. The dry run is reached only
-- from plan_day_across_staff and preview_optimize, both SECURITY DEFINER, so
-- nobody needs to call it directly and granting it would widen the API surface
-- for no reason. Copying the more familiar
-- `GRANT ... TO authenticated, service_role` here would have done exactly that.
REVOKE ALL ON FUNCTION public.plan_day_across_staff_dryrun(uuid, uuid[], date, boolean, text)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plan_day_across_staff_dryrun(uuid, uuid[], date, boolean, text)
  TO service_role;

-- Provable from an empty database: no unqualified UPDATE or DELETE survives in
-- the planner. Reads prosrc rather than pg_get_functiondef, which raises on any
-- pg_proc row that is not a plain function.
DO $verify$
DECLARE _src text; _bad int;
BEGIN
  SELECT p.prosrc INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'plan_day_across_staff_dryrun'
   LIMIT 1;
  IF _src IS NULL THEN
    RAISE EXCEPTION 'plan_day_across_staff_dryrun is missing after this migration';
  END IF;

  SELECT count(*) INTO _bad
    FROM unnest(string_to_array(regexp_replace(_src, '--[^\n]*', '', 'g'), ';')) AS s
   WHERE trim(both E' \n\r\t' FROM s) ~* '^(UPDATE|DELETE\s+FROM)\s'
     AND trim(both E' \n\r\t' FROM s) !~* '\mWHERE\M';

  IF _bad > 0 THEN
    RAISE EXCEPTION
      'plan_day_across_staff_dryrun still has % unqualified UPDATE/DELETE statement(s); pg_safeupdate will refuse them through the API', _bad;
  END IF;
END
$verify$;
