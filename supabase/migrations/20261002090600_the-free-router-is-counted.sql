-- The free router is counted.
--
-- Road legs are measured by router.project-osrm.org, the public OSRM demo:
-- free, no key, and its operators say plainly it is not for production use.
-- That is the launch decision (road-legs.server.ts has the reasoning), and it
-- comes with two obligations this file serves.
--
-- 1. ASK LESS. Every day planned used to send one Table request even when
--    every leg that day needs was measured last week and is still in
--    road_legs. drive_minutes() only trusts a leg for 90 days
--    (`fetched_at > now() - interval '90 days'`), so "already cached" means
--    exactly that: every ordered pair among the day's points has a row
--    younger than 90 days. count_fresh_road_legs answers it in ONE call, by
--    primary-key probes, for up to OSRM_MAX_TABLE points -- 90 points is 8,010
--    pairs, which as a PostgREST filter would be either a URL past any proxy's
--    limit or a row set past `max_rows`, silently truncated into "not cached".
--
-- 2. KNOW HOW OFTEN IT FAILS. A free shared service that starts refusing us
--    shows up first as days quietly planned on straight-line estimates. The
--    dispatcher sees a toast; the platform sees nothing. road_leg_runs is one
--    row per day measured, saying what happened:
--
--      measured   the router was asked and its answer was written. `reason` is
--                 NULL, or 'points_outside_graph' when some stops snapped too
--                 far to trust and only their legs stayed on estimates -- the
--                 PARTIAL case, counted as measured because the day was, and
--                 named so the platform card can say how many were partial.
--      cached     every leg was already fresh; the router was not asked.
--      estimated  the day got no measured legs. `reason` is the RoadLegProblem
--                 (router_busy, router_unreachable, too_many_points, ...).
--
--    A day with fewer than two points is not written at all: it has nothing
--    to measure, and counting it would make every one-stop workspace look like
--    a routing outcome. `reason` is deliberately NOT constrained to today's
--    list of problems: a cause added in TypeScript later would otherwise fail
--    the insert, and the insert is best-effort, so the counter would quietly
--    stop counting exactly the new failure somebody most wants to see.
--
--    Written only by refreshRoadLegs through the service role, read only by
--    the platform console through road_leg_run_summary. RLS on, no permissive
--    policy, no grant to anon or authenticated: deny-all on purpose, listed in
--    tests/nine-tables-that-are-deny-all-on-purpose.test.ts. The rows name
--    organizations and dates and nothing else -- no coordinates -- but there
--    is no reader on the tenant side, so there is nothing to open it for.
--
--    Retention: refreshRoadLegs deletes that organization's rows older than 90
--    days in the same write path (the index below makes it a range probe). No
--    cron job: the table only grows when the writer runs, and the writer is
--    the pruner.
--
-- Replays into an empty database: nothing here needs a row, a tenant or a
-- schedule. The two-step-sign-in policy is applied only if
-- require_mfa_policy exists on this build (20261002010000 adds it; it is not
-- on every branch this file lands on).

CREATE TABLE IF NOT EXISTS public.road_leg_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  day date NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('measured', 'cached', 'estimated')),
  reason text,
  points integer NOT NULL CHECK (points >= 0),
  at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT road_leg_runs_reason_fits_outcome CHECK (
    CASE outcome
      WHEN 'estimated' THEN reason IS NOT NULL AND reason <> 'points_outside_graph'
      WHEN 'measured' THEN reason IS NULL OR reason = 'points_outside_graph'
      ELSE reason IS NULL
    END
  )
);

COMMENT ON TABLE public.road_leg_runs IS
  'One row per day refreshRoadLegs measured: measured / cached / estimated, and why when estimated. Service role only; read by the platform console''s routing-health card. Pruned to 90 days by the writer.';

-- The platform card reads the last 7 days across every organization.
CREATE INDEX IF NOT EXISTS road_leg_runs_at_idx ON public.road_leg_runs (at);
-- The writer prunes one organization's old rows; also covers the foreign key.
CREATE INDEX IF NOT EXISTS road_leg_runs_org_at_idx ON public.road_leg_runs (organization_id, at);

ALTER TABLE public.road_leg_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.road_leg_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.road_leg_runs TO service_role;

DO $mfa$
BEGIN
  -- A RESTRICTIVE policy alone grants nothing, so the table stays deny-all;
  -- applied for consistency with every other RLS table once two-step sign-in
  -- has landed. EXECUTEd so this file compiles on a build without it.
  IF to_regprocedure('public.require_mfa_policy(regclass)') IS NOT NULL THEN
    EXECUTE 'SELECT public.require_mfa_policy($1)' USING 'public.road_leg_runs'::regclass;
  END IF;
