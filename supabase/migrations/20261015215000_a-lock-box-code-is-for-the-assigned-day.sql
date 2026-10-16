-- A gate code, lock box code, key location and key tag are not readable
-- through a plain properties SELECT.
--
-- For a walk client the gate code is often the door code to the house. Before
-- this file any tech who ever had a visit at the property could read it, because
-- may_read_property_row has no date limit. Now it is served the same way as the
-- lock box code.
--
-- authenticated holds table-level SELECT on properties (the original grant).
-- Revoking those four columns on their own would not take them away, because
-- a table grant covers every column. This file revokes table SELECT from
-- authenticated and grants SELECT back on every other column that exists now.
-- A later migration that adds a properties column has to grant that column
-- too, or signed-in users cannot read it.
--
-- Only SELECT changes. INSERT and UPDATE on these columns are untouched, so
-- the office still writes them. A write must not ask for them back in a
-- RETURNING list (a PostgREST .select() after insert or update).
--
-- may_read_property_row still decides who can see the property. The calendar
-- feed reads gate_code inside calendar_feed_events, which is SECURITY DEFINER
-- and runs as its owner, so this revoke does not reach it. No view and no
-- SECURITY INVOKER function in supabase/migrations reads these columns.
--
-- property_access_codes returns the four columns only to the office
-- (view_client_directory) or to the tech assigned to a visit at that property
-- today, in the business's timezone. The tech's staff row must be active and
-- the visit must be scheduled or in progress. A visit canceled, skipped or
-- completed today no longer gives the codes. Neither does a staff member who
-- was turned off.

REVOKE SELECT ON TABLE public.properties FROM PUBLIC, anon, authenticated;

DO $grant$
DECLARE
  _cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
    INTO _cols
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'properties'
     AND column_name NOT IN ('gate_code', 'lock_box_code', 'key_location', 'key_tag');
  IF _cols IS NULL
     OR _cols NOT LIKE '%street%'
     OR _cols LIKE '%gate_code%'
     OR _cols LIKE '%lock_box_code%' THEN
    RAISE EXCEPTION 'properties column list for the access-code grant is wrong';
  END IF;
  EXECUTE format('GRANT SELECT (%s) ON TABLE public.properties TO authenticated', _cols);
END;
$grant$;

CREATE OR REPLACE FUNCTION public.property_access_codes(_property_ids uuid[])
RETURNS TABLE (property_id uuid, gate_code text, lock_box_code text, key_location text, key_tag text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p.id, p.gate_code, p.lock_box_code, p.key_location, p.key_tag
    FROM public.properties p
    JOIN public.organizations o ON o.id = p.organization_id
   WHERE p.id = ANY (COALESCE(_property_ids, '{}'::uuid[]))
     AND (
       public.has_permission((SELECT auth.uid()), p.organization_id, 'view_client_directory')
       OR EXISTS (
         SELECT 1
           FROM public.visits v
           JOIN public.staff s ON s.id = v.assigned_staff_id
          WHERE v.property_id = p.id
            AND v.organization_id = p.organization_id
            AND s.user_id = (SELECT auth.uid())
            AND s.organization_id = p.organization_id
            AND s.active
            AND v.status IN ('scheduled', 'in_progress')
            AND v.scheduled_on = (now() AT TIME ZONE COALESCE(o.timezone, 'America/Chicago'))::date
       )
     );
$function$;

REVOKE ALL ON FUNCTION public.property_access_codes(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.property_access_codes(uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.property_access_codes(uuid[]) IS
  'Gate code, lock box code, key location and key tag. Office (view_client_directory), or an active tech assigned to a scheduled or in-progress visit at the property today. Plain SELECT of these columns is revoked from authenticated.';

DO $check$
DECLARE
  _col text;
BEGIN
  IF to_regprocedure('public.property_access_codes(uuid[])') IS NULL THEN
    RAISE EXCEPTION 'property_access_codes is missing';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc
           WHERE oid = 'public.property_access_codes(uuid[])'::regprocedure) THEN
    RAISE EXCEPTION 'property_access_codes must run as its owner';
  END IF;
  IF has_function_privilege('anon', 'public.property_access_codes(uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.property_access_codes(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'property_access_codes grants are wrong';
  END IF;
  IF (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.property_access_codes(uuid[])'::regprocedure) NOT LIKE '%view_client_directory%'
     OR (SELECT prosrc FROM pg_proc
          WHERE oid = 'public.property_access_codes(uuid[])'::regprocedure) NOT LIKE '%scheduled_on%' THEN
    RAISE EXCEPTION 'property_access_codes does not check the office or the day';
  END IF;
  IF (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.property_access_codes(uuid[])'::regprocedure)
     NOT LIKE '%v.status IN (''scheduled'', ''in_progress'')%' THEN
    RAISE EXCEPTION 'property_access_codes does not limit the visit to scheduled or in progress';
  END IF;
  IF (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.property_access_codes(uuid[])'::regprocedure) !~ '\ms\.active\M' THEN
    RAISE EXCEPTION 'property_access_codes does not check that the staff row is active';
  END IF;
  IF (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.property_access_codes(uuid[])'::regprocedure) !~ '\mp\.gate_code\M' THEN
    RAISE EXCEPTION 'property_access_codes does not return the gate code';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.properties', 'street', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated lost SELECT on ordinary property columns';
  END IF;
  IF NOT has_column_privilege('service_role', 'public.properties', 'lock_box_code', 'SELECT')
     OR NOT has_column_privilege('service_role', 'public.properties', 'gate_code', 'SELECT') THEN
    RAISE EXCEPTION 'service_role lost SELECT on an access code column';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.properties', 'gate_code', 'INSERT')
     OR NOT has_column_privilege('authenticated', 'public.properties', 'gate_code', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated lost INSERT or UPDATE on properties.gate_code';
  END IF;
  FOREACH _col IN ARRAY ARRAY['gate_code', 'lock_box_code', 'key_location', 'key_tag'] LOOP
    IF has_column_privilege('authenticated', 'public.properties', _col, 'SELECT')
       OR has_column_privilege('anon', 'public.properties', _col, 'SELECT') THEN
      RAISE EXCEPTION 'authenticated or anon can still select properties.%', _col;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1
      FROM information_schema.column_privileges
     WHERE table_schema = 'public'
       AND table_name = 'properties'
       AND column_name IN ('gate_code', 'lock_box_code', 'key_location', 'key_tag')
       AND grantee IN ('authenticated', 'anon', 'PUBLIC')
       AND privilege_type = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'a table grant still covers an access code column';
  END IF;
END;
$check$;
