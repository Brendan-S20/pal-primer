-- Finding #26: explicit "is a field technician" flag + "temporarily unavailable"
-- toggle so non-field roles and out-today techs are excluded from routing
-- without deleting the account. Applied to live via Supabase MCP on 2026-07-10.
ALTER TABLE public.staff
  ADD COLUMN IF NOT EXISTS is_field_tech boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS routing_available boolean NOT NULL DEFAULT true;

UPDATE public.staff
   SET is_field_tech = (role = 'tech')
 WHERE is_field_tech IS DISTINCT FROM (role = 'tech');
