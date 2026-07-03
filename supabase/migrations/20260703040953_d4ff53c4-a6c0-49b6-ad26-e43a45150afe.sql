ALTER TABLE public.zones
  ADD COLUMN IF NOT EXISTS pricing_mode text NOT NULL DEFAULT 'flat',
  ADD COLUMN IF NOT EXISTS price_per_sqft_cents numeric(10,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS price_per_acre_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS area_min_charge_cents integer NOT NULL DEFAULT 0;

ALTER TABLE public.zones
  DROP CONSTRAINT IF EXISTS zones_pricing_mode_check;
ALTER TABLE public.zones
  ADD CONSTRAINT zones_pricing_mode_check
  CHECK (pricing_mode IN ('flat','per_sqft','per_acre'));