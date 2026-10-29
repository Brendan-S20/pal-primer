-- A service says how it is started from the booking link (#574).
-- NOT APPLIED: for Helm, after Product APPROVE and Brendan Ready.
--
-- Until now every service a stranger could buy online became the same thing
-- after the card: an active prepaid subscription on a weekly (or biweekly,
-- monthly) cadence, with its visits generated out to the horizon. That is
-- right for a walk or a yard cleanup and wrong for a training evaluation,
-- which is one session: Riverbend's "Evaluation (45 min)" became an open
-- weekly plan the moment it was paid for.
--
-- services.public_booking_mode is the owner's answer, set in Settings ->
-- Services:
--
--   one_time      one visit, charged once; no repeating plan
--   recurring     a cadence, prepaid per visit, as every service was
--   package       a training package (service_packages): N sessions, the
--                 package price charged once, sessions tracked on the
--                 client_packages row the office already uses
--   request_only  the link takes a quote request; no card, nothing provisioned
--
-- NULL is read as request_only by the app. Nothing below leaves a bookable
-- row NULL, and the BEFORE INSERT trigger gives every new row an explicit
-- answer, so "unset" only happens if someone clears it by hand.
--
-- services.public_package_id names the package a `package` service sells.
-- It must be one of this service's own packages (the trigger checks), so a
-- walk cannot sell a training package.
--
-- signup_requests.booking_mode and .service_package_id are the snapshot the
-- webhook provisions from: the mode and package as they were when the card
-- was taken, so an owner who flips a service between a visitor's quote and
-- their payment does not change what that visitor bought.
--
-- Backfill, by line and price unit, never by name:
--   * per-night services (stays) are request_only, as #546 already treats them;
--   * training is one_time: a lesson or an evaluation bought online is one
--     session until the owner says otherwise (this moves Riverbend's
--     Evaluation off the weekly path);
--   * every other line stays recurring, which is exactly how it behaves today.
-- Only rows still NULL are touched, so a replay never overwrites an owner's
-- choice.
--
-- Replays into an empty database: two ADD COLUMN IF NOT EXISTS on tables
-- earlier migrations create, a trigger, and UPDATEs that touch zero rows on a
-- fresh build. The checks at the bottom assert only what this file
-- establishes. Idempotent.

ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS public_booking_mode text,
  ADD COLUMN IF NOT EXISTS public_package_id uuid
    REFERENCES public.service_packages(id) ON DELETE SET NULL;

DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'services_public_booking_mode_check'
                   AND conrelid = 'public.services'::regclass) THEN
    ALTER TABLE public.services ADD CONSTRAINT services_public_booking_mode_check
      CHECK (public_booking_mode IS NULL
             OR public_booking_mode IN ('one_time', 'recurring', 'package', 'request_only'));
  END IF;
END
$c$;

COMMENT ON COLUMN public.services.public_booking_mode IS
  'How the public booking link starts this service (#574): one_time, recurring, package or request_only. NULL reads as request_only. Set by the owner in Settings -> Services.';
COMMENT ON COLUMN public.services.public_package_id IS
  'The service_packages row a package-mode service sells on the booking link (#574). Must belong to this service.';

ALTER TABLE public.signup_requests
  ADD COLUMN IF NOT EXISTS booking_mode text,
  ADD COLUMN IF NOT EXISTS service_package_id uuid
    REFERENCES public.service_packages(id) ON DELETE SET NULL;

DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'signup_requests_booking_mode_check'
                   AND conrelid = 'public.signup_requests'::regclass) THEN
    ALTER TABLE public.signup_requests ADD CONSTRAINT signup_requests_booking_mode_check
      CHECK (booking_mode IS NULL OR booking_mode IN ('one_time', 'recurring', 'package'));
  END IF;
END
$c$;

COMMENT ON COLUMN public.signup_requests.booking_mode IS
  'The service''s public_booking_mode when the card was taken (#574). NULL is a signup from before the column: recurring.';

-- The default a new row gets, and the package check.
CREATE OR REPLACE FUNCTION public.services_public_booking_mode()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.public_booking_mode IS NULL THEN
    NEW.public_booking_mode := CASE
      WHEN NEW.price_unit = 'night' THEN 'request_only'
      WHEN NEW.service_line = 'training' THEN 'one_time'
      ELSE 'recurring'
    END;
  END IF;
  IF NEW.public_package_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.service_packages p
     WHERE p.id = NEW.public_package_id
       AND p.service_id = NEW.id
       AND p.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'Choose one of this service''s own packages.';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.services_public_booking_mode() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS services_public_booking_mode ON public.services;
CREATE TRIGGER services_public_booking_mode
  BEFORE INSERT OR UPDATE OF public_booking_mode, public_package_id ON public.services
  FOR EACH ROW EXECUTE FUNCTION public.services_public_booking_mode();

-- Backfill. Stays first, then training, then everything else as today.
UPDATE public.services SET public_booking_mode = 'request_only'
 WHERE public_booking_mode IS NULL AND price_unit = 'night';
UPDATE public.services SET public_booking_mode = 'one_time'
 WHERE public_booking_mode IS NULL AND service_line = 'training';
UPDATE public.services SET public_booking_mode = 'recurring'
 WHERE public_booking_mode IS NULL;

-- ── What this file establishes, checked from any starting state ─────────
DO $post$
DECLARE
  _n integer;
BEGIN
  SELECT count(*) INTO _n FROM public.services WHERE public_booking_mode IS NULL;
  IF _n > 0 THEN
    RAISE EXCEPTION '% service(s) still have no public booking mode', _n;
  END IF;
  SELECT count(*) INTO _n FROM public.services
   WHERE price_unit = 'night' AND public_booking_mode <> 'request_only';
  IF _n > 0 THEN
    RAISE WARNING '% per-night service(s) are not request_only; the link still asks for a stay by request (#546)', _n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'services_public_booking_mode'
                    AND tgrelid = 'public.services'::regclass) THEN
    RAISE EXCEPTION 'services_public_booking_mode trigger is missing';
  END IF;
END
$post$;
