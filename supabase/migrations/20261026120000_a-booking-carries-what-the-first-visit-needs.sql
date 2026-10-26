-- A booking carries what the first visit needs (#527).
--
-- The booking link's step 2 asked for a name, an email, a phone, an address
-- and one free-text box, so a business that had just been paid had to ring
-- the customer to learn the pets' names, how to get in and when to start. The
-- form now asks all three (lib/booking-details.ts), and they are stored on
-- the two rows a booking writes:
--
--   signup_requests  what the Stripe webhook provisions from: pets become
--                    `dogs` rows on the new property, access notes become
--                    properties.access_notes (the line My Day and the visit
--                    drawer show under Access), and the start date becomes
--                    the subscription's started_on, which visit generation
--                    walks from.
--   leads            what the office reads in Leads, for a quote request as
--                    much as for a signup.
--
-- `pets` is a JSON array of {name, breed} rather than a child table: it is
-- what a stranger typed, held until the webhook makes real `dogs` rows from
-- it, and nothing joins on it. Nothing here touches a price.
--
-- Additive and nullable, so it replays into an empty database and every
-- existing row reads as "not asked".

ALTER TABLE public.signup_requests
  ADD COLUMN IF NOT EXISTS pets jsonb,
  ADD COLUMN IF NOT EXISTS access_notes text,
  ADD COLUMN IF NOT EXISTS preferred_start_date date;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS pets jsonb,
  ADD COLUMN IF NOT EXISTS access_notes text,
  ADD COLUMN IF NOT EXISTS preferred_start_date date;

COMMENT ON COLUMN public.signup_requests.pets IS
  'What the visitor typed per pet, as [{name, breed}] (#527). Provisioning makes dogs rows from it.';
COMMENT ON COLUMN public.signup_requests.access_notes IS
  'Gate code or access notes from the booking link (#527). Provisioning copies it to properties.access_notes.';
COMMENT ON COLUMN public.signup_requests.preferred_start_date IS
  'The day the visitor asked to start (#527). Provisioning starts the subscription on it.';
COMMENT ON COLUMN public.leads.pets IS 'Pets named on the booking link, as [{name, breed}] (#527).';
COMMENT ON COLUMN public.leads.access_notes IS 'Gate code or access notes from the booking link (#527).';
COMMENT ON COLUMN public.leads.preferred_start_date IS 'The day the visitor asked to start (#527).';

-- The shapes the server writes (lib/booking-details.ts caps both), held by
-- the database too: a constraint costs nothing and outlives the code that
-- respects it.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['signup_requests', 'leads'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = format('public.%I', t)::regclass
         AND conname = t || '_pets_is_a_short_array'
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (pets IS NULL OR (jsonb_typeof(pets) = ''array'' AND jsonb_array_length(pets) <= 20))',
        t, t || '_pets_is_a_short_array'
      );
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = format('public.%I', t)::regclass
         AND conname = t || '_access_notes_length'
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (access_notes IS NULL OR char_length(access_notes) <= 500)',
        t, t || '_access_notes_length'
      );
    END IF;
  END LOOP;
END
$$;
