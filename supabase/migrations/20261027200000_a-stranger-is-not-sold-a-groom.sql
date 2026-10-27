-- A stranger is not sold a groom (#559, follow-up to #549 / #558).
--
-- 20261027180000 turned mobile_grooming on in BOTH columns of
-- public.platform_service_lines, so a client may ask for a groom from the
-- portal (portal_request_groom). But public_services and public_quote, the
-- two functions the public signup and booking link reach with the
-- publishable key, filter only on the switch:
--
--   s.service_line = ANY (public.bookable_service_lines())
--   s.service_line = ANY (public.customer_requestable_service_lines())
--
-- and both lists now hold mobile_grooming. So anon could list a grooming
-- business's grooms with names and prices, and price one through
-- public_quote. The app never offers one: every customer door asks
-- customerCanBookService (src/lib/service-lines.ts), which leaves out
-- OFFICE_BOOKED_LINES = ["mobile_grooming"]. A groom is priced by each pet's
-- size and coat and timed with its add-ons, which a flat service price
-- cannot say, so the office books it. The database had no equivalent.
--
-- This adds that equivalent and puts it where the publishable key meets it:
--
--   public.office_booked_service_lines()   new. The SQL copy of
--                                          OFFICE_BOOKED_LINES, a constant:
--                                          {mobile_grooming}.
--   public_services                        gains
--   public_quote                             AND s.service_line <> ALL (public.office_booked_service_lines())
--                                          beside the switch filters, so an
--                                          office-booked service is treated
--                                          exactly like a Coming soon one:
--                                          public_services leaves it out,
--                                          public_quote answers nothing.
--
-- Why a constant and not a third column on platform_service_lines: the two
-- columns there are policy, a platform admin's to flip with no build. This is
-- not. Whether a customer can book a groom themselves depends on code that
-- does not exist yet (picking pets, add-ons and a price, #535), so turning it
-- off without a build would open a door the app cannot walk through. It
-- changes with code, so it lives with the code, in two copies held equal by
-- tests/a-stranger-is-not-sold-a-groom.test.ts (it reads the LAST migration
-- that defines this function and compares its array to OFFICE_BOOKED_LINES).
--
-- Not touched: portal_request_groom, the intended customer path (a client
-- asks, the office books); portal_request_one_off, which is the server's to
-- call and not anon's (the app refuses a groom there, portalRequestOneOff);
-- every switch row: pet waste, walking, sitting, training and grooming keep
-- their bookable and customer_requestable values.
--
-- Each RPC is spliced, not restated, as 20261025200000 spliced them: its
-- newest body read with pg_get_functiondef on the NAMED function, one anchor
-- that must occur exactly once, replaced, and executed. Signature, SECURITY
-- DEFINER, search_path and grants are kept by CREATE OR REPLACE. A body that
-- already reads office_booked_service_lines() is left alone, so a replay is
-- a no-op.
--
-- Replays into an empty database: one function and two splices of functions
-- 20261024100900 and 20261025200000 create. No rows read. Idempotent.

-- ── 1. Which lines the office books ──────────────────────────────────────
--
-- STABLE rather than IMMUTABLE, so a later migration that changes the list
-- (or makes it read a table) is never folded into a cached plan.

CREATE OR REPLACE FUNCTION public.office_booked_service_lines()
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT ARRAY['mobile_grooming']::text[];
$function$;

COMMENT ON FUNCTION public.office_booked_service_lines() IS
  'Service lines a customer may ask for but never book or price themselves: the office books them. The SQL copy of OFFICE_BOOKED_LINES in src/lib/service-lines.ts; tests/a-stranger-is-not-sold-a-groom.test.ts holds the two equal. Read by public_services and public_quote (20261027200000).';

REVOKE ALL ON FUNCTION public.office_booked_service_lines() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.office_booked_service_lines() TO authenticated, service_role;

-- ── 2. public_services leaves an office-booked service out ───────────────

DO $splice$
DECLARE
  _def text;
  _from CONSTANT text := 'AND s.service_line = ANY (public.customer_requestable_service_lines())';
  _to   CONSTANT text := 'AND s.service_line = ANY (public.customer_requestable_service_lines())
       AND s.service_line <> ALL (public.office_booked_service_lines())';
  _n integer;
BEGIN
  _def := pg_get_functiondef('public.public_services(text)'::regprocedure);
  IF strpos(_def, 'public.office_booked_service_lines()') > 0 THEN
    RAISE NOTICE 'public_services already reads office_booked_service_lines(); leaving it alone.';
    RETURN;
  END IF;
  _n := (length(_def) - length(replace(_def, _from, ''))) / length(_from);
  IF _n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION
      'public_services contains the customer requestable filter % time(s), not once; the splice anchor moved.',
      _n;
  END IF;
  EXECUTE replace(_def, _from, _to);
END
$splice$;

-- ── 3. public_quote prices an office-booked service as an unknown one ─────

DO $splice$
DECLARE
  _def text;
  _from CONSTANT text := 'AND s.service_line = ANY (public.customer_requestable_service_lines());';
  _to   CONSTANT text := 'AND s.service_line = ANY (public.customer_requestable_service_lines())
        AND s.service_line <> ALL (public.office_booked_service_lines());';
  _n integer;
BEGIN
  _def := pg_get_functiondef('public.public_quote(text, text, integer, text, text, uuid)'::regprocedure);
  IF strpos(_def, 'public.office_booked_service_lines()') > 0 THEN
    RAISE NOTICE 'public_quote already reads office_booked_service_lines(); leaving it alone.';
    RETURN;
  END IF;
  _n := (length(_def) - length(replace(_def, _from, ''))) / length(_from);
  IF _n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION
      'public_quote contains the customer requestable filter % time(s), not once; the splice anchor moved.',
      _n;
  END IF;
  EXECUTE replace(_def, _from, _to);
END
$splice$;

-- ── What this file establishes, checked from any starting state ───────────
DO $post$
DECLARE
  _fn text;
BEGIN
  -- The list is the app's list.
  IF public.office_booked_service_lines() IS DISTINCT FROM ARRAY['mobile_grooming']::text[] THEN
    RAISE EXCEPTION 'office_booked_service_lines() is %, not {mobile_grooming}',
      public.office_booked_service_lines();
  END IF;

  -- Both anon doors ask it, and still ask both switches. Named functions,
  -- read through prosrc, which cannot raise for any kind of routine.
  FOREACH _fn IN ARRAY ARRAY['public_services', 'public_quote'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname = _fn
         AND p.prosrc LIKE '%s.service_line <> ALL (public.office_booked_service_lines())%'
         AND p.prosrc LIKE '%s.service_line = ANY (public.customer_requestable_service_lines())%'
         AND p.prosrc LIKE '%s.service_line = ANY (public.bookable_service_lines())%'
    ) THEN
      RAISE EXCEPTION '% does not filter on office_booked_service_lines() beside both switches', _fn;
    END IF;
    IF (SELECT count(*) FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace AND p.proname = _fn) IS DISTINCT FROM 1::bigint THEN
      RAISE EXCEPTION 'public.% has more than one overload; the splice reached only one', _fn;
    END IF;
  END LOOP;

  -- The portal's groom request is the intended customer path: not gated here.
  IF EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname = 'portal_request_groom'
       AND p.prosrc LIKE '%office_booked_service_lines%'
  ) THEN
    RAISE EXCEPTION 'portal_request_groom reads office_booked_service_lines(); a client must still be able to ask for a groom';
  END IF;

  -- The grants are what they were.
  IF NOT has_function_privilege('anon', 'public.public_services(text)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.public_quote(text, text, integer, text, text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the public signup lost public_services or public_quote';
  END IF;
  IF has_function_privilege('anon', 'public.office_booked_service_lines()', 'EXECUTE') THEN
    RAISE EXCEPTION 'office_booked_service_lines is callable by anon';
  END IF;
END
$post$;
