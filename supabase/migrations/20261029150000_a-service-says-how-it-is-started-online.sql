-- A service says how it is started online (#574). NOT APPLIED: for Helm,
-- after Product APPROVE and Brendan Ready.
--
-- The public booking link's Start service made every service an open-ended
-- weekly prepaid plan: a subscription with no end and visit generation every
-- week. Riverbend's "Evaluation (45 min)" is one session, and a stranger who
-- started it was signed up for an evaluation every week until they canceled.
--
-- The owner decides instead, per service, in Settings -> Services:
--
--   one_time      one visit, charged once. A one_time subscription that ends
--                 the day it starts, so nothing repeats.
--   recurring     the plan it always was: a cadence, prepaid per visit.
--   package       a set of sessions sold at the package's price, from the
--                 service_packages row public_package_id names. No plan.
--   request_only  no Start service and no card: the link asks for a quote.
--
-- NULL reads as request_only (src/lib/public-booking-mode.ts). Nothing in the
-- app branches on a service's NAME; the mode is the only switch.
--
-- Rows that exist today keep what they did, except training: walking,
-- grooming, pet waste and sitting visits stay recurring, a stay (priced per
-- night) is request_only as the link already treats it (#546), and training
-- is one_time, which is what moves Riverbend's Evaluation off the weekly
-- path. A training service the owner sells weekly or as a package is one
-- setting away. New rows get the same rule from a BEFORE INSERT trigger when
-- the insert names no mode, so the seed, ensureTrainingCatalog and imports
-- write an explicit mode without each learning the rule.
--
-- signup_requests keeps what the visitor was sold at checkout (booking_mode,
-- service_package_id), so the Stripe webhook provisions what was charged even
-- if the owner changes the setting in the minutes between.
--
-- Replays into an empty database: two tables 20261009200000 and
-- 20261023100000 create, one trigger, one UPDATE that touches no row on a
-- fresh build. Idempotent.

ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS public_booking_mode text,
  ADD COLUMN IF NOT EXISTS public_package_id uuid
    REFERENCES public.service_packages(id) ON DELETE SET NULL;

ALTER TABLE public.signup_requests
  ADD COLUMN IF NOT EXISTS booking_mode text,
  ADD COLUMN IF NOT EXISTS service_package_id uuid
    REFERENCES public.service_packages(id) ON DELETE SET NULL;

DO $chk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'services_public_booking_mode_chk'
       AND conrelid = 'public.services'::regclass
  ) THEN
    ALTER TABLE public.services
      ADD CONSTRAINT services_public_booking_mode_chk
      CHECK (public_booking_mode IN ('one_time', 'recurring', 'package', 'request_only'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'signup_requests_booking_mode_chk'
       AND conrelid = 'public.signup_requests'::regclass
  ) THEN
    ALTER TABLE public.signup_requests
      ADD CONSTRAINT signup_requests_booking_mode_chk
      CHECK (booking_mode IN ('one_time', 'recurring', 'package'));
  END IF;
END
$chk$;

COMMENT ON COLUMN public.services.public_booking_mode IS
  'How the public booking link starts this service: one_time, recurring, package or request_only. NULL is request_only. #574';
COMMENT ON COLUMN public.services.public_package_id IS
  'For public_booking_mode = package: the service_packages row the link sells. #574';

-- The default for a row inserted with no mode. The same rule as
-- defaultPublicBookingMode in src/lib/public-booking-mode.ts.
CREATE OR REPLACE FUNCTION public.tg_services_public_booking_mode()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NEW.public_booking_mode IS NULL THEN
    NEW.public_booking_mode := CASE
      WHEN NEW.price_unit = 'night' THEN 'request_only'
      WHEN NEW.service_line = 'training' THEN 'one_time'
      ELSE 'recurring'
    END;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_services_public_booking_mode() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS services_public_booking_mode ON public.services;
CREATE TRIGGER services_public_booking_mode
  BEFORE INSERT ON public.services
  FOR EACH ROW EXECUTE FUNCTION public.tg_services_public_booking_mode();

-- Existing rows, by the same rule. Training's Evaluation lands on one_time.
UPDATE public.services
   SET public_booking_mode = CASE
         WHEN price_unit = 'night' THEN 'request_only'
         WHEN service_line = 'training' THEN 'one_time'
         ELSE 'recurring'
       END
 WHERE public_booking_mode IS NULL;

-- ── What this file establishes, checked from any starting state ───────────
DO $post$
DECLARE
  _unset bigint;
  _weekly_training bigint;
BEGIN
  SELECT count(*) INTO _unset FROM public.services WHERE public_booking_mode IS NULL;
  IF _unset > 0 THEN
    RAISE EXCEPTION '% service(s) still have no public booking mode', _unset;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'services_public_booking_mode'
       AND tgrelid = 'public.services'::regclass
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'services has no default for public_booking_mode';
  END IF;
  IF has_function_privilege('anon', 'public.tg_services_public_booking_mode()', 'EXECUTE') THEN
    RAISE EXCEPTION 'tg_services_public_booking_mode is reachable by anon';
  END IF;
  -- A premise, not a product: how many training services this file found on
  -- the weekly path. Zero on a fresh build; printed so the log says so.
  SELECT count(*) INTO _weekly_training FROM public.services
   WHERE service_line = 'training' AND public_booking_mode = 'recurring';
  RAISE WARNING 'training services left recurring after #574 backfill: %', _weekly_training;
END
$post$;
