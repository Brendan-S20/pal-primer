-- ROLLBACK for 20261028130000_a-groom-can-be-booked-from-the-link.sql (#560).
--
-- WHAT THIS UNDOES:
--   • Drops signup_requests.groom_booking and its object check.
--
-- WHAT THIS DOES **NOT** UNDO — read before running:
--   • Application CODE is reverted by git. Run this only with a code revert:
--     createSignupPaymentIntent writes groom_booking for every groom booked
--     online, and that insert fails once the column is gone.
--   • A signup request still waiting on its webhook loses its booking, and
--     the webhook then provisions it as a plain plan with no time. Run this
--     when no groom signup is pending:
--       SELECT count(*) FROM public.signup_requests
--        WHERE groom_booking IS NOT NULL AND status = 'pending';
--   • Grooms already booked are plans and visits like any office booking,
--     and stay.
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/rollback/20261028130000_a-groom-can-be-booked-from-the-link.down.sql

BEGIN;

ALTER TABLE public.signup_requests
  DROP CONSTRAINT IF EXISTS signup_requests_groom_booking_is_object;
ALTER TABLE public.signup_requests
  DROP COLUMN IF EXISTS groom_booking;

COMMIT;
