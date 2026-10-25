-- One switch decides which service lines are bookable (#531).
--
-- Until now the list was written down in several places that had to change
-- together: BOOKABLE_SERVICE_LINES in src/lib/service-lines.ts (bundled into
-- the iOS and Android builds), public.bookable_service_lines() as a constant
-- array (20261017004000, newest 20261024230000), customerCanRequestService in
-- the same TS file, and its SQL copy, `= 'training'` in
-- portal_request_one_off (20261023100000, carried by 20261024230000). Turning
-- a line on or off took code, a migration and a store build: walking's flip
-- (#530) was exactly that.
--
-- This puts the answer in one table, public.platform_service_lines, one row
-- per line:
--
--   bookable              an owner may ADD the line, and customers may be
--                         sold it. Turning it off refuses only adding: a
--                         business that already runs the line keeps it
--                         (tg_orgs_service_lines_bookable, unchanged).
--   customer_requestable  a customer, the public signup form or the
--                         receptionist may ask for it, once it is also
--                         bookable. Training is sold and scheduled by the
--                         office, and mobile grooming stays with the office
--                         until a customer can pick pets, add-ons and a price
--                         (#535), so both start false.
--
-- Everything reads the table:
--   public.bookable_service_lines()               now reads `bookable`
--   public.customer_requestable_service_lines()   new, reads the second column
--   public.service_line_availability()            new, both columns for the app
--   public_services, public_quote,                spliced to read the second
--   portal_request_one_off                        function as well as the first
--                                                 (portal_request_one_off in
--                                                 place of its 'training' test)
-- The app reads service_line_availability() at runtime through one server
-- function (src/lib/service-line-availability.server.ts), so no build carries
-- the list.
--
-- Who can change it: the service role, and a platform admin (with two-step
-- sign-in, which is_platform_admin requires) through
-- public.set_service_line_availability(). anon and authenticated hold no
-- privilege on the table. Every change writes a platform_admin_audit row,
-- from a trigger, so a service-role UPDATE is logged as well as the RPC.
--
-- The rows seeded here are the list as it is on main after #530 and #535:
-- pet_waste and dog_walking bookable, every other line Coming soon, and every
-- line but training and mobile grooming requestable by a customer. So
-- bookable_service_lines() answers {dog_walking, pet_waste} before and after
-- this file, and nothing a business or a customer can do changes. ON
-- CONFLICT DO NOTHING, so a replay never overwrites a switch a platform admin
-- has already flipped.
--
-- Replays into an empty database: a table, its rows, five functions, a
-- trigger and two splices of named functions. Idempotent.

-- ── 1. The table ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.platform_service_lines (
  service_line text PRIMARY KEY
    CONSTRAINT platform_service_lines_known CHECK (public.service_lines_are_valid(ARRAY[service_line])),
  bookable boolean NOT NULL DEFAULT false,
  customer_requestable boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.platform_service_lines IS
  'Platform switch, one row per service line: whether an owner may add it (bookable) and whether a customer may ask for it (customer_requestable). Read by bookable_service_lines(), customer_requestable_service_lines() and the app. Changed by the service role or set_service_line_availability(); every change is in platform_admin_audit.';

INSERT INTO public.platform_service_lines (service_line, bookable, customer_requestable) VALUES
  ('pet_waste',       true,  true),
  ('dog_walking',     true,  true),
  ('pet_sitting',     false, true),
  ('mobile_grooming', false, false),
  ('training',        false, false),
  ('other',           false, true)
ON CONFLICT (service_line) DO NOTHING;

ALTER TABLE public.platform_service_lines ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.platform_service_lines');

-- No policy for authenticated: nobody reads or writes it with a user's key.
-- The service role bypasses RLS; a platform admin goes through the RPC below.
REVOKE ALL ON TABLE public.platform_service_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.platform_service_lines TO service_role;

-- ── 2. Every change is logged ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tg_platform_service_lines_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.bookable IS NOT DISTINCT FROM OLD.bookable
     AND NEW.customer_requestable IS NOT DISTINCT FROM OLD.customer_requestable THEN
    RETURN NEW;
  END IF;
  -- auth.uid() is the platform admin, or NULL for the service role and for a
  -- migration, which platform_admin_audit reads as "nobody did it".
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  INSERT INTO public.platform_admin_audit (actor_user_id, organization_id, action, before_json, after_json)
  VALUES (
    auth.uid(),
    NULL,
    'service_line_availability',
    CASE WHEN TG_OP = 'UPDATE' THEN jsonb_build_object(
      'service_line', OLD.service_line,
      'bookable', OLD.bookable,
      'customer_requestable', OLD.customer_requestable) END,
    jsonb_build_object(
      'service_line', NEW.service_line,
      'bookable', NEW.bookable,
      'customer_requestable', NEW.customer_requestable)
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.tg_platform_service_lines_audit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS platform_service_lines_audit ON public.platform_service_lines;
CREATE TRIGGER platform_service_lines_audit
  BEFORE UPDATE ON public.platform_service_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_platform_service_lines_audit();

-- ── 3. The readers ───────────────────────────────────────────────────────
--
-- SECURITY DEFINER so the organizations trigger, which runs as the owner's
-- own role, and the anon-callable public_services can read a table that
-- neither role holds a privilege on. STABLE, not IMMUTABLE: the answer now
-- changes without a migration. Nothing indexes or constrains on it.

CREATE OR REPLACE FUNCTION public.bookable_service_lines()
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(array_agg(l.service_line ORDER BY l.service_line), '{}'::text[])
    FROM public.platform_service_lines l
   WHERE l.bookable;
$function$;

REVOKE ALL ON FUNCTION public.bookable_service_lines() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bookable_service_lines() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.customer_requestable_service_lines()
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(array_agg(l.service_line ORDER BY l.service_line), '{}'::text[])
    FROM public.platform_service_lines l
   WHERE l.customer_requestable;
$function$;

REVOKE ALL ON FUNCTION public.customer_requestable_service_lines() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.customer_requestable_service_lines() TO authenticated, service_role;

-- What the app reads, in one round trip.
CREATE OR REPLACE FUNCTION public.service_line_availability()
RETURNS TABLE(service_line text, bookable boolean, customer_requestable boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT l.service_line, l.bookable, l.customer_requestable
    FROM public.platform_service_lines l
   ORDER BY l.service_line;
$function$;

REVOKE ALL ON FUNCTION public.service_line_availability() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.service_line_availability() TO authenticated, service_role;

-- ── 4. The writer for a platform admin ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_service_line_availability(
  _service_line text,
  _bookable boolean,
  _customer_requestable boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT (auth.role() = 'service_role' OR public.is_platform_admin(auth.uid())) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Only a platform admin can change which services are bookable.';
  END IF;
  IF _bookable IS NULL OR _customer_requestable IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22004', MESSAGE = 'Say whether the service is bookable and whether customers can request it.';
  END IF;
  UPDATE public.platform_service_lines
     SET bookable = _bookable, customer_requestable = _customer_requestable
   WHERE service_line = _service_line;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('%s is not a service HoundStack knows about.', _service_line);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_service_line_availability(text, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_service_line_availability(text, boolean, boolean) TO authenticated, service_role;

-- ── 5. The customer doors ask the second switch too ──────────────────────
--
-- portal_request_one_off's training refusal (20261023100000, carried by
-- 20261024230000) becomes "not customer requestable". public_services and
-- public_quote (newest bodies 20261024100900) already filter on
-- bookable_service_lines(); each gains the second filter beside it, so a line
-- that is bookable for the office but not for customers (grooming, training)
-- is neither listed nor priced to a stranger.

DO $splice$
DECLARE
  _def text;
  _from CONSTANT text := 'IF (SELECT s.service_line FROM public.services s WHERE s.id = _service_id) = ''training'' THEN';
  _to   CONSTANT text := 'IF NOT ((SELECT s.service_line FROM public.services s WHERE s.id = _service_id) = ANY (public.customer_requestable_service_lines())) THEN';
  _n integer;
BEGIN
  _def := pg_get_functiondef('public.portal_request_one_off(uuid, uuid, date, text, uuid)'::regprocedure);
  IF strpos(_def, 'public.customer_requestable_service_lines()') > 0 THEN
    RAISE NOTICE 'portal_request_one_off already reads customer_requestable_service_lines(); leaving it alone.';
    RETURN;
  END IF;
  _n := (length(_def) - length(replace(_def, _from, ''))) / length(_from);
  IF _n <> 1 THEN
    RAISE EXCEPTION
      'portal_request_one_off contains the training refusal % time(s), not once; the splice anchor moved.',
      _n;
  END IF;
  EXECUTE replace(_def, _from, _to);
END
$splice$;

DO $splice$
DECLARE
  _def text;
  _from CONSTANT text := 'AND s.service_line = ANY (public.bookable_service_lines())';
  _to   CONSTANT text := 'AND s.service_line = ANY (public.bookable_service_lines())
       AND s.service_line = ANY (public.customer_requestable_service_lines())';
  _n integer;
BEGIN
  _def := pg_get_functiondef('public.public_services(text)'::regprocedure);
  IF strpos(_def, 'public.customer_requestable_service_lines()') > 0 THEN
    RAISE NOTICE 'public_services already reads customer_requestable_service_lines(); leaving it alone.';
    RETURN;
  END IF;
  _n := (length(_def) - length(replace(_def, _from, ''))) / length(_from);
  IF _n <> 1 THEN
    RAISE EXCEPTION
      'public_services contains the bookable filter % time(s), not once; the splice anchor moved.',
      _n;
  END IF;
  EXECUTE replace(_def, _from, _to);
END
$splice$;

DO $splice$
DECLARE
  _def text;
  _from CONSTANT text := 'AND s.service_line = ANY (public.bookable_service_lines());';
  _to   CONSTANT text := 'AND s.service_line = ANY (public.bookable_service_lines())
        AND s.service_line = ANY (public.customer_requestable_service_lines());';
  _n integer;
BEGIN
  _def := pg_get_functiondef('public.public_quote(text, text, integer, text, text, uuid)'::regprocedure);
  IF strpos(_def, 'public.customer_requestable_service_lines()') > 0 THEN
    RAISE NOTICE 'public_quote already reads customer_requestable_service_lines(); leaving it alone.';
    RETURN;
  END IF;
  _n := (length(_def) - length(replace(_def, _from, ''))) / length(_from);
  IF _n <> 1 THEN
    RAISE EXCEPTION
      'public_quote contains the bookable filter % time(s), not once; the splice anchor moved.',
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
  -- Every line the database accepts has a row, so no line is silently absent.
  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY['pet_waste','dog_walking','pet_sitting','mobile_grooming','training','other']) AS k(line)
     WHERE NOT EXISTS (SELECT 1 FROM public.platform_service_lines l WHERE l.service_line = k.line)
  ) THEN
    RAISE EXCEPTION 'platform_service_lines is missing a service line';
  END IF;

  -- The readers read the table; no constant array is left behind.
  FOREACH _fn IN ARRAY ARRAY['bookable_service_lines', 'customer_requestable_service_lines'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname = _fn
         AND p.prosrc LIKE '%public.platform_service_lines%'
         AND p.prosrc NOT LIKE '%ARRAY[%'
         AND p.prosecdef
    ) THEN
      RAISE EXCEPTION '% does not read platform_service_lines', _fn;
    END IF;
  END LOOP;

  -- The three customer doors ask the table, not a line name.
  FOREACH _fn IN ARRAY ARRAY['public_services', 'public_quote', 'portal_request_one_off'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname = _fn
         AND p.prosrc LIKE '%public.customer_requestable_service_lines()%'
         AND p.prosrc LIKE '%public.bookable_service_lines()%'
         AND p.prosrc NOT LIKE '%<> ''training''%'
         AND p.prosrc NOT LIKE '%= ''training''%'
    ) THEN
      RAISE EXCEPTION '% does not read customer_requestable_service_lines() and bookable_service_lines()', _fn;
    END IF;
  END LOOP;

  -- Nobody changes the switch with a user's key.
  IF has_table_privilege('anon', 'public.platform_service_lines', 'SELECT')
     OR has_table_privilege('anon', 'public.platform_service_lines', 'INSERT')
     OR has_table_privilege('anon', 'public.platform_service_lines', 'UPDATE')
     OR has_table_privilege('anon', 'public.platform_service_lines', 'DELETE')
     OR has_table_privilege('authenticated', 'public.platform_service_lines', 'SELECT')
     OR has_table_privilege('authenticated', 'public.platform_service_lines', 'INSERT')
     OR has_table_privilege('authenticated', 'public.platform_service_lines', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.platform_service_lines', 'DELETE') THEN
    RAISE EXCEPTION 'a client role holds a privilege on platform_service_lines';
  END IF;
  IF has_function_privilege('anon', 'public.set_service_line_availability(text, boolean, boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.bookable_service_lines()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.customer_requestable_service_lines()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.service_line_availability()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can call a service line availability function';
  END IF;
  IF has_function_privilege('anon', 'public.tg_platform_service_lines_audit()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tg_platform_service_lines_audit()', 'EXECUTE') THEN
    RAISE EXCEPTION 'tg_platform_service_lines_audit is callable by a client role';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.platform_service_lines'::regclass
       AND tgname = 'platform_service_lines_audit'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'platform_service_lines_audit is not on public.platform_service_lines';
  END IF;

  -- The launch gate on organizations still reads the function.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.organizations'::regclass
       AND tgname = 'organizations_service_lines_bookable'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'organizations_service_lines_bookable is not on public.organizations';
  END IF;
END
$post$;
