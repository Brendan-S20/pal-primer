-- Six organizations, two road factors, and a default that would have made a
-- third the moment anybody signed up.
--
-- ── WHAT DISAGREED ────────────────────────────────────────────────────────
--
--   Demo Pet Waste Co            1.45     110 properties
--   the other five               1.30     the column default
--
-- 1.45 is not a considered alternative. It was set by the same UPDATE, in the
-- same statement, as the `dense_urban` that 20260911200000 has just undone:
--
--     SET timezone = 'America/New_York', area_type = 'dense_urban',
--         road_factor = 1.45, park_walk_min = 6
--
-- under a heading reading "The NYC demo org". It is a Manhattan leftover, and
-- the column's own COMMENT says as much -- "~1.45 dense core". That
-- organization has not been a dense core since its data moved to Detroit.
--
-- ── SO WHAT IS THE RIGHT NUMBER ───────────────────────────────────────────
--
-- 3,168 real OSRM legs for that organization, which is the only workspace on
-- this database that has measured anything at all:
--
--     min 0.996   p10 1.150   p25 1.228   MEDIAN 1.354   p75 1.470   p90 1.670
--
-- and it is not an artifact of short hops, which is where a detour ratio
-- usually goes strange. By straight-line distance band:
--
--     band          legs   median   km-weighted
--     under 0.5 km    56    1.442      1.819
--     0.5-1 km       146    1.420      1.525
--     1-2 km         374    1.395      1.475
--     2-5 km       1,358    1.347      1.380
--     over 5 km    1,232    1.339      1.349
--
-- 2,590 of the 3,166 measurable legs are over 2 km and they sit at 1.34. The
-- number is stable wherever you cut it.
--
-- Both of the values in use were wrong in opposite directions: 1.45 is the
-- p72 of a distribution it was never fitted to, and 1.30 is below the median.
-- So is the guidance that produced them. The column COMMENT has said "~1.2
-- open suburban grid" since 20260805080000, and suburban Detroit measures
-- 1.354 -- nearer the figure that comment reserves for a dense core. 1.2 was
-- a guess written before anybody had driven anything, and it is the reason
-- the default is where it is.
--
-- 1.35 for everybody, which is the measured median rounded to the precision
-- the number deserves.
--
-- ── WHY THE DEFAULT IS THE PART THAT MATTERS ──────────────────────────────
--
-- 20260903090000 gave road_factor a rank. drive_minutes resolves:
--
--     COALESCE(measured_road_factor, road_factor, 1.30)
--
-- Demo Pet Waste Co has measured_road_factor = 1.354, so its configured 1.45
-- is not read at all and never has been since that migration shipped. The
-- five organizations at 1.30 have no measured legs, so for them the column is
-- live. road_factor is the COLD START: what a workspace is costed with until
-- it has routed a day and measured its own roads.
--
-- Which is exactly why setting six rows and stopping would be pointless. The
-- column default is 1.30, so the seventh organization to exist would have
-- reintroduced the disagreement on the day it signed up. The default moves
-- too, and this migration asserts that it did.
--
-- The blast radius is small and self-correcting by construction: a cold-start
-- value governs until refresh_road_profile() has 50 legs, which one routed
-- day of 26 stops passes about fifteen times over.
--
-- ── AND THE THIRD SPELLING ────────────────────────────────────────────────
--
-- `COALESCE(measured_road_factor, road_factor, 1.30)` carries its own 1.30 as
-- a last resort, in drive_minutes once and in road_km twice. road_factor is
-- NOT NULL, so that literal is only reachable when the organization row is
-- missing entirely -- but it is a fourth written answer to "what is the
-- detour factor", and leaving one spelling behind is how the other three got
-- out of step. The bodies are re-issued unchanged apart from that constant.

-- ── The rows ──────────────────────────────────────────────────────────────
DO $rows$
DECLARE _n integer; _before text;
BEGIN
  SELECT string_agg(DISTINCT road_factor::text, ', ' ORDER BY road_factor::text)
    INTO _before FROM public.organizations;

  UPDATE public.organizations SET road_factor = 1.35 WHERE road_factor <> 1.35;
  GET DIAGNOSTICS _n = ROW_COUNT;

  IF _n = 0 THEN
    RAISE WARNING 'no organization needed re-costing (0 rows): either a fresh build, which has none, or every row is already at 1.35';
  ELSE
    RAISE NOTICE 'road_factor was [%] across % organization(s), now 1.35 for all', _before, _n;
  END IF;
