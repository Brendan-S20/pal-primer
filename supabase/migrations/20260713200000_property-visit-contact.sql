-- P3.5: billing-contact vs property-contact split. A property can name its
-- own on-site contact (e.g. the tenant at a landlord-billed rental): they
-- receive visit-lifecycle notifications (reminder / on-my-way / completed /
-- weather reschedule) while invoices and billing notices keep going to the
-- client's primary contact. Presence of a value is the routing signal — no
-- separate toggle.

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS visit_contact_name text,
  ADD COLUMN IF NOT EXISTS visit_contact_phone text,
  ADD COLUMN IF NOT EXISTS visit_contact_email text;
