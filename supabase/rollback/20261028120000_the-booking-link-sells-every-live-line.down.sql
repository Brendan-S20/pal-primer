-- ROLLBACK for 20261028120000_the-booking-link-sells-every-live-line.sql (#560).
--
-- WHAT THIS UNDOES:
--   • public_services filters on customer_requestable_service_lines() and
--     office_booked_service_lines() again, and lists only priced services
--     (plus pet waste), as 20261027200000 left it.
--   • public_quote filters on the same two lists again.
--   So training, grooming and unpriced services leave every booking link
--   at once, as they were before #560.
--
-- WHAT THIS DOES **NOT** UNDO — read before running:
--   • Application CODE is reverted by git, not by this script. The app reads
--     the rule too (bookingLinkOffersLine, src/lib/service-lines.ts). A
--     database rolled back under the new code lists less than the app would
--     show, which is safe: the picker shows what public_services returns,
--     and checkout re-asks public_quote, which then prices nothing for a
--     training or groom service. Code rolled back without this script is the
--     unsafe direction: run this first, or with the revert.
--   • Leads and signups written while it was live keep their service_id and
--     their message (the add-ons and sizes the visitor named). Nothing is
--     deleted.
--   • The comment on office_booked_service_lines() keeps the newer wording.
--
-- Each RPC is spliced back, the inverse of the forward file: its newest body
-- read with pg_get_functiondef on the NAMED function, one anchor that must
-- occur exactly once, replaced, and executed. A body that already reads
-- customer_requestable_service_lines() is left alone, so running this twice
-- is a no-op. Not a migration: it lives outside supabase/migrations so no
-- replay ever runs it.
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/rollback/20261028120000_the-booking-link-sells-every-live-line.down.sql

BEGIN;

DO $splice$
DECLARE
  _def text;
  _from CONSTANT text := 'AND s.service_line = ANY (public.bookable_service_lines())
     ORDER BY';
  _to   CONSTANT text := 'AND s.service_line = ANY (public.bookable_service_lines())
       AND s.service_line = ANY (public.customer_requestable_service_lines())
       AND s.service_line <> ALL (public.office_booked_service_lines())
       AND (s.service_line = ''pet_waste'' OR s.base_price_cents IS NOT NULL)
     ORDER BY';
  _n integer;
BEGIN
  _def := pg_get_functiondef('public.public_services(text)'::regprocedure);
  IF strpos(_def, 'public.customer_requestable_service_lines()') > 0 THEN
    RAISE NOTICE 'public_services already reads customer_requestable_service_lines(); leaving it alone.';
    RETURN;
  END IF;
  _n := (length(_def) - length(replace(_def, _from, ''))) / length(_from);
  IF _n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'public_services contains its bookable filter % time(s), not once; the anchor moved.', _n;
  END IF;
  EXECUTE replace(_def, _from, _to);
END
$splice$;

DO $splice$
DECLARE
  _def text;
  _from CONSTANT text := 'AND s.service_line = ANY (public.bookable_service_lines());';
  _to   CONSTANT text := 'AND s.service_line = ANY (public.bookable_service_lines())
        AND s.service_line = ANY (public.customer_requestable_service_lines())
        AND s.service_line <> ALL (public.office_booked_service_lines());';
  _n integer;
BEGIN
  _def := pg_get_functiondef('public.public_quote(text, text, integer, text, text, uuid)'::regprocedure);
  IF strpos(_def, 'public.customer_requestable_service_lines()') > 0 THEN
    RAISE NOTICE 'public_quote already reads customer_requestable_service_lines(); leaving it alone.';
    RETURN;
  END IF;
  _n := (length(_def) - length(replace(_def, _from, ''))) / length(_from);
  IF _n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'public_quote contains its bookable filter % time(s), not once; the anchor moved.', _n;
  END IF;
  EXECUTE replace(_def, _from, _to);
END
$splice$;

DO $post$
DECLARE
  _fn text;
BEGIN
  FOREACH _fn IN ARRAY ARRAY['public_services', 'public_quote'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname = _fn
         AND p.prosrc LIKE '%s.service_line = ANY (public.bookable_service_lines())%'
         AND p.prosrc LIKE '%s.service_line = ANY (public.customer_requestable_service_lines())%'
         AND p.prosrc LIKE '%s.service_line <> ALL (public.office_booked_service_lines())%'
    ) THEN
      RAISE EXCEPTION '% was not put back on all three filters', _fn;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname = 'public_services'
       AND p.prosrc LIKE '%base_price_cents IS NOT NULL%'
  ) THEN
    RAISE EXCEPTION 'public_services still lists unpriced services';
  END IF;
  IF NOT has_function_privilege('anon', 'public.public_services(text)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.public_quote(text, text, integer, text, text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the public signup lost public_services or public_quote';
  END IF;
END
$post$;

COMMIT;
