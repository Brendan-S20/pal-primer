-- Drive times are not a typed speed.
--
-- The owner, 2026-10-02: "I don't think it looks good to ask for a common
-- speed (it shouldn't be based on that)." Settings -> Scheduling asked for an
-- "Average speed (mph)", and drive_minutes used whatever was typed there for
-- every leg the road network had not measured -- ahead of the area table,
-- behind only the speed measured from this organization's own roads.
--
-- One number for a whole service area is the model the road data replaced:
-- 20260826180000 measured a flat speed against OSRM and found single legs off
-- by 2.4x in both directions. So the field is gone from the screen, and this
-- removes it from the arithmetic, leaving the chain as:
--
--   1. the road itself (road_legs, measured, at most 90 days old)
--   2. the organization's MEASURED road profile (refresh_road_profile: the
--      median speed and detour factor of every leg it has driven)
--   3. an internal default by area type (effective_speed_kmh)
--
-- Without step 2 dropping out, removing the field would have stranded every
-- organization that ever typed a number: its speed would keep steering
-- estimates from a setting nobody could see or change any more.
--
-- The column stays. The old SQL planners still read it into a fallback that
-- only fires for a stop with no coordinates (where it is NULL for everyone who
-- never typed one), and update_org_dispatch_settings still accepts it. The app
-- no longer writes it or reads it; dropping it is a later, separate change.
--
-- The TypeScript planner prices unmeasured legs with the same three steps
-- (src/lib/route-inputs.ts), so the two cannot disagree about an estimate.
--
-- Replays into an empty database: one function, replaced whole; its grants
-- are kept by CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION public.drive_minutes(
  _org_id uuid,
  _lat1 double precision, _lon1 double precision,
  _lat2 double precision, _lon2 double precision)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE _o RECORD; _km numeric; _speed numeric; _secs numeric;
BEGIN
  IF _lat1 IS NULL OR _lon1 IS NULL OR _lat2 IS NULL OR _lon2 IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT traffic_profile, road_factor, area_type, park_walk_min,
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
         * COALESCE(_o.measured_road_factor, _o.road_factor, 1.35);

  -- Measured, then the table. Never a typed speed: see the header.
  _speed := COALESCE(
              _o.measured_speed_kmh,
              public.effective_speed_kmh(_o.area_type, _o.traffic_profile));

  RETURN (_km / NULLIF(_speed, 0)) * 60.0 + COALESCE(_o.park_walk_min, 2);
END;
$function$;

REVOKE ALL ON FUNCTION public.drive_minutes(uuid, double precision, double precision, double precision, double precision)
  FROM PUBLIC, anon, authenticated;

DO $check$
DECLARE
  _src text;
BEGIN
  SELECT prosrc INTO _src FROM pg_proc
   WHERE oid = 'public.drive_minutes(uuid,double precision,double precision,double precision,double precision)'::regprocedure;
  IF strpos(_src, 'avg_speed_kmh') > 0 THEN
    RAISE EXCEPTION 'drive_minutes still reads the typed average speed';
  END IF;
  IF strpos(_src, 'measured_speed_kmh') = 0 OR strpos(_src, 'effective_speed_kmh') = 0
     OR strpos(_src, 'road_legs') = 0 THEN
    RAISE EXCEPTION 'drive_minutes lost one of its three sources (road, measured profile, area default)';
  END IF;
  IF has_function_privilege('authenticated',
       'public.drive_minutes(uuid,double precision,double precision,double precision,double precision)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.drive_minutes(uuid,double precision,double precision,double precision,double precision)', 'EXECUTE') THEN
    RAISE EXCEPTION 'drive_minutes is callable from the browser again';
  END IF;
END
$check$;