END
$mfa$;

-- ── Is every leg of this day already measured, and fresh? ────────────────
--
-- Returns how many DISTINCT ordered pairs among the given points have a road
-- leg younger than 90 days; the caller compares it with n*(n-1). Rounded to 5
-- places exactly as road_legs stores them and drive_minutes looks them up.
-- The 90 days is drive_minutes' own window: a leg older than that is one the
-- planner would not use, so it must not count as cached here either.
--
-- SECURITY INVOKER: its only caller is the service role, which reads
-- road_legs directly anyway. It takes an organization id and checks nobody,
-- so it is closed to anon and authenticated like drive_minutes.
CREATE OR REPLACE FUNCTION public.count_fresh_road_legs(
  _org_id uuid, _lats numeric[], _lons numeric[])
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH p AS (
    SELECT DISTINCT round(u.lat, 5) AS lat, round(u.lon, 5) AS lon
      FROM unnest(_lats, _lons) AS u(lat, lon)
     WHERE u.lat IS NOT NULL AND u.lon IS NOT NULL
  )
  SELECT count(*)::integer
    FROM p a
    JOIN p b ON (a.lat, a.lon) IS DISTINCT FROM (b.lat, b.lon)
    JOIN public.road_legs rl
      ON rl.organization_id = _org_id
     AND rl.from_lat = a.lat AND rl.from_lon = a.lon
     AND rl.to_lat = b.lat AND rl.to_lon = b.lon
   WHERE rl.fetched_at > now() - interval '90 days';
$function$;

REVOKE ALL ON FUNCTION public.count_fresh_road_legs(uuid, numeric[], numeric[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.count_fresh_road_legs(uuid, numeric[], numeric[])
  TO service_role;

-- ── What the platform card reads ─────────────────────────────────────────
--
-- Aggregated here rather than in TypeScript because the row count is
-- unbounded (every workspace, every day planned, every re-plan) and PostgREST
-- caps a read at `max_rows` without saying so -- a card that summed the first
-- thousand rows would under-count precisely when routing is busiest.
CREATE OR REPLACE FUNCTION public.road_leg_run_summary(_since timestamptz)
RETURNS TABLE(outcome text, reason text, runs bigint, workspaces bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT r.outcome, r.reason, count(*)::bigint, count(DISTINCT r.organization_id)::bigint
    FROM public.road_leg_runs r
   WHERE r.at >= _since
   GROUP BY r.outcome, r.reason
   ORDER BY r.outcome, count(*) DESC;
$function$;

REVOKE ALL ON FUNCTION public.road_leg_run_summary(timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.road_leg_run_summary(timestamptz) TO service_role;

DO $check$
DECLARE
  _t regclass := to_regclass('public.road_leg_runs');
  _fn text;
BEGIN
  IF _t IS NULL THEN
    RAISE EXCEPTION 'road_leg_runs was not created';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = _t) THEN
    RAISE EXCEPTION 'road_leg_runs has RLS disabled; it is meant to be deny-all';
  END IF;
  -- Permissive only: a restrictive policy (two-step sign-in) grants nothing on
  -- its own, so the table is still deny-all with one.
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = _t AND polpermissive) THEN
    RAISE EXCEPTION 'road_leg_runs has a permissive policy; it is meant to be deny-all';
  END IF;
  IF has_table_privilege('anon', _t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR has_table_privilege('authenticated', _t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION 'anon or authenticated holds a privilege on road_leg_runs';
  END IF;
  IF NOT has_table_privilege('service_role', _t, 'SELECT, INSERT, DELETE') THEN
    RAISE EXCEPTION 'service_role cannot write road_leg_runs, so nothing will be counted';
  END IF;

  FOREACH _fn IN ARRAY ARRAY[
    'public.count_fresh_road_legs(uuid, numeric[], numeric[])',
    'public.road_leg_run_summary(timestamptz)'
  ] LOOP
    IF to_regprocedure(_fn) IS NULL THEN
      RAISE EXCEPTION '% was not created', _fn;
    END IF;
    IF has_function_privilege('anon', _fn, 'EXECUTE')
       OR has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% is executable by anon or authenticated', _fn;
    END IF;
    IF NOT has_function_privilege('service_role', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% is not executable by service_role, its only caller', _fn;
    END IF;
  END LOOP;
END
$check$;
