-- Grooming reasons must not borrow yard codes and their default skip fees.
-- default_skip_billable_pct falls back to zero for these codes. No existing
-- reason, billing override, visit or pet-waste record is changed.
ALTER TYPE public.skip_reason_code ADD VALUE IF NOT EXISTS 'pet_not_ready';
ALTER TYPE public.skip_reason_code ADD VALUE IF NOT EXISTS 'client_not_home';
ALTER TYPE public.skip_reason_code ADD VALUE IF NOT EXISTS 'no_parking';
ALTER TYPE public.skip_reason_code ADD VALUE IF NOT EXISTS 'pet_stressed';
