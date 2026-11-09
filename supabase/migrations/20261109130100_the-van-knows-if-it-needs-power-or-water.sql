-- The van knows whether it needs to plug in (#412).
--
-- A mobile groomer's van runs its dryer and tub off the house more often than
-- not: an outdoor outlet, a hose bib. Where the van parks has been on the
-- address since July (properties.parking_notes), and the groomer reads it on
-- My Day. Whether there is power or water to hook up to was a line somebody
-- might or might not write in that note, so the groomer found out in the
-- driveway with a dog already on the table.
--
-- Two flags on the address, both default false (nothing is claimed for an
-- address nobody has asked about):
--   van_power_available  an outlet the van may plug into
--   van_water_available  a hose bib or tap the van may fill from
--
-- The office sets them with the parking notes (the address drawer, and Book
-- a groom). The groomer reads them on the groom card and the field client
-- view. Pet-waste businesses never see them: every place that draws them is
-- grooming-only.
--
-- No new table; properties' existing policies decide who reads and writes.
-- Since 20261015215000 authenticated reads properties through a COLUMN grant
-- (the access codes are withheld), so a new column is unreadable until it is
-- granted: both are granted here, as every screen that draws them selects
-- them with the caller's own client. INSERT and UPDATE are still table grants.
-- Replays into an empty database: two columns with defaults and their grant.
-- Idempotent.

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS van_power_available boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS van_water_available boolean NOT NULL DEFAULT false;

GRANT SELECT (van_power_available, van_water_available) ON public.properties TO authenticated;

COMMENT ON COLUMN public.properties.van_power_available IS
  'Mobile grooming: the van may plug into an outlet at this address.';
COMMENT ON COLUMN public.properties.van_water_available IS
  'Mobile grooming: the van may fill from a hose bib or tap at this address.';

DO $post$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'properties'
         AND column_name IN ('van_power_available', 'van_water_available')) <> 2 THEN
    RAISE EXCEPTION 'properties van hookup columns are missing';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.properties', 'van_power_available', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.properties', 'van_water_available', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated cannot read the van hookup columns';
  END IF;
END
$post$;
