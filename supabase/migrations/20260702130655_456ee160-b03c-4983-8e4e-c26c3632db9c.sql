ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS boundary jsonb,
  ADD COLUMN IF NOT EXISTS boundary_area_sqm numeric;