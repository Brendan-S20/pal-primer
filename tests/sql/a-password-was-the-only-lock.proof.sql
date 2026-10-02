-- Two-step sign-in, proved against a real Postgres. Run by
-- tests/a-password-was-the-only-lock.test.ts with :migration. One
-- transaction, ROLLED BACK at the end, the migration included.
--
-- An owner who has turned two-step on, and a tech in the same business who
-- has not. Each is tried as the API would see them: role authenticated, the
-- JWT's sub and aal set the way Supabase sets them.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :migration

INSERT INTO auth.users (id, email) VALUES
  ('a0000000-0000-4000-8000-0000000000f2', 'owner@twostep.proof.invalid'),
  ('a0000000-0000-4000-8000-0000000000f3', 'tech@twostep.proof.invalid');
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a000000-0000-4000-8000-0000000000f2', 'Two Step Proof', 'America/Chicago');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a0000000-0000-4000-8000-0000000000f2', '0a000000-0000-4000-8000-0000000000f2', 'owner'),
  ('a0000000-0000-4000-8000-0000000000f3', '0a000000-0000-4000-8000-0000000000f2', 'tech');
SET LOCAL app.allow_protected_org_write = '';
INSERT INTO public.clients (organization_id, account_type, display_name) VALUES
  ('0a000000-0000-4000-8000-0000000000f2', 'residential', 'Two Step Client');

-- The owner turned it on: a verified authenticator-app factor.
INSERT INTO auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
VALUES (gen_random_uuid(), 'a0000000-0000-4000-8000-0000000000f2', 'Phone', 'totp', 'verified', now(), now(), 'x');

CREATE FUNCTION pg_temp.as_user(_uid text, _aal text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
           json_build_object('sub', _uid, 'role', 'authenticated', 'aal', _aal)::text, true);
$$;

-- ── The owner, password only (aal1) ─────────────────────────────────────────
SELECT pg_temp.as_user('a0000000-0000-4000-8000-0000000000f2', 'aal1');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF public.mfa_satisfied() THEN
    RAISE EXCEPTION 'PROOF FAILED [aal1]: a password-only session of a two-step user passes the gate';
  END IF;
  IF EXISTS (SELECT 1 FROM public.clients WHERE organization_id = '0a000000-0000-4000-8000-0000000000f2')
     OR EXISTS (SELECT 1 FROM public.organizations WHERE id = '0a000000-0000-4000-8000-0000000000f2') THEN
    RAISE EXCEPTION 'PROOF FAILED [aal1]: a password-only session read the business';
  END IF;
  IF public.has_permission('a0000000-0000-4000-8000-0000000000f2', '0a000000-0000-4000-8000-0000000000f2', 'manage_settings')
     OR public.is_org_member('a0000000-0000-4000-8000-0000000000f2', '0a000000-0000-4000-8000-0000000000f2')
     OR public.can_write_org('a0000000-0000-4000-8000-0000000000f2', '0a000000-0000-4000-8000-0000000000f2') THEN
    RAISE EXCEPTION 'PROOF FAILED [aal1]: a password-only session passes a permission check inside an RPC';
  END IF;
  BEGIN
    INSERT INTO public.clients (organization_id, account_type, display_name)
    VALUES ('0a000000-0000-4000-8000-0000000000f2', 'residential', 'Should not exist');
    RAISE EXCEPTION 'PROOF FAILED [aal1]: a password-only session wrote a client';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok: a two-step user signed in with the password alone reads, writes and passes nothing';
END $$;
RESET ROLE;

-- ── The owner, after the code (aal2) ────────────────────────────────────────
SELECT pg_temp.as_user('a0000000-0000-4000-8000-0000000000f2', 'aal2');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.clients WHERE organization_id = '0a000000-0000-4000-8000-0000000000f2')
     OR NOT public.has_permission('a0000000-0000-4000-8000-0000000000f2', '0a000000-0000-4000-8000-0000000000f2', 'manage_settings') THEN
    RAISE EXCEPTION 'PROOF FAILED [aal2]: the owner, after the code, cannot work';
  END IF;
  RAISE NOTICE 'ok: after the code, the owner works as before';
END $$;
RESET ROLE;

-- ── The tech, who never turned it on (aal1) ────────────────────────────────
SELECT pg_temp.as_user('a0000000-0000-4000-8000-0000000000f3', 'aal1');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF NOT public.mfa_satisfied()
     OR NOT public.is_org_member('a0000000-0000-4000-8000-0000000000f3', '0a000000-0000-4000-8000-0000000000f2') THEN
    RAISE EXCEPTION 'PROOF FAILED [no factor]: somebody who never turned two-step on was locked out';
  END IF;
  RAISE NOTICE 'ok: nothing changes for somebody who has not turned it on';
END $$;
RESET ROLE;

-- ── No user at all: the service role, cron ──────────────────────────────────
SELECT set_config('request.jwt.claims', '', true);
DO $$
BEGIN
  IF NOT public.mfa_satisfied() THEN
    RAISE EXCEPTION 'PROOF FAILED [service]: a request with no user is gated';
  END IF;
  RAISE NOTICE 'ok: the service role and the nightly jobs are not asked for a code';
END $$;

-- Every table with row level security carries the policy.
DO $$
DECLARE _missing text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO _missing
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity
     AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
                      AND p.polname = 'two-step sign-in, when the user has it' AND NOT p.polpermissive);
  IF _missing IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [coverage]: no two-step policy on %', _missing;
  END IF;
  RAISE NOTICE 'ok: every table with row level security carries the two-step policy';
END $$;

ROLLBACK;
\echo ALL TWO-STEP PROOFS PASSED
