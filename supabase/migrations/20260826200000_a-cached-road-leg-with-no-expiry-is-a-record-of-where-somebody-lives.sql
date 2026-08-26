-- A cached road leg with no expiry is a permanent record of where somebody lives.
--
-- road_legs went in without a lifetime. Two things follow from that, and only
-- one of them is about correctness.
--
-- ── IT GOES STALE ────────────────────────────────────────────────────────
--
-- A road leg is a fact about the road network on the day it was measured. Road
-- networks change: a bridge closes, a street turns one-way, a new slip road
-- opens. A cache with no horizon answers with 2026's roads for ever and never
-- says so, and the failure is invisible because a wrong number looks exactly
-- like a right one.
--
-- 90 days, because the underlying map data is refreshed monthly (see
-- infra/osrm/README.md) and re-measuring three times per refresh is generous
-- without being churn. A stale row is not deleted on read -- it simply stops
-- being consulted, so drive_minutes falls back to the estimate and the next
-- refresh overwrites it.
--
-- ── AND IT IS CUSTOMER LOCATION DATA ─────────────────────────────────────
--
-- Every row is a pair of coordinates where a customer lives. When a client
-- leaves, their address should stop existing in our systems; a distance cache
-- is exactly the kind of derived table that keeps holding it after the obvious
-- places have been cleared. `delete_my_account` was careful about
-- staff.start_latitude for the same reason, and this is the customer-side
-- equivalent nobody would think to look for.
--
-- prune_road_legs() drops anything stale, and anything whose endpoint no
-- longer matches a live property in that organization.

CREATE OR REPLACE FUNCTION public.drive_minutes(
  _org_id uuid, _lat1 double precision, _lon1 double precision,
  _lat2 double precision, _lon2 double precision)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE _o RECORD; _km numeric; _speed numeric; _secs numeric;
BEGIN
  IF _lat1 IS NULL OR _lon1 IS NULL OR _lat2 IS NULL OR _lon2 IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT avg_speed_kmh, traffic_profile, road_factor, area_type, park_walk_min
    INTO _o FROM public.organizations WHERE id = _org_id;

  -- Measured, recently enough to still be true.
  SELECT rl.seconds INTO _secs
    FROM public.road_legs rl
   WHERE rl.organization_id = _org_id
     AND rl.from_lat = round(_lat1::numeric, 5) AND rl.from_lon = round(_lon1::numeric, 5)
     AND rl.to_lat   = round(_lat2::numeric, 5) AND rl.to_lon   = round(_lon2::numeric, 5)
     AND rl.fetched_at > now() - interval '90 days';

  IF _secs IS NOT NULL THEN
    RETURN _secs / 60.0 + COALESCE(_o.park_walk_min, 2);
  END IF;

  _km := public.haversine_km(_lat1, _lon1, _lat2, _lon2) * COALESCE(_o.road_factor, 1.30);

  _speed := CASE
              WHEN _o.avg_speed_kmh IS NOT NULL AND _o.avg_speed_kmh <> 30
                THEN _o.avg_speed_kmh
              ELSE public.effective_speed_kmh(_o.area_type, _o.traffic_profile)
            END;

  RETURN (_km / NULLIF(_speed, 0)) * 60.0 + COALESCE(_o.park_walk_min, 2);
END;
$function$;

-- Takes an organization id and never asks who is calling, so it stays closed
-- to anon and authenticated. Only the planner, which is SECURITY DEFINER and
-- does its own authorization, needs it.
REVOKE ALL ON FUNCTION public.drive_minutes(uuid, double precision, double precision, double precision, double precision)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.drive_minutes(uuid, double precision, double precision, double precision, double precision)
  TO service_role;

CREATE INDEX IF NOT EXISTS road_legs_fetched_at_idx
  ON public.road_legs (fetched_at);

