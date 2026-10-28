-- The booking link sells every live line (#560).
--
-- Brendan, 2026-10-28: walking, training and grooming missing from the public
-- booking link is a gap, not a design. Each gets a self-serve path there, with
-- a base price and add-ons. Until this file the two functions the link reaches
-- with the publishable key left three kinds of service out:
--
--   training                  customer_requestable is false on the platform
--                             switch (20261027120000), and both functions
--                             filtered on customer_requestable_service_lines()
--   mobile_grooming           office_booked_service_lines() (20261027200000)
--   a service with no price   public_services listed only priced services, so
--                             Riverbend's walk, set up with no price yet, was
--                             not on its link at all
--
-- What changes, in the two anon doors and nowhere else:
--
--   public_services   lists every active service on a BOOKABLE line, priced
--                     or not. The two filters go, and so does
--                     `(s.service_line = 'pet_waste' OR s.base_price_cents
--                     IS NOT NULL)`. An unpriced service is listed so a
--                     stranger can ask for it; the form sends no price
--                     request for it (isPricedOnline), and public_quote
--                     still answers it with NULL prices, which nothing may
--                     charge (signupChargeFromQuote).
--   public_quote      prices a service on any BOOKABLE line. The two filters
--                     go. A groom is priced here at its base and the app
--                     re-prices it per pet size with groomQuote, the office's
--                     own rule; it is requested, never started online.
--
-- `bookable` stays the gate on both: a Coming soon line is still not for
-- sale (20261024100900's filter is kept). The app has the same rule,
-- bookingLinkOffersLine in src/lib/service-lines.ts.
--
-- What does NOT change, deliberately:
--
--   platform_service_lines        no row is updated. customer_requestable keeps
--                                 its meaning for the doors that cannot ask a
--                                 pet's size or price an add-on: the portal's
--                                 one-off and the receptionist.
--   office_booked_service_lines() still {mobile_grooming}, still the app's
--                                 OFFICE_BOOKED_LINES, now read by the app's
--                                 portal one-off and receptionist only. Its
--                                 comment says so.
--   portal_request_one_off,       untouched. Each keeps reading
--   portal_request_groom          customer_requestable_service_lines().
--
-- Each RPC is spliced, as 20261025200000 and 20261027200000 spliced them: its
-- newest body read with pg_get_functiondef on the NAMED function, one anchor
-- that must occur exactly once, replaced, and executed. Signature, SECURITY
-- DEFINER, search_path and grants are kept by CREATE OR REPLACE. A body that
-- no longer reads customer_requestable_service_lines() is left alone, so a
-- replay is a no-op.
--
-- Replays into an empty database: two splices of functions 20261024100900,
-- 20261025200000 and 20261027200000 create, one comment. No rows read.
-- Idempotent.

-- ── 1. public_services lists every service on a live line ───────────────

DO $splice$
DECLARE
  _def text;
  _from CONSTANT text := 'AND s.service_line = ANY (public.bookable_service_lines())
       AND s.service_line = ANY (public.customer_requestable_service_lines())
       AND s.service_line <> ALL (public.office_booked_service_lines())
       AND (s.service_line = ''pet_waste'' OR s.base_price_cents IS NOT NULL)';
  _to   CONSTANT text := 'AND s.service_line = ANY (public.bookable_service_lines())';
  _n integer;
BEGIN
  _def := pg_get_functiondef('public.public_services(text)'::regprocedure);
  IF strpos(_def, 'public.customer_requestable_service_lines()') = 0 THEN
    RAISE NOTICE 'public_services no longer reads customer_requestable_service_lines(); leaving it alone.';
    RETURN;
  END IF;
  _n := (length(_def) - length(replace(_def, _from, ''))) / length(_from);
  IF _n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION
      'public_services contains its four service filters % time(s), not once; the splice anchor moved.',
      _n;
  END IF;
  EXECUTE replace(_def, _from, _to);
END
$splice$;

-- ── 2. public_quote prices a service on any live line ────────────────────

DO $splice$
DECLARE
  _def text;
  _from CONSTANT text := 'AND s.service_line = ANY (public.bookable_service_lines())
        AND s.service_line = ANY (public.customer_requestable_service_lines())
        AND s.service_line <> ALL (public.office_booked_service_lines());';
  _to   CONSTANT text := 'AND s.service_line = ANY (public.bookable_service_lines());';
  _n integer;
BEGIN
  _def := pg_get_functiondef('public.public_quote(text, text, integer, text, text, uuid)'::regprocedure);
  IF strpos(_def, 'public.customer_requestable_service_lines()') = 0 THEN
    RAISE NOTICE 'public_quote no longer reads customer_requestable_service_lines(); leaving it alone.';
    RETURN;
  END IF;
  _n := (length(_def) - length(replace(_def, _from, ''))) / length(_from);
  IF _n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION
      'public_quote contains its three service filters % time(s), not once; the splice anchor moved.',
      _n;
  END IF;
  EXECUTE replace(_def, _from, _to);
END
$splice$;

-- ── 3. Who reads the office-booked list now ──────────────────────────────

COMMENT ON FUNCTION public.office_booked_service_lines() IS
  'Service lines a customer may ask for but never book through the portal one-off or the receptionist: the office books them. The SQL copy of OFFICE_BOOKED_LINES in src/lib/service-lines.ts; tests/a-stranger-is-not-sold-a-groom.test.ts holds the two equal. Since 20261028120000 the public booking link (public_services, public_quote) does not read it: it prices a groom per pet size and takes it as a request.';

-- ── What this file establishes, checked from any starting state ───────────
DO $post$
DECLARE
  _fn text;
BEGIN
  -- Both anon doors ask the bookable switch and nothing else about the line.
  -- Named functions, read through prosrc, which cannot raise for any kind of
  -- routine.
  FOREACH _fn IN ARRAY ARRAY['public_services', 'public_quote'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname = _fn
         AND p.prosrc LIKE '%s.service_line = ANY (public.bookable_service_lines())%'
    ) THEN
      RAISE EXCEPTION '% no longer filters on bookable_service_lines(); a Coming soon line would be for sale', _fn;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname = _fn
         AND (p.prosrc LIKE '%customer_requestable_service_lines%'
              OR p.prosrc LIKE '%office_booked_service_lines%')
    ) THEN
      RAISE EXCEPTION '% still reads customer_requestable or office_booked; the booking link would hide a live line', _fn;
    END IF;
    IF (SELECT count(*) FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace AND p.proname = _fn) IS DISTINCT FROM 1::bigint THEN
      RAISE EXCEPTION 'public.% has more than one overload; the splice reached only one', _fn;
    END IF;
  END LOOP;

  -- An unpriced service is listed (so a stranger can ask for it).
  IF EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname = 'public_services'
       AND p.prosrc LIKE '%base_price_cents IS NOT NULL%'
  ) THEN
    RAISE EXCEPTION 'public_services still leaves an unpriced service out';
  END IF;

  -- The doors that cannot ask a size or price an add-on keep their gate.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname = 'portal_request_one_off'
       AND p.prosrc LIKE '%customer_requestable_service_lines()%'
  ) THEN
    RAISE EXCEPTION 'portal_request_one_off lost its customer_requestable gate';
  END IF;
  IF public.office_booked_service_lines() IS DISTINCT FROM ARRAY['mobile_grooming']::text[] THEN
    RAISE EXCEPTION 'office_booked_service_lines() is %, not {mobile_grooming}',
      public.office_booked_service_lines();
  END IF;

  -- The grants are what they were.
  IF NOT has_function_privilege('anon', 'public.public_services(text)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.public_quote(text, text, integer, text, text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the public signup lost public_services or public_quote';
  END IF;
  IF has_function_privilege('anon', 'public.office_booked_service_lines()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.bookable_service_lines()', 'EXECUTE') THEN
    RAISE EXCEPTION 'a switch function is callable by anon';
  END IF;
END
$post$;
