-- Area pricing had a floor and no ceiling.
--
-- `zones.area_min_charge_cents` bounds the area component from BELOW. Nothing
-- bounded it from above, in the column set or in `computeZoneVisitPrice`, so
-- a per-sqft or per-acre rate multiplied by a large enough lot returned an
-- arbitrarily large per-visit price and the quote screen would have shown it.
--
-- Measured on this database before the column was added. One zone prices at
-- 0.75c/sqft over a $20 base with a $25 floor; on a 35,700 sqft yard that
-- returns $287.92 per visit, $489.46 after the biweekly multiplier. The
-- customer on that property pays $26.00.
--
-- Nobody has ever been charged the larger number, and the reason is worth
-- stating because it is the whole shape of the problem: a zone rate is read
-- ONCE, when a subscription is created, and never consulted again. These
-- subscriptions predate the rate. The arithmetic was never wrong in
-- production only because it was never used in production -- which makes it a
-- landmine under any future "recalculate from the zone" feature rather than a
-- live billing fault.
--
-- 4 of the 8 zones price by area (3 per_sqft, 1 per_acre) and all 4 have a
-- floor. None has a ceiling; that is what this adds.
--
-- No default and no backfill. A cap the software picked would be a price the
-- software invented, and picking $200 rather than $60 is a decision about
-- somebody's business. NULL means "no ceiling", which is exactly today's
-- behaviour, so this migration changes no price on its own. What changes is
-- that the WRITE path (update_zone / the zone drawer) refuses to save an
-- area-priced zone without one, so the number gets chosen by the person whose
-- customers it is, the next time that zone is touched.

ALTER TABLE public.zones
  ADD COLUMN IF NOT EXISTS area_max_charge_cents integer;

COMMENT ON COLUMN public.zones.area_max_charge_cents IS
  'Ceiling on the area component of a quote, in cents. NULL means no ceiling, '
  'which is the pre-2026-09 behaviour and is why this has no default -- a cap '
  'chosen by the software would be a price the software invented. Applied '
  'after area_min_charge_cents, so a zone misconfigured with min > max '
  'resolves to the lower of the two rather than the larger.';

ALTER TABLE public.zones
  DROP CONSTRAINT IF EXISTS zones_area_ceiling_above_floor;
ALTER TABLE public.zones
  ADD CONSTRAINT zones_area_ceiling_above_floor
  CHECK (
    area_max_charge_cents IS NULL
    OR area_max_charge_cents >= COALESCE(area_min_charge_cents, 0)
  ) NOT VALID;

-- NOT VALID, then validated in the same file. The two-step is not ceremony:
-- ADD CONSTRAINT takes an ACCESS EXCLUSIVE lock for the whole table scan,
-- while VALIDATE takes a weaker one, and this table is read by every quote and
-- every visit-planning pass. On a fresh replay the table is empty and both are
-- instant; on this database the scan is over 8 rows. The validation is what
-- makes the constraint trustworthy afterwards, so it is not left out.
ALTER TABLE public.zones VALIDATE CONSTRAINT zones_area_ceiling_above_floor;

DO $verify$
DECLARE _n integer; _uncapped integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='zones' AND column_name='area_max_charge_cents'
  ) THEN
    RAISE EXCEPTION 'zones.area_max_charge_cents was not created';
  END IF;

  -- This migration establishes the constraint, so a replay from any starting
  -- state can prove it exists and is validated.
  SELECT count(*) INTO _n
    FROM pg_constraint
   WHERE conrelid = 'public.zones'::regclass
     AND conname = 'zones_area_ceiling_above_floor'
     AND convalidated;
  IF _n <> 1 THEN
    RAISE EXCEPTION 'the ceiling-above-floor constraint is missing or was left NOT VALID';
  END IF;

  -- A MEASUREMENT, not an assertion. On a fresh build there are no zones and
  -- this is zero; on a database with history it is the count of zones that
  -- still quote without a ceiling. Either way it is a fact about rows this
  -- file did not create, so it warns and prints its number rather than
  -- failing a replay that has nothing to do with it.
  SELECT count(*) INTO _uncapped
    FROM public.zones
   WHERE pricing_mode IN ('per_sqft','per_acre')
     AND area_max_charge_cents IS NULL;

  IF _uncapped = 0 THEN
    RAISE NOTICE 'no area-priced zone is quoting without a ceiling.';
  ELSE
    RAISE WARNING
      '% area-priced zone(s) still have no ceiling. Nothing is mispriced today -- a zone rate is only read when a subscription is created -- but each will refuse to save until somebody picks a cap.',
      _uncapped;
  END IF;
END
$verify$;