CREATE OR REPLACE FUNCTION public.prune_road_legs(_older_than interval DEFAULT interval '90 days')
RETURNS TABLE(stale_removed bigint, orphaned_removed bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE _stale bigint; _orphan bigint;
BEGIN
  WITH d AS (
    DELETE FROM public.road_legs
     WHERE fetched_at <= now() - _older_than
     RETURNING 1
  ) SELECT count(*) INTO _stale FROM d;

  -- An endpoint that no longer belongs to a live property in that org. A
  -- staff start address is a legitimate endpoint too, so both are checked
  -- before a row is called orphaned.
  WITH d AS (
    DELETE FROM public.road_legs rl
     WHERE NOT EXISTS (
       SELECT 1 FROM public.properties p
        WHERE p.organization_id = rl.organization_id
          AND round(p.latitude::numeric,5) = rl.from_lat
          AND round(p.longitude::numeric,5) = rl.from_lon
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.staff s
        WHERE s.organization_id = rl.organization_id
          AND round(s.start_latitude::numeric,5) = rl.from_lat
          AND round(s.start_longitude::numeric,5) = rl.from_lon
     )
     RETURNING 1
  ) SELECT count(*) INTO _orphan FROM d;

  stale_removed := _stale; orphaned_removed := _orphan;
  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.prune_road_legs(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_road_legs(interval) TO service_role;

COMMENT ON FUNCTION public.prune_road_legs(interval) IS
  'Deletes cached road legs that are stale, or whose origin is no longer a live property or staff start point in that organization. Run on a schedule; the cache refills itself on the next plan.';

-- ── AND SOMETHING HAS TO RUN IT ──────────────────────────────────────────
--
-- A prune function nobody calls is worse than no prune function: it creates
-- the belief that the addresses are being cleared while they sit there. The
-- dead-machinery check caught exactly that within one run of writing it.
--
-- Weekly, in the quiet hours. `run-billing-cycles` uses the same direct SQL
-- form, which is the right shape for a function with no HTTP hop in it.
--
-- Scheduled HERE, in the migration that creates the function, so a replay
-- establishes both together and the assertion below is provable from an empty
-- database rather than assuming a console somebody clicked.
DO $sched$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    PERFORM cron.unschedule('prune-road-legs')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prune-road-legs');
    PERFORM cron.schedule('prune-road-legs', '30 4 * * 0', 'SELECT public.prune_road_legs();');
  ELSE
    RAISE WARNING 'pg_cron is not installed, so prune-road-legs was NOT scheduled; cached customer coordinates will not be cleared automatically';
  END IF;
END
$sched$;

DO $verify$
DECLARE _src text;
BEGIN
  SELECT p.prosrc INTO _src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='drive_minutes' LIMIT 1;

  IF _src NOT LIKE '%fetched_at >%' THEN
    RAISE EXCEPTION 'drive_minutes consults the cache with no freshness bound; it would answer with the road network of whatever day it was measured, for ever';
  END IF;
  IF _src NOT LIKE '%haversine_km%' THEN
    RAISE EXCEPTION 'drive_minutes lost its estimate fallback; unmeasured legs would cost nothing';
  END IF;
  -- WARNING, not EXCEPTION, and the distinction is the one CLAUDE.md draws.
  --
  -- This file schedules prune-road-legs a few lines above, so on a clean
  -- replay it is there. But the-wiring-is-connected collects schedules AFTER
  -- checking each file's assertions precisely so that a migration cannot
  -- vouch for itself, and that rule is worth more than this assertion is.
  -- A replay that somehow lacks pg_cron should say so loudly and carry on,
  -- not fail for a reason unrelated to the change.
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron')
     AND NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prune-road-legs') THEN
    RAISE WARNING 'prune-road-legs is not scheduled, so cached customer coordinates will not be cleared automatically';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('drive_minutes','prune_road_legs')
       AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
         OR has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) THEN
    RAISE EXCEPTION 'a road-leg function is executable by anon or authenticated, and they answer questions about any tenant';
  END IF;
END
$verify$;
