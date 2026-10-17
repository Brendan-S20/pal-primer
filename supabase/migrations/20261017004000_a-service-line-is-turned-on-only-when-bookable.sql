-- A service line is turned on only when it is bookable.
--
-- setServiceLines (src/lib/org-features.functions.ts) refuses adding a line
-- outside BOOKABLE_SERVICE_LINES, but it writes through the owner's own client,
-- and "Owners update own org" lets that same owner PATCH organizations over
-- REST with any set service_lines_are_valid accepts. This trigger puts the
-- launch gate in the database too.
--
-- The rule is the app's, line for line (serviceLinesAdditionProblem):
--   UPDATE  a line already in OLD.service_lines may stay or be removed. Only a
--           line that is new in NEW and not bookable is refused, so a business
--           that already runs walking and sitting keeps them.
--   INSERT  every line that is not bookable is refused.
--
-- The service role is allowed (seeding, admin tooling), detected the way
-- tg_orgs_protect_platform_columns does: auth.role() = 'service_role'. A
-- session with no request JWT at all (a migration, psql, cron) is also
-- allowed, unless it is running as anon or authenticated.
--
-- public.bookable_service_lines() is the one SQL copy of
-- BOOKABLE_SERVICE_LINES in src/lib/service-lines.ts. A line that goes live
-- changes both; tests/a-service-line-is-turned-on-only-when-bookable.test.ts
-- fails while they differ.
--
-- Idempotent.

CREATE OR REPLACE FUNCTION public.bookable_service_lines()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT ARRAY['pet_waste']::text[];
$function$;

REVOKE ALL ON FUNCTION public.bookable_service_lines() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bookable_service_lines() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.tg_orgs_service_lines_bookable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  _added text;
BEGIN
  IF auth.role() = 'service_role'
     OR (auth.role() IS NULL AND current_user NOT IN ('anon', 'authenticated')) THEN
    RETURN NEW;
  END IF;

  SELECT line INTO _added
    FROM unnest(NEW.service_lines) WITH ORDINALITY AS l(line, n)
   WHERE NOT (line = ANY (public.bookable_service_lines()))
     AND (TG_OP = 'INSERT' OR NOT (line = ANY (COALESCE(OLD.service_lines, '{}'::text[]))))
   ORDER BY n
   LIMIT 1;

  IF _added IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = format('The %s service is coming soon and cannot be turned on yet.', _added),
      HINT = 'service_line_not_bookable';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.tg_orgs_service_lines_bookable() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS organizations_service_lines_bookable ON public.organizations;
CREATE TRIGGER organizations_service_lines_bookable
  BEFORE INSERT OR UPDATE OF service_lines ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_orgs_service_lines_bookable();

DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.organizations'::regclass
       AND tgname = 'organizations_service_lines_bookable'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'organizations_service_lines_bookable is not on public.organizations';
  END IF;
  IF has_function_privilege('anon', 'public.tg_orgs_service_lines_bookable()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tg_orgs_service_lines_bookable()', 'EXECUTE') THEN
    RAISE EXCEPTION 'tg_orgs_service_lines_bookable is callable by a client role';
  END IF;
  IF has_function_privilege('anon', 'public.bookable_service_lines()', 'EXECUTE') THEN
    RAISE EXCEPTION 'bookable_service_lines is callable by anon';
  END IF;
  IF NOT public.service_lines_are_valid(public.bookable_service_lines()) THEN
    RAISE EXCEPTION 'bookable_service_lines() holds a value service_lines_are_valid refuses';
  END IF;
END
$check$;
