-- An add-on names its service line (#640).
--
-- Book a groom listed the business's pet waste add-ons: yard deodorizer,
-- station liner refill. addon_services.service_line arrived with grooming
-- (20261024100000) as a nullable column, and every add-on made before it,
-- including every demo add-on seed_demo_org writes, was left null. The groom
-- pickers read null as "offered with any service", so a groom offered them.
--
-- Every one of those rows predates service lines, when the product sold pet
-- waste only, so pet_waste is what they are. This sets them to pet_waste,
-- gives the column that default so the seeder and the unit incident catalog
-- row (neither names a line) keep working, and makes it NOT NULL so "no line"
-- cannot be written again. The app stops reading null as any service in the
-- same change.
--
-- Replays into an empty database: the UPDATE touches no rows there, and the
-- checks below are about the column, not about any data.

UPDATE public.addon_services SET service_line = 'pet_waste' WHERE service_line IS NULL;

ALTER TABLE public.addon_services ALTER COLUMN service_line SET DEFAULT 'pet_waste';
ALTER TABLE public.addon_services ALTER COLUMN service_line SET NOT NULL;

DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'addon_services'
      AND column_name = 'service_line' AND is_nullable = 'NO'
      AND column_default LIKE '''pet_waste''%'
  ) THEN
    RAISE EXCEPTION 'addon_services.service_line is not NOT NULL DEFAULT pet_waste';
  END IF;
  IF EXISTS (SELECT 1 FROM public.addon_services WHERE service_line IS NULL) THEN
    RAISE EXCEPTION 'an add-on still has no service line';
  END IF;
END
$post$;
