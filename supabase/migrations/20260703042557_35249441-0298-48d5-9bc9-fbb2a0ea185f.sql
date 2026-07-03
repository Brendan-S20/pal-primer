
ALTER TABLE public.staff
  ADD COLUMN IF NOT EXISTS end_address TEXT,
  ADD COLUMN IF NOT EXISTS end_latitude NUMERIC,
  ADD COLUMN IF NOT EXISTS end_longitude NUMERIC;

ALTER TABLE public.zones
  ADD COLUMN IF NOT EXISTS geo_match_mode TEXT NOT NULL DEFAULT 'zip',
  ADD COLUMN IF NOT EXISTS boundary JSONB,
  ADD COLUMN IF NOT EXISTS center_latitude NUMERIC,
  ADD COLUMN IF NOT EXISTS center_longitude NUMERIC,
  ADD COLUMN IF NOT EXISTS radius_meters INTEGER,
  ADD COLUMN IF NOT EXISTS drive_time_minutes INTEGER;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'zones_geo_match_mode_check'
  ) THEN
    ALTER TABLE public.zones
      ADD CONSTRAINT zones_geo_match_mode_check
      CHECK (geo_match_mode IN ('zip','radius','polygon','drive_time'));
  END IF;
END $$;
