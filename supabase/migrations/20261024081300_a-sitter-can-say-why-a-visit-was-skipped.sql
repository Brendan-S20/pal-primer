-- New enum values commit before they are used by visit writes. The existing
-- default_skip_billable_pct ELSE branch charges zero for these reasons.
ALTER TYPE public.skip_reason_code ADD VALUE IF NOT EXISTS 'pet_hiding';
ALTER TYPE public.skip_reason_code ADD VALUE IF NOT EXISTS 'client_home';
