-- A groom can be booked from the booking link (#560).
--
-- Brendan, 2026-10-28: a groom on the public booking link needs BOTH paths.
-- The priced request stays (sizes and add-ons priced, the office confirms a
-- time). Beside it, a visitor may book a time and pay for the first groom.
--
-- The booking itself is the office's: the Stripe webhook calls
-- bookGroomAppointment (src/lib/groom-booking.server.ts) once the card has
-- gone through, with the client, property and pets it has just created. That
-- function prices the pets and add-ons, checks the day and the groomer's
-- other grooms, stores the plan's start time, length, summary and add-ons,
-- and generates the visits. What it needs from the visitor has to survive
-- from the payment intent to the webhook, and signup_requests is where every
-- other answer waits. This is the one column it was missing:
--
--   signup_requests.groom_booking   jsonb, NULL for anything that is not a
--                                   groom booked online. An object:
--                                   start_time ("HH:MM", the business's
--                                   clock), pet_sizes (one size or "" per
--                                   pet), add_on_ids, every_weeks (2, 4, or
--                                   null for one groom). The date is the row's
--                                   own preferred_start_date.
--
-- Only the service role writes signup_requests (createSignupPaymentIntent),
-- and no policy changes. Nothing reads the column but the webhook.
--
-- Replays into an empty database: one nullable column and one constraint on a
-- table that exists. No rows read. Idempotent.

ALTER TABLE public.signup_requests
  ADD COLUMN IF NOT EXISTS groom_booking jsonb;

ALTER TABLE public.signup_requests
  DROP CONSTRAINT IF EXISTS signup_requests_groom_booking_is_object;
ALTER TABLE public.signup_requests
  ADD CONSTRAINT signup_requests_groom_booking_is_object
  CHECK (groom_booking IS NULL OR jsonb_typeof(groom_booking) = 'object');

COMMENT ON COLUMN public.signup_requests.groom_booking IS
  'A groom booked from the booking link (#560): start_time, pet_sizes, add_on_ids, every_weeks. The webhook books it with bookGroomAppointment on the row''s preferred_start_date. NULL for every other signup.';

-- ── What this file establishes, checked from any starting state ───────────
DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'signup_requests'
       AND column_name = 'groom_booking' AND data_type = 'jsonb' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'signup_requests.groom_booking is not a nullable jsonb column';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.signup_requests'::regclass
       AND conname = 'signup_requests_groom_booking_is_object'
  ) THEN
    RAISE EXCEPTION 'signup_requests_groom_booking_is_object is missing';
  END IF;
END
$post$;
