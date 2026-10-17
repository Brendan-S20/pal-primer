-- A property's access codes are read through one function. Follows
-- 20261016235000.
--
-- public.property_access_codes(_property_ids uuid[]) returns the gate code,
-- the lock box code and the key location for the properties named. My Day
-- read those three columns directly in its visits select, next to forty
-- columns that are not secrets, so nothing marked which reads handle a code.
-- tests/access-codes-are-read-through-one-function.test.ts now refuses a
-- direct read on the tech and portal grooming screens.
--
-- SECURITY INVOKER, so properties' RLS (the tenant policies and the
-- restrictive two-step sign-in policy) decides what comes back: the function
-- narrows a read to the ids named and can never widen one. At most 500 ids,
-- far past any day's stops. Callable by a signed-in user only.
--
-- Replays into an empty database: one function and its grants. The check
-- block asserts only what this file creates.

CREATE OR REPLACE FUNCTION public.property_access_codes(_property_ids uuid[])
RETURNS TABLE (property_id uuid, gate_code text, lock_box_code text, key_location text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
  SELECT p.id, p.gate_code, p.lock_box_code, p.key_location
    FROM public.properties p
   WHERE p.id = ANY ((COALESCE(_property_ids, ARRAY[]::uuid[]))[1:500]);
$function$;

REVOKE ALL ON FUNCTION public.property_access_codes(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.property_access_codes(uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.property_access_codes(uuid[]) IS
  'The gate code, lock box code and key location of the named properties, under the caller''s RLS. The one read path for access codes on the tech screens.';

DO $check$
DECLARE _fn CONSTANT text := 'public.property_access_codes(uuid[])';
BEGIN
  IF to_regprocedure(_fn) IS NULL THEN
    RAISE EXCEPTION '% was not created', _fn;
  END IF;
  IF (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(_fn)) THEN
    RAISE EXCEPTION '% must run as the caller so RLS decides what it returns', _fn;
  END IF;
  IF has_function_privilege('anon', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION '% is callable with the publishable key', _fn;
  END IF;
  IF NOT has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION '% is not callable by a signed-in user', _fn;
  END IF;
END
$check$;