END $rows$;

-- ── The default, so the next signup does not start the argument again ─────
ALTER TABLE public.organizations ALTER COLUMN road_factor SET DEFAULT 1.35;

COMMENT ON COLUMN public.organizations.road_factor IS
  'Road distance divided by straight-line distance, used until this workspace '
  'has measured its own -- see measured_road_factor, which outranks it. 1.35 '
  'is the median of 3,168 OSRM legs in suburban Detroit and is stable from '
  '0.5 km to 20 km. Raise it for a dense core with one-ways and river '
  'crossings; the old guidance of ~1.2 for a suburban grid was a guess and '
  'measured too low.';

-- ── The two estimators, so one number is spelled one way ──────────────────
--
-- Verbatim from 20260903090000 except for the fallback constant. They keep
-- their shape: prefer a measured leg, fall back to geometry. Neither may run
-- a percentile -- plan_route calls drive_minutes once per ordered pair, so a
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
         * COALESCE(_o.measured_road_factor, _o.road_factor, 1.35);

  -- Measured, then typed, then the table.
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
  SELECT COALESCE(o.measured_road_factor, o.road_factor, 1.35) INTO _factor
    FROM public.organizations o WHERE o.id = _org_id;

  RETURN public.haversine_km(_lat1, _lon1, _lat2, _lon2) * COALESCE(_factor, 1.35);
END;
$function$;

REVOKE ALL ON FUNCTION public.road_km(uuid, double precision, double precision, double precision, double precision) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.road_km(uuid, double precision, double precision, double precision, double precision) TO service_role;

-- ── What this migration establishes ───────────────────────────────────────
--
-- Every one of these is provable from any starting state, including an empty
-- database, which is why they are EXCEPTIONs. "No row disagrees" is satisfied
-- by there being no rows.
DO $est$
DECLARE _n integer; _default text; _bad text;
BEGIN
  SELECT count(*) INTO _n FROM public.organizations WHERE road_factor <> 1.35;
  IF _n > 0 THEN
    RAISE EXCEPTION 'road_factor still disagrees on % organization(s)', _n;
  END IF;

  SELECT column_default INTO _default
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'organizations'
     AND column_name = 'road_factor';
  IF _default IS NULL OR _default NOT LIKE '1.35%' THEN
    RAISE EXCEPTION 'the column default is %, so the next organization would disagree again',
      COALESCE(_default, 'unset');
  END IF;

  -- prosrc, not pg_get_functiondef: it is the body, it cannot raise for any
  -- prokind, and both functions are named rather than scanned for.
  SELECT string_agg(p.proname, ', ') INTO _bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('drive_minutes', 'road_km')
     AND (p.prosrc LIKE '%1.30%' OR p.prosrc NOT LIKE '%1.35%');
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'an estimator still spells the detour factor its own way: %', _bad;
  END IF;

  RAISE NOTICE 'one road factor, in the rows, in the default, and in both estimators';
END $est$;

-- ── What it only measures ─────────────────────────────────────────────────
--
-- A premise, not a product: this compares 1.35 against whatever THIS database
-- has driven, and a fresh build has driven nothing. It warns either way, and
-- says out loud when it had nothing to measure, so that "the number checks
-- out" and "nothing was checked" cannot look the same in a log.
DO $premise$
DECLARE _r record; _any boolean := false;
BEGIN
  FOR _r IN
    SELECT name, measured_road_factor AS f, measured_legs AS legs
      FROM public.organizations
     WHERE measured_road_factor IS NOT NULL
     ORDER BY measured_legs DESC
  LOOP
    _any := true;
    RAISE WARNING 'measured: % says % from % legs, against the 1.35 now configured (% %% away)',
      _r.name, _r.f, _r.legs, round((1.35 - _r.f) / _r.f * 100, 1);
  END LOOP;

  IF NOT _any THEN
    RAISE WARNING 'SKIPPED: no organization on this build has measured a road factor, so 1.35 was not checked against anything here; it comes from 3,168 legs on the production database';
  END IF;
END $premise$;
