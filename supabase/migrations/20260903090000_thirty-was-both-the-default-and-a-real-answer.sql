-- The configured driving speed has never been used by anybody.
--
-- ── THE SENTINEL ──────────────────────────────────────────────────────────
--
-- `drive_minutes` resolved its speed like this:
--
--   _speed := CASE WHEN _o.avg_speed_kmh IS NOT NULL AND _o.avg_speed_kmh <> 30
--                  THEN _o.avg_speed_kmh
--                  ELSE public.effective_speed_kmh(_o.area_type, _o.traffic_profile)
--             END;
--
-- `<> 30` means "30 is how an organization says nothing". It is written that
-- way because the column is `integer NOT NULL DEFAULT 30` and therefore cannot
-- express "unset" -- a real constraint, and a reasonable reading of it.
--
-- Two things are wrong with it. Every organization in this database sits at
-- exactly 30, so the branch has never once been taken and the column is inert.
-- And 30 km/h is a perfectly ordinary answer for a van on suburban roads, so
-- the first owner to measure their own average, type 30, and press Save is
-- silently overridden by a table -- with no way to tell, because the field
-- keeps showing the number they typed.
--
-- The fix for a sentinel is not a better sentinel. NULL is what "unset" is
-- called, so the column becomes nullable, today's 30s become NULL (which is
-- what they have always meant), and any value typed from now on is used.
--
-- ── AND A BETTER ANSWER THAN EITHER ───────────────────────────────────────
--
-- Both branches were guesses about a road network we have already measured.
-- `road_legs` holds real OSRM distances and durations for every pair this
-- workspace has planned, and drive_minutes prefers them -- the estimate is
-- only ever the fallback for a leg nobody has driven yet. But the fallback was
-- reaching for a hardcoded table when the same table has the answer:
--
--   Demo Pet Waste Co, from its own 1262 measured legs:
--     median speed        37.5 km/h      the table said 11.0  (dense_urban)
--     median road factor   1.37          the column said 1.45
--
-- 11.0 against 37.5 is not a rounding difference. It is why a day whose cache
-- had not been warmed reported 672.9 drive minutes where the road says about
-- 325, and why the balance between technicians came out worse when it did.
-- The `dense_urban` setting is itself wrong for suburban Detroit -- but an
-- estimator that can be wrong by 3.4x because somebody picked the wrong item
-- from a dropdown is the problem, not the dropdown.
--
-- So the fallback now asks the workspace's own roads first. It costs nothing
-- at plan time because it is computed when legs are written, not when they are
-- read: drive_minutes is called O(n^2) per plan and must not run a percentile.
--
-- Precedence, most specific first:
--   1. the measured leg itself                     (unchanged, still preferred)
--   2. this workspace's own median road speed      (new)
--   3. whatever the owner typed                    (now actually honoured)
--   4. effective_speed_kmh(area_type, traffic)     (a brand-new workspace)
--
-- Tier 4 stops mattering after a workspace has planned a day or two, which is
-- the point: nobody should have to know what "dense urban" is worth in km/h.

-- ── NULL is what unset is called ──────────────────────────────────────────
ALTER TABLE public.organizations ALTER COLUMN avg_speed_kmh DROP NOT NULL;
ALTER TABLE public.organizations ALTER COLUMN avg_speed_kmh DROP DEFAULT;

-- Behaviour-preserving: 30 has meant "unset" for the whole life of this
-- column, so writing NULL over it changes what the row SAYS and not what the
-- planner DOES. On a fresh replay this updates nothing, which is correct.
UPDATE public.organizations SET avg_speed_kmh = NULL WHERE avg_speed_kmh = 30;

-- ── What this workspace's own roads turned out to be worth ────────────────
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS measured_speed_kmh numeric,
  ADD COLUMN IF NOT EXISTS measured_road_factor numeric,
  ADD COLUMN IF NOT EXISTS measured_legs integer,
  ADD COLUMN IF NOT EXISTS measured_at timestamptz;

COMMENT ON COLUMN public.organizations.measured_speed_kmh IS
  'Median km/h across this organization''s own cached road legs. Written by refresh_road_profile(), never by a person. NULL until enough legs exist.';
COMMENT ON COLUMN public.organizations.measured_road_factor IS
  'Median road-km per straight-line-km across the same legs. Same provenance.';
