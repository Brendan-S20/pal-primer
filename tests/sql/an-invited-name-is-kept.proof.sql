-- An invited name is kept (#651), proved against a real Postgres. Run by
-- tests/an-invited-name-is-kept.test.ts with :migration. One transaction,
-- ROLLED BACK at the end, the migration included. Each check prints
-- "ok: ..." or raises "PROOF FAILED [...]".

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :migration

-- ── Fixture ─────────────────────────────────────────────────────────────────
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('f0000000-0000-4000-8000-000000651a01', 'owner@name.proof.invalid');
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a000000-0000-4000-8000-000000651a00', 'Name Proof A', 'America/Chicago');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('f0000000-0000-4000-8000-000000651a01', '0a000000-0000-4000-8000-000000651a00', 'owner');
SET LOCAL app.allow_protected_org_write = '';
INSERT INTO public.staff (id, organization_id, user_id, role, display_name, active) VALUES
  ('5a000000-0000-4000-8000-000000651a01', '0a000000-0000-4000-8000-000000651a00',
   'f0000000-0000-4000-8000-000000651a01', 'owner', 'Owner A', true);

-- Invitations first, accounts after: the email path needs the account to
-- post-date the invitation.
INSERT INTO public.org_invites (organization_id, email, role, token, created_at) VALUES
  ('0a000000-0000-4000-8000-000000651a00', 'tech1-walk-r2@name.proof.invalid', 'tech', 'name-proof-link-token', now() - interval '1 hour'),
  ('0a000000-0000-4000-8000-000000651a00', 'tech2-groom@name.proof.invalid', 'tech', 'name-proof-email-token', now() - interval '1 hour'),
  ('0a000000-0000-4000-8000-000000651a00', 'no-name@name.proof.invalid', 'tech', 'name-proof-blank-token', now() - interval '1 hour');
INSERT INTO auth.users (id, email, raw_user_meta_data, created_at) VALUES
  ('f0000000-0000-4000-8000-000000651a02', 'tech1-walk-r2@name.proof.invalid', '{"display_name": "  Maria Lopez "}', now()),
  ('f0000000-0000-4000-8000-000000651a03', 'tech2-groom@name.proof.invalid', '{"display_name": "Sam Ortiz"}', now()),
  ('f0000000-0000-4000-8000-000000651a04', 'no-name@name.proof.invalid', '{"display_name": "   "}', now());

CREATE FUNCTION pg_temp.as_user(_uid text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
           json_build_object('sub', _uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
$$;

-- ── The link (token path) keeps the typed name and the email ────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000651a02');
SET LOCAL ROLE authenticated;
SELECT public.accept_org_invite_for_current_user('name-proof-link-token');
RESET ROLE;
DO $$
DECLARE _n text; _e text;
BEGIN
  SELECT display_name, email INTO _n, _e FROM public.staff
   WHERE user_id = 'f0000000-0000-4000-8000-000000651a02';
  IF _n IS DISTINCT FROM 'Maria Lopez' THEN
    RAISE EXCEPTION 'PROOF FAILED [link]: staff.display_name is %, not the typed name', _n;
  END IF;
  IF _e IS DISTINCT FROM 'tech1-walk-r2@name.proof.invalid' THEN
    RAISE EXCEPTION 'PROOF FAILED [link]: staff.email is %', _e;
  END IF;
  RAISE NOTICE 'ok: the invitation link keeps the typed name and writes the email';
END $$;

-- ── Signing up without the link (email path) keeps it too ──────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000651a03');
SET LOCAL ROLE authenticated;
SELECT public.accept_org_invite_for_current_user(NULL);
RESET ROLE;
DO $$
BEGIN
  IF (SELECT display_name FROM public.staff WHERE user_id = 'f0000000-0000-4000-8000-000000651a03')
     IS DISTINCT FROM 'Sam Ortiz' THEN
    RAISE EXCEPTION 'PROOF FAILED [email path]: the typed name was not kept';
  END IF;
  RAISE NOTICE 'ok: /sign-up with a pending invitation keeps the typed name';
END $$;

-- ── A blank name falls back to the email prefix ────────────────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000651a04');
SET LOCAL ROLE authenticated;
SELECT public.accept_org_invite_for_current_user('name-proof-blank-token');
RESET ROLE;
DO $$
BEGIN
  IF (SELECT display_name FROM public.staff WHERE user_id = 'f0000000-0000-4000-8000-000000651a04')
     IS DISTINCT FROM 'no-name' THEN
    RAISE EXCEPTION 'PROOF FAILED [fallback]: a blank typed name did not fall back to the prefix';
  END IF;
  RAISE NOTICE 'ok: only a blank name falls back to the email prefix';
END $$;

-- ── A tech renames themselves, and only themselves ─────────────────────────
-- The old path, an UPDATE through RLS, changes nothing for a tech. Shown here
-- so the proof says why the function exists.
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000651a02');
SET LOCAL ROLE authenticated;
UPDATE public.staff SET display_name = 'Through RLS' WHERE user_id = 'f0000000-0000-4000-8000-000000651a02';
SELECT public.update_my_staff_profile('Maria L.', '555-0101');
RESET ROLE;
DO $$
DECLARE _n text; _p text;
BEGIN
  SELECT display_name, phone INTO _n, _p FROM public.staff
   WHERE user_id = 'f0000000-0000-4000-8000-000000651a02';
  IF _n IS DISTINCT FROM 'Maria L.' OR _p IS DISTINCT FROM '555-0101' THEN
    RAISE EXCEPTION 'PROOF FAILED [rename]: a tech''s own rename did not persist (%, %)', _n, _p;
  END IF;
  IF (SELECT display_name FROM public.staff WHERE user_id = 'f0000000-0000-4000-8000-000000651a01')
     IS DISTINCT FROM 'Owner A' THEN
    RAISE EXCEPTION 'PROOF FAILED [rename]: somebody else''s row changed';
  END IF;
  RAISE NOTICE 'ok: a tech''s rename persists, and touches no other row';
END $$;

-- ── A blank name, an account with no staff row, and anon are refused ────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000651a02');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.update_my_staff_profile('   ', NULL);
    RAISE EXCEPTION 'PROOF FAILED [blank]: a blank name was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'ok: a blank name is refused';
END $$;
RESET ROLE;

INSERT INTO auth.users (id, email) VALUES
  ('f0000000-0000-4000-8000-000000651a09', 'nobody@name.proof.invalid');
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000651a09');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.update_my_staff_profile('Nobody', NULL);
    RAISE EXCEPTION 'PROOF FAILED [no row]: a save with no row to write reported success';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
  RAISE NOTICE 'ok: a save with nothing to write raises instead of reporting success';
END $$;
RESET ROLE;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.update_my_staff_profile(text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PROOF FAILED [anon]: anon can run update_my_staff_profile';
  END IF;
  RAISE NOTICE 'ok: anon cannot run update_my_staff_profile';
END $$;

ROLLBACK;
\echo ALL INVITED-NAME PROOFS PASSED
