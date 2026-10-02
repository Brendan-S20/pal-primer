-- A password was the only lock.
--
-- Nobody could turn on two-step sign-in: the platform admin could REMOVE a
-- factor (removePlatformUserMfa), but no screen let anyone add one. The owner's
-- decision (2026-10-01): use Supabase's own MFA -- an authenticator app, and a
-- text message once an SMS provider (Twilio Verify) is connected in Supabase --
-- optional per person to start.
--
-- Turning it on in the app is not enough by itself. The browser reads and
-- writes the database directly through PostgREST, so a session that signed in
-- with the password alone could skip any screen that asks for the code. The
-- database has to refuse it. Supabase's documented pattern, for users who have
-- opted in:
--
--   public.mfa_satisfied()   true for a request with no user (service role,
--                            cron), for a user with no verified factor, and
--                            for a session that has completed the second step
--                            (JWT aal = aal2). False only for a user who has
--                            turned two-step on and whose session has not.
--
--   A RESTRICTIVE policy on every table in public that has row level
--   security, for `authenticated`, requiring it for reads and writes alike.
--   Restrictive policies are ANDed with the existing permissive ones, so this
--   changes nothing for anybody who has not turned two-step on.
--
--   The five permission helpers (has_permission, has_role, can_write_org,
--   is_org_member, is_platform_admin) require it too. They are SECURITY
--   DEFINER and read user_roles past RLS, so without this a password-only
--   session could still pass every check inside an RPC.
--
--   public.require_mfa_policy(table) adds the policy to one table, for every
--   table created after this file. tests/a-password-was-the-only-lock.test.ts
--   fails any later migration that enables row level security without it.
--
-- Replays into an empty database: auth.mfa_factors exists on every Supabase
-- stack; the loop finds whatever tables exist at this point in the sequence.

CREATE OR REPLACE FUNCTION public.mfa_satisfied()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT auth.uid() IS NULL
      OR COALESCE(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      OR NOT EXISTS (
           SELECT 1 FROM auth.mfa_factors f
            WHERE f.user_id = auth.uid() AND f.status = 'verified'
         );
$function$;

COMMENT ON FUNCTION public.mfa_satisfied() IS
  'False only for a signed-in user who has a verified MFA factor and whose session has not completed the second step (aal1). The gate every restrictive mfa policy and permission helper asks.';

REVOKE ALL ON FUNCTION public.mfa_satisfied() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mfa_satisfied() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.require_mfa_policy(_table regclass)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS "two-step sign-in, when the user has it" ON %s', _table);
  -- (SELECT ...) so the planner evaluates it once per statement, not per row.
  EXECUTE format(
    'CREATE POLICY "two-step sign-in, when the user has it" ON %s AS RESTRICTIVE FOR ALL TO authenticated '
    || 'USING ((SELECT public.mfa_satisfied())) WITH CHECK ((SELECT public.mfa_satisfied()))',
    _table);
END;
$function$;

REVOKE ALL ON FUNCTION public.require_mfa_policy(regclass) FROM PUBLIC, anon, authenticated;

DO $tables$
DECLARE
  _t regclass;
BEGIN
  FOR _t IN
    SELECT c.oid::regclass
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity
  LOOP
    PERFORM public.require_mfa_policy(_t);
  END LOOP;
END
$tables$;

-- ── The permission helpers ──────────────────────────────────────────────────
-- Each opens with the same identity clause; the splice adds the second step to
-- it. Spliced by name, raising if a body is not the one this was cut against.
DO $helpers$
DECLARE
  _fn text;
  _def text;
  _new text;
  _clause constant text := 'SELECT (auth.uid() IS NULL OR _user_id IS NOT DISTINCT FROM auth.uid())';
BEGIN
  FOREACH _fn IN ARRAY ARRAY[
    'public.has_permission(uuid, uuid, text)',
    'public.has_role(uuid, uuid, public.app_role)',
    'public.can_write_org(uuid, uuid)',
    'public.is_org_member(uuid, uuid)',
    'public.is_platform_admin(uuid)'
  ] LOOP
    _def := pg_get_functiondef(_fn::regprocedure);
    IF strpos(_def, 'public.mfa_satisfied()') > 0 THEN
      CONTINUE;
    END IF;
    _new := replace(_def, _clause, _clause || E'\n     AND public.mfa_satisfied()');
    IF _new = _def THEN
      RAISE EXCEPTION '% no longer opens with the identity clause this splice expects; re-cut it against the current body.', _fn;
    END IF;
    EXECUTE _new;
  END LOOP;
END
$helpers$;

DO $check$
DECLARE
  _missing text;
  _fn text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO _missing
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity
     AND NOT EXISTS (
       SELECT 1 FROM pg_policy p
        WHERE p.polrelid = c.oid
          AND p.polname = 'two-step sign-in, when the user has it'
          AND NOT p.polpermissive
     );
  IF _missing IS NOT NULL THEN
    RAISE EXCEPTION 'tables without the two-step policy: %', _missing;
  END IF;

  FOREACH _fn IN ARRAY ARRAY[
    'public.has_permission(uuid, uuid, text)',
    'public.has_role(uuid, uuid, public.app_role)',
    'public.can_write_org(uuid, uuid)',
    'public.is_org_member(uuid, uuid)',
    'public.is_platform_admin(uuid)'
  ] LOOP
    IF (SELECT prosrc FROM pg_proc WHERE oid = _fn::regprocedure) !~ 'public\.mfa_satisfied\(\)' THEN
      RAISE EXCEPTION '% does not require the second step', _fn;
    END IF;
  END LOOP;

  IF has_function_privilege('anon', 'public.mfa_satisfied()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.require_mfa_policy(regclass)', 'EXECUTE') THEN
    RAISE EXCEPTION 'an MFA helper is callable by a role that should not have it';
  END IF;
END
$check$;
