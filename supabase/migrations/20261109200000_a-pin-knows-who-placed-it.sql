-- A property's pin records who produced it and when (#529 / #745).
--
-- Decision (Brendan, 2026-11-09): Google Maps Platform for geocoding and
-- routing, and Google-derived data is refreshed or dropped after 30 days to
-- stay inside Google Maps Platform's caching terms. A pin could not be
-- expired by source before this file, because nothing recorded the source:
-- properties.address_source says where the ADDRESS TEXT came from (the picker
-- or typing), not who turned it into coordinates.
--
--   geocode_source  'google' (Geocoding API), 'google_places' (a Places
--                   Details lookup from the address search box), 'geocodio',
--                   'nominatim', 'manual' (a person placed it), or NULL --
--                   unknown, which is every pin written before this file.
--   geocoded_at     when that point was fetched.
--
-- Only 'google' and 'google_places' expire (src/lib/geocode-source.ts, applied
-- daily by /api/public/hooks/google-cache-expiry, scheduled in
-- 20261109200100). NULL is never expired: a pin of unknown origin may not be
-- Google's, and the decision rules out dropping a non-Google coordinate.
-- That also means pins saved from the Google address box BEFORE this file
-- are not covered; they carry no label to expire by.
--
-- No backfill, for that reason: labelling old pins 'google_places' because
-- their address_source is 'matched' would be a guess, and a wrong guess here
-- deletes a coordinate.

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS geocode_source text,
  ADD COLUMN IF NOT EXISTS geocoded_at timestamptz;

DO $con$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'properties_geocode_source_known'
                    AND conrelid = 'public.properties'::regclass) THEN
    ALTER TABLE public.properties
      ADD CONSTRAINT properties_geocode_source_known
      CHECK (geocode_source IS NULL
             OR geocode_source IN ('google', 'google_places', 'geocodio', 'nominatim', 'manual'));
  END IF;
END
$con$;

COMMENT ON COLUMN public.properties.geocode_source IS
  'Who produced latitude/longitude: google, google_places, geocodio, nominatim, manual, or NULL (unknown). google and google_places are refreshed or cleared after 30 days (src/lib/geocode-source.ts).';
COMMENT ON COLUMN public.properties.geocoded_at IS
  'When latitude/longitude were fetched. With geocode_source, decides Google-cache expiry.';

-- The daily job's query: Google-sourced pins, oldest first.
CREATE INDEX IF NOT EXISTS idx_properties_google_geocoded_at
  ON public.properties (geocoded_at)
  WHERE geocode_source IN ('google', 'google_places');

-- properties is column-granted since 20261015215000: a new column is withheld
-- from signed-in users until it is granted. These two are not secrets; the
-- property drawer reads geocode_source so a save keeps it.
GRANT SELECT (geocode_source, geocoded_at) ON TABLE public.properties TO authenticated;

-- ── Check what this file established ────────────────────────────────────────

DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'properties'
                    AND column_name = 'geocode_source' AND data_type = 'text') THEN
    RAISE EXCEPTION 'properties.geocode_source is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'properties'
                    AND column_name = 'geocoded_at'
                    AND data_type = 'timestamp with time zone') THEN
    RAISE EXCEPTION 'properties.geocoded_at is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'properties_geocode_source_known'
                    AND conrelid = 'public.properties'::regclass) THEN
    RAISE EXCEPTION 'properties_geocode_source_known is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
                  AND indexname = 'idx_properties_google_geocoded_at') THEN
    RAISE EXCEPTION 'idx_properties_google_geocoded_at is missing';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.properties', 'geocode_source', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.properties', 'geocoded_at', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated cannot read the new provenance columns';
  END IF;
END
$check$;
