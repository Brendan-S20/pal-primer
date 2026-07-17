-- QA round 3 phase 6 (C2): commercial properties carry an explicit
-- "has units" flag + total unit count so zone pricing uses TOTAL units (not
-- dog-owning units); zones gain a per-waste-station commercial rate.

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS has_units boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS total_units integer CHECK (total_units IS NULL OR total_units >= 0);

ALTER TABLE public.zones
  ADD COLUMN IF NOT EXISTS commercial_per_station_cents integer CHECK (commercial_per_station_cents IS NULL OR commercial_per_station_cents >= 0);

-- Idempotent backfill (I5): commercial properties that already have unit rows
-- are marked has_units, and total_units is set to at least the roster count.
-- Properties without unit rows are left alone (no guessing).
UPDATE public.properties p
   SET has_units = true,
       total_units = GREATEST(
         COALESCE(p.total_units, 0),
         (SELECT count(*)::int FROM public.property_units pu WHERE pu.property_id = p.id)
       )
 WHERE EXISTS (SELECT 1 FROM public.property_units pu WHERE pu.property_id = p.id)
   AND (p.has_units IS DISTINCT FROM true
        OR p.total_units IS DISTINCT FROM GREATEST(
             COALESCE(p.total_units, 0),
             (SELECT count(*)::int FROM public.property_units pu2 WHERE pu2.property_id = p.id)
           ));
