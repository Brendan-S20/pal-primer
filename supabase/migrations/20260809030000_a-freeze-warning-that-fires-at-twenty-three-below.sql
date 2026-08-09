-- The weather board was in Celsius, and nobody using it reads Celsius.
--
-- Open-Meteo's defaults are Celsius, km/h and millimetres. The forecast
-- request never asked for anything else, so a dispatcher running a pet-waste
-- business in Texas saw "36°" on a 97°F day, a bare "23" beside a wind icon
-- with no unit at all, and a "hard freeze" warning wired to `temp_max <= -5` —
-- twenty-three degrees Fahrenheit, written as a number no US forecast prints.
--
-- The fix is in application code: the request now asks for fahrenheit / mph /
-- inch, and the risk thresholds are restated as the same temperatures and
-- speeds in the new units. This migration exists because of what that change
-- does to THIS TABLE.
--
-- ── WHY THE CACHE CANNOT BE LEFT ALONE ────────────────────────────────────
--
-- Every row here holds a jsonb payload of numbers with no units in it, keyed
-- only by rounded coordinates and a date range. Nothing in the key, and
-- nothing in the payload, records which unit system produced it.
--
-- So on the deploy that flips the request, every existing row becomes a
-- Celsius forecast that the new code will read as Fahrenheit and show without
-- hesitation. A 30°C day reads as 30°F and trips the freeze warning. Rows stay
-- servable for three hours by the freshness rule, and — this is the worse part
-- — INDEFINITELY by the stale-fallback rule, which serves a cached row of any
-- age whenever the API errors. A rate-limited afternoon three months from now
-- would resurrect a Celsius row and label it Fahrenheit.
--
-- Two things close that. The column records the units a payload was fetched
-- in, and it joins the uniqueness key and the lookup, so a row fetched under
-- one unit system can never be returned to code asking for another. And the
-- existing rows are deleted rather than backfilled: they are cache entries
-- with a three-hour freshness window, so deleting them costs one API call per
-- coordinate and removes any chance of mislabelling data we would otherwise
-- have to convert and trust.
--
-- The default is 'imperial' because that is what the code now asks for, and a
-- row written by a deploy that raced this migration should be readable. There
-- is exactly one writer (the server, via service_role) and it always sets the
-- column explicitly.

DO $pre$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'weather_forecast_cache'
  ) THEN
    RAISE EXCEPTION 'weather_forecast_cache is missing; expected it from 20260714090000';
  END IF;
  -- The constraint this replaces. If it is already gone, something else has
  -- been reshaping this table and the assumptions above need re-checking.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.weather_forecast_cache'::regclass
       AND contype = 'u'
       AND conname = 'weather_forecast_cache_lat_key_lon_key_from_date_to_date_key'
  ) THEN
    RAISE EXCEPTION 'the (lat,lon,from,to) unique constraint is not where this migration expects it';
  END IF;
END
$pre$;

ALTER TABLE public.weather_forecast_cache
  ADD COLUMN IF NOT EXISTS units text NOT NULL DEFAULT 'imperial';

ALTER TABLE public.weather_forecast_cache DROP CONSTRAINT IF EXISTS weather_forecast_cache_units_check;
ALTER TABLE public.weather_forecast_cache
  ADD CONSTRAINT weather_forecast_cache_units_check
  CHECK (units IN ('imperial', 'metric'));

COMMENT ON COLUMN public.weather_forecast_cache.units IS
  'Which unit system the payload numbers are in. Part of the uniqueness key so '
  'a cached forecast can never be served to code expecting the other system — '
  'the payload itself carries bare numbers and cannot be inspected for this.';

-- Every row predates the column and is therefore Celsius/km/h/mm, which the
-- DEFAULT above has just mislabelled as imperial. Delete rather than relabel:
-- these are cache entries with a three-hour freshness window, and a wrong
-- forecast shown confidently is worse than one extra API call.
DELETE FROM public.weather_forecast_cache;

ALTER TABLE public.weather_forecast_cache
  DROP CONSTRAINT IF EXISTS weather_forecast_cache_lat_key_lon_key_from_date_to_date_key;
ALTER TABLE public.weather_forecast_cache
  ADD CONSTRAINT weather_forecast_cache_coords_range_units_key
  UNIQUE (lat_key, lon_key, from_date, to_date, units);

DO $post$
DECLARE _left integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'weather_forecast_cache'
       AND column_name = 'units'
  ) THEN
    RAISE EXCEPTION 'units column was not added';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.weather_forecast_cache'::regclass
       AND conname = 'weather_forecast_cache_coords_range_units_key'
  ) THEN
    RAISE EXCEPTION 'the units-aware unique constraint was not created';
  END IF;

  -- The upsert in cachedForecast names its conflict target explicitly. If the
  -- old constraint survived, both would exist and the ON CONFLICT clause would
  -- resolve against the wrong one, quietly overwriting an imperial row with a
  -- metric one under the same key.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.weather_forecast_cache'::regclass
       AND conname = 'weather_forecast_cache_lat_key_lon_key_from_date_to_date_key'
  ) THEN
    RAISE EXCEPTION 'the old coordinate-only unique constraint is still present';
  END IF;

  SELECT count(*) INTO _left FROM public.weather_forecast_cache;
  IF _left <> 0 THEN
    RAISE EXCEPTION '% Celsius row(s) survived the purge', _left;
  END IF;
END
$post$;