COMMENT ON COLUMN public.organizations.avg_speed_kmh IS
  'What the owner typed, or NULL for "work it out". Was NOT NULL DEFAULT 30 with 30 read as unset; see 20260903090000.';

CREATE OR REPLACE FUNCTION public.refresh_road_profile(_org_id uuid)
RETURNS TABLE(speed_kmh numeric, road_factor numeric, legs integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  _n int; _speed numeric; _factor numeric;
  -- Enough legs that one bad batch cannot move the median. A single day of
  -- 26 stops is ~750 legs, so this is reached on the first day anybody routes
  -- and is not a barrier to the feature working.
  _min_legs CONSTANT int := 50;
BEGIN
  SELECT count(*),
         percentile_cont(0.5) WITHIN GROUP (
           ORDER BY (rl.meters / 1000.0) / (rl.seconds / 3600.0)),
         percentile_cont(0.5) WITHIN GROUP (
           ORDER BY (rl.meters / 1000.0)
                    / NULLIF(public.haversine_km(rl.from_lat::float8, rl.from_lon::float8,
                                                 rl.to_lat::float8,   rl.to_lon::float8), 0))
    INTO _n, _speed, _factor
    FROM public.road_legs rl
   WHERE rl.organization_id = _org_id
     AND rl.fetched_at > now() - interval '90 days'
     -- Legs under half a minute are car parks and cul-de-sacs: the duration is
     -- dominated by the router's own start-up cost and the implied speed is
     -- meaningless. They are still USED for their own leg, just not averaged.
     AND rl.seconds > 30
     AND rl.meters > 0;

  IF _n < _min_legs THEN
    UPDATE public.organizations
       SET measured_speed_kmh = NULL, measured_road_factor = NULL,
           measured_legs = _n, measured_at = now()
     WHERE id = _org_id;
    RETURN QUERY SELECT NULL::numeric, NULL::numeric, _n;
    RETURN;
  END IF;

  -- Clamped, so that a router returning nonsense for one city degrades to a
  -- bad-but-survivable estimate rather than to a route planned at 900 km/h.
  _speed  := LEAST(GREATEST(_speed, 5), 120);
  _factor := LEAST(GREATEST(_factor, 1.0), 3.0);

  UPDATE public.organizations
     SET measured_speed_kmh = round(_speed, 2),
         measured_road_factor = round(_factor, 3),
         measured_legs = _n,
         measured_at = now()
   WHERE id = _org_id;

  RETURN QUERY SELECT round(_speed, 2), round(_factor, 3), _n;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_road_profile(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_road_profile(uuid) TO service_role;

-- ── The two estimators, asking the roads first ────────────────────────────
--
-- Both keep their shape: prefer a measured leg, fall back to geometry. What
-- changes is where the geometry gets its constants. Neither may run a
-- percentile -- plan_route calls drive_minutes once per ordered pair, so a
-- 26-stop day is ~750 calls and the profile has to be a column read.
CREATE OR REPLACE FUNCTION public.drive_minutes(_org_id uuid, _lat1 double precision, _lon1 double precision, _lat2 double precision, _lon2 double precision)
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

  SELECT avg_speed_kmh, traffic_profile, road_factor, area_type, park_walk_min,
         measured_speed_kmh, measured_road_factor
    INTO _o FROM public.organizations WHERE id = _org_id;

  SELECT rl.seconds INTO _secs
    FROM public.road_legs rl
   WHERE rl.organization_id = _org_id
     AND rl.from_lat = round(_lat1::numeric, 5) AND rl.from_lon = round(_lon1::numeric, 5)
     AND rl.to_lat   = round(_lat2::numeric, 5) AND rl.to_lon   = round(_lon2::numeric, 5)
     AND rl.fetched_at > now() - interval '90 days';

  -- The road itself. Everything below this line is what we do when nobody has
  -- driven this pair yet.
  IF _secs IS NOT NULL THEN
    RETURN _secs / 60.0 + COALESCE(_o.park_walk_min, 2);
  END IF;

  _km := public.haversine_km(_lat1, _lon1, _lat2, _lon2)
         * COALESCE(_o.measured_road_factor, _o.road_factor, 1.30);

  -- Measured, then typed, then the table. `<> 30` is gone: a typed 30 is now a
  -- speed of 30 like any other number.
  _speed := COALESCE(
              _o.measured_speed_kmh,
              _o.avg_speed_kmh,
              public.effective_speed_kmh(_o.area_type, _o.traffic_profile));

  RETURN (_km / NULLIF(_speed, 0)) * 60.0 + COALESCE(_o.park_walk_min, 2);
END;
$function$;

REVOKE ALL ON FUNCTION public.drive_minutes(uuid, double precision, double precision, double precision, double precision) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.drive_minutes(uuid, double precision, double precision, double precision, double precision) TO service_role;

CREATE OR REPLACE FUNCTION public.road_km(_org_id uuid, _lat1 double precision, _lon1 double precision, _lat2 double precision, _lon2 double precision)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
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

  -- The same detour factor drive_minutes uses, so the kilometres and the
  -- minutes on a route screen keep describing one journey. That pairing is
  -- what 20260831130000 was for and it must not come apart here.
  SELECT COALESCE(o.measured_road_factor, o.road_factor, 1.30) INTO _factor
    FROM public.organizations o WHERE o.id = _org_id;

  RETURN public.haversine_km(_lat1, _lon1, _lat2, _lon2) * COALESCE(_factor, 1.30);
END;
$function$;

REVOKE ALL ON FUNCTION public.road_km(uuid, double precision, double precision, double precision, double precision) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.road_km(uuid, double precision, double precision, double precision, double precision) TO service_role;

-- ── Backfill, so this takes effect on the next plan and not the one after ──
--
-- Every workspace that has already measured legs gets its profile now. A fresh
-- replay has no organizations and no legs, so this updates nothing and says so
-- rather than looking like it ran.
DO $backfill$
DECLARE _r record; _n int := 0; _done int := 0;
BEGIN
  FOR _r IN SELECT id FROM public.organizations LOOP
    _n := _n + 1;
    PERFORM public.refresh_road_profile(_r.id);
    IF EXISTS (SELECT 1 FROM public.organizations o
                WHERE o.id = _r.id AND o.measured_speed_kmh IS NOT NULL) THEN
      _done := _done + 1;
    END IF;
  END LOOP;
  IF _n = 0 THEN
    RAISE WARNING 'no organizations on this build, so no road profile was measured; the estimator falls through to the typed value and then to effective_speed_kmh, exactly as before';
  ELSE
    RAISE WARNING 'road profile measured for % of % organizations; the rest have fewer than 50 cached legs and keep the configured estimate until they route a day', _done, _n;
  END IF;
END $backfill$;

-- ── What this migration establishes ───────────────────────────────────────
DO $est$
DECLARE _n int;
BEGIN
  -- The sentinel is gone from every estimator. Comments stripped: the prose
  -- above quotes the old expression in order to say it is gone.
  SELECT count(*) INTO _n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('drive_minutes', 'road_km')
     AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') LIKE '%<> 30%';
  IF _n <> 0 THEN
    RAISE EXCEPTION 'expected no estimator to still read 30 as "unset", found %', _n;
  END IF;

  -- "Unset" is now expressible, which is the whole repair.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organizations'
       AND column_name = 'avg_speed_kmh' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'avg_speed_kmh is still NOT NULL, so it still cannot say "unset"';
  END IF;

  -- And both estimators agree about how far a road is, which is the property
  -- 20260831130000 established and this file must not break.
  SELECT count(*) INTO _n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('drive_minutes', 'road_km')
     AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') LIKE '%measured_road_factor%';
  IF _n <> 2 THEN
    RAISE EXCEPTION 'expected both estimators to use one detour factor, found %', _n;
  END IF;
END $est$;

-- ── And a way to say "work it out" after having said a number ─────────────
--
-- Every argument to this RPC is COALESCEd against the existing column, so NULL
-- has always meant "leave this alone". That was fine while every field was
-- NOT NULL. Now that avg_speed_kmh can be unset, the screen needs to be able
-- to unset it -- and it cannot, because the value that means "clear" is the
-- same one that means "don't touch".
--
-- Resolved with a separate flag rather than a magic speed. Inventing a
-- number that means "no number" is the fault this migration exists to remove,
-- and doing it again one function down would be funny rather than clever.
CREATE OR REPLACE FUNCTION public.update_org_dispatch_settings(
  _org_id uuid,
  _workday_start time without time zone DEFAULT NULL::time without time zone,
  _workday_end time without time zone DEFAULT NULL::time without time zone,
  _avg_speed_kmh integer DEFAULT NULL::integer,
  _traffic_profile text DEFAULT NULL::text,
  _max_drive_minutes integer DEFAULT NULL::integer,
  _timezone text DEFAULT NULL::text,
  _work_days integer[] DEFAULT NULL::integer[],
  _auto_generate_days_ahead integer DEFAULT NULL::integer,
  _notify_schedule_horizon boolean DEFAULT NULL::boolean,
  _clear_avg_speed boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), _org_id, 'owner')
    OR public.has_role(auth.uid(), _org_id, 'office_manager')
  ) THEN
    RAISE EXCEPTION 'Not authorized to update dispatch settings';
  END IF;
  IF _avg_speed_kmh IS NOT NULL AND (_avg_speed_kmh < 5 OR _avg_speed_kmh > 120) THEN
    RAISE EXCEPTION 'Invalid average speed';
  END IF;
  IF COALESCE(_clear_avg_speed, false) AND _avg_speed_kmh IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot set and clear the average speed in one call';
  END IF;
  IF _traffic_profile IS NOT NULL AND _traffic_profile NOT IN ('light', 'normal', 'heavy') THEN
    RAISE EXCEPTION 'Invalid traffic profile';
  END IF;
  IF _max_drive_minutes IS NOT NULL AND (_max_drive_minutes < 15 OR _max_drive_minutes > 1440) THEN
    RAISE EXCEPTION 'Invalid max drive minutes';
  END IF;
  IF _work_days IS NOT NULL AND (
    array_length(_work_days, 1) IS NULL
    OR array_length(_work_days, 1) > 7
    OR EXISTS (SELECT 1 FROM unnest(_work_days) d WHERE d < 0 OR d > 6)
  ) THEN
    RAISE EXCEPTION 'Invalid work days';
  END IF;
  IF _auto_generate_days_ahead IS NOT NULL
     AND (_auto_generate_days_ahead < 1 OR _auto_generate_days_ahead > 365) THEN
    RAISE EXCEPTION 'Schedule horizon must be between 1 and 365 days';
  END IF;

  UPDATE public.organizations
     SET workday_start = COALESCE(_workday_start, workday_start),
         workday_end = COALESCE(_workday_end, workday_end),
         avg_speed_kmh = CASE WHEN COALESCE(_clear_avg_speed, false) THEN NULL
                              ELSE COALESCE(_avg_speed_kmh, avg_speed_kmh) END,
         traffic_profile = COALESCE(_traffic_profile, traffic_profile),
         max_drive_minutes = COALESCE(_max_drive_minutes, max_drive_minutes),
         timezone = COALESCE(_timezone, timezone),
         work_days = COALESCE(_work_days, work_days),
         auto_generate_days_ahead =
           COALESCE(_auto_generate_days_ahead, auto_generate_days_ahead),
         notify_schedule_horizon =
           COALESCE(_notify_schedule_horizon, notify_schedule_horizon)
   WHERE id = _org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization not found';
  END IF;
END;
$function$;

-- The old ten-argument signature is a separate function to Postgres, and
-- leaving it in place would mean a caller that omits the new flag silently
-- reaches a body that cannot clear. One entry point, not two.
DROP FUNCTION IF EXISTS public.update_org_dispatch_settings(
  uuid, time without time zone, time without time zone, integer, text, integer,
  text, integer[], integer, boolean);

REVOKE ALL ON FUNCTION public.update_org_dispatch_settings(
  uuid, time without time zone, time without time zone, integer, text, integer,
  text, integer[], integer, boolean, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.update_org_dispatch_settings(
  uuid, time without time zone, time without time zone, integer, text, integer,
  text, integer[], integer, boolean, boolean) TO authenticated, service_role;

DO $one_entry$
DECLARE _n int;
BEGIN
  SELECT count(*) INTO _n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'update_org_dispatch_settings';
  IF _n <> 1 THEN
    RAISE EXCEPTION 'expected exactly one update_org_dispatch_settings, found % -- an overload a caller could reach by omitting an argument', _n;
  END IF;
END $one_entry$;
