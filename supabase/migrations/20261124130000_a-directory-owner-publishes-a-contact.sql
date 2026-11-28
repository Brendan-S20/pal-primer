-- PROPOSED, applied to no live database (#1002; Helm: no production migration in this order).
--
-- The owner of a business sets the public contact email and phone on its
-- directory profile (the two columns from 20261118010000). authenticated holds
-- no UPDATE on directory_profiles and set_directory_profile has no contact
-- parameter, so without this function the columns can only be written with the
-- service role, which tests/a-directory-search-needs-no-service-role.test.ts
-- forbids in the directory server functions.
--
-- Adds ONE function. No table, column, policy, grant on a table or view changes.
-- The table CHECKs from 20261118010000 stay the last line of defence.

CREATE OR REPLACE FUNCTION public.set_directory_public_contact(
  _org uuid,
  _email text,
  _phone text,
  _change_email boolean DEFAULT true,
  _change_phone boolean DEFAULT true
) RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), _org, 'owner'::public.app_role) THEN
    RAISE EXCEPTION 'Only an owner can change the directory contact' USING ERRCODE = '42501';
  END IF;

  -- Blank means "clear": stored as NULL. Shape is enforced by the table CHECKs.
  UPDATE public.directory_profiles
     SET public_email = CASE WHEN COALESCE(_change_email, false)
                             THEN NULLIF(btrim(COALESCE(_email, '')), '') ELSE public_email END,
         public_phone = CASE WHEN COALESCE(_change_phone, false)
                             THEN NULLIF(btrim(COALESCE(_phone, '')), '') ELSE public_phone END
   WHERE organization_id = _org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Directory profile not found' USING ERRCODE = '22023';
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION public.set_directory_public_contact(uuid, text, text, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_directory_public_contact(uuid, text, text, boolean, boolean) TO authenticated, service_role;

COMMENT ON FUNCTION public.set_directory_public_contact(uuid, text, text, boolean, boolean) IS
  'The owner sets or clears the public contact email and phone on the directory profile. Anyone else is refused (42501). #1002.';
