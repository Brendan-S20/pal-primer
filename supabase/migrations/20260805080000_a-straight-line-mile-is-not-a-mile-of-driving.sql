-- ETAs were roughly 3-4x too fast, and worst exactly where routing matters.
--
-- The whole model was: great-circle km / one org-wide speed. Two compounding
-- errors:
--
--   1. NO DETOUR FACTOR. Streets are not straight lines. Real road distance
--      runs about 1.2x crow-flight on an open suburban grid and 1.4-1.5x in
--      dense city cores with one-ways and river crossings. Every leg was
--      understated before a single speed was applied.
--
--   2. ONE SPEED, DEFAULT 30 km/h, MEANING "AVERAGE DRIVING SPEED". Applied to
--      a straight line it silently claims 30 km/h of PROGRESS TOWARD THE
--      DESTINATION. Door-to-door in Manhattan — lights, turns, and finding
--      somewhere to stop — is closer to 10-13 km/h of straight-line progress.
--
-- Compounded on the NYC demo: stops 1-6 km apart were quoted 2-11 minute
-- drives where the honest answer is 15-40. The `traffic_profile` knob could not
-- rescue it; even 'heavy' is only 1.43x.
--
-- ── WHAT THIS IS, AND WHAT IT IS NOT ──────────────────────────────────────
--
-- This is a CALIBRATED ESTIMATE, not a routing engine. It does not know about
-- one-way streets, turn restrictions, bridges, or live traffic. It will be
-- wrong on any individual leg — a river between two stops 800m apart will
-- still read as 800m. What it stops being is systematically wrong by 3-4x in
-- one direction, which is the difference between a schedule a dispatcher can
-- use and one they learn to ignore.
--
-- It is deliberately built as ONE function taking two points and returning
-- minutes. Every caller goes through it. Swapping in OSRM or Mapbox later
-- means replacing this body and nothing else — the seam is the point.
--
-- ── PARKING IS PART OF THE DRIVE ──────────────────────────────────────────
--
-- `service_duration_min` is time spent working. In a city the time between
-- stopping the vehicle and starting work — finding a space, walking back — is
-- neither driving nor service, and it was being counted as neither. It is
-- charged per stop here because it scales with stops, not with distance.

ALTER TABLE public.organizations
  -- Road distance / straight-line distance. 1.0 would mean every street runs
  -- exactly toward the next stop.
  ADD COLUMN IF NOT EXISTS road_factor numeric NOT NULL DEFAULT 1.30,
  -- Sets effective door-to-door speed. Named for what the dispatcher knows
  -- about their patch, not for a number they would have to guess.
  ADD COLUMN IF NOT EXISTS area_type text NOT NULL DEFAULT 'suburban',
  -- Minutes per stop for parking and walking from the vehicle.
  ADD COLUMN IF NOT EXISTS park_walk_min numeric NOT NULL DEFAULT 2;

ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_area_type_check;
ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_area_type_check
  CHECK (area_type IN ('dense_urban', 'urban', 'suburban', 'rural'));

ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_road_factor_check;
ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_road_factor_check
  CHECK (road_factor >= 1.0 AND road_factor <= 2.0);

ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_park_walk_check;
ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_park_walk_check
  CHECK (park_walk_min >= 0 AND park_walk_min <= 30);

COMMENT ON COLUMN public.organizations.road_factor IS
  'Road distance divided by straight-line distance. ~1.2 open suburban grid, '
  '~1.45 dense core. Applied before speed.';
COMMENT ON COLUMN public.organizations.area_type IS
  'Sets effective door-to-door speed in effective_speed_kmh(). Overridden by '
  'avg_speed_kmh when a tenant has set that themselves.';

-- ── The one function every caller goes through ────────────────────────────

CREATE OR REPLACE FUNCTION public.effective_speed_kmh(_area_type text, _traffic text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  -- Straight-line progress per hour, NOT speedometer speed. A van doing 40 on
  -- the avenues between lights makes far less than 40 toward the next stop.
  SELECT CASE COALESCE(_area_type, 'suburban')
           WHEN 'dense_urban' THEN 11.0   -- Manhattan, Boston core
           WHEN 'urban'       THEN 18.0   -- city, some arterials
           WHEN 'suburban'    THEN 28.0   -- subdivisions, stop signs
           WHEN 'rural'       THEN 45.0   -- open road between properties
           ELSE 28.0
         END
       * CASE COALESCE(_traffic, 'normal')
           WHEN 'light' THEN 1.15
           WHEN 'heavy' THEN 0.75
           ELSE 1.0
         END;
$$;

CREATE OR REPLACE FUNCTION public.drive_minutes(
  _org_id uuid,
  _lat1 double precision, _lon1 double precision,
  _lat2 double precision, _lon2 double precision
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE _o RECORD; _km numeric; _speed numeric;
BEGIN
  SELECT avg_speed_kmh, traffic_profile, road_factor, area_type, park_walk_min
    INTO _o FROM public.organizations WHERE id = _org_id;

  -- Missing coordinates used to become a flat 5 km — a silent invented drive.
  -- NULL says "unknown" and lets the caller decide, which is the honest answer
  -- and the one that shows up as a gap in the UI rather than as fake precision.
  IF _lat1 IS NULL OR _lon1 IS NULL OR _lat2 IS NULL OR _lon2 IS NULL THEN
    RETURN NULL;
  END IF;

  _km := public.haversine_km(_lat1, _lon1, _lat2, _lon2) * COALESCE(_o.road_factor, 1.30);

  -- A tenant who has set avg_speed_kmh themselves has made a deliberate
  -- statement about their own patch, and it wins. Untouched, it still holds
  -- the old 30 default, which is meaningless as a straight-line rate — so the
  -- area profile is used unless they moved it off the default.
  _speed := CASE
              WHEN _o.avg_speed_kmh IS NOT NULL AND _o.avg_speed_kmh <> 30
                THEN _o.avg_speed_kmh
              ELSE public.effective_speed_kmh(_o.area_type, _o.traffic_profile)
            END;

  RETURN (_km / NULLIF(_speed, 0)) * 60.0 + COALESCE(_o.park_walk_min, 2);
END;
$$;

COMMENT ON FUNCTION public.drive_minutes(uuid, double precision, double precision, double precision, double precision) IS
  'Estimated door-to-door minutes between two points: haversine x road_factor, '
  'divided by an area-appropriate straight-line speed, plus park/walk time. '
  'The single seam for travel time — replace this body to adopt a real routing '
  'API. Returns NULL for unknown coordinates rather than inventing a distance.';

GRANT EXECUTE ON FUNCTION public.effective_speed_kmh(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.drive_minutes(uuid, double precision, double precision, double precision, double precision) TO authenticated;

-- ── The NYC demo org ──────────────────────────────────────────────────────
--
-- Its data is Manhattan and its timezone said America/Chicago, so every
-- optimized ETA was an hour out on top of being too fast.

UPDATE public.organizations
   SET timezone = 'America/New_York',
       area_type = 'dense_urban',
       road_factor = 1.45,
       park_walk_min = 6
 WHERE id IN (
   SELECT o.id FROM public.organizations o
     JOIN public.staff s ON s.organization_id = o.id
    WHERE s.start_address ILIKE '%W 34th St%'
   );
