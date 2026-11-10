-- A removed teammate can be invited back (#765), proved against a real
-- Postgres. Run by tests/a-removed-teammate-can-be-invited-back.test.ts with
-- :migration. One transaction, ROLLED BACK at the end, the migration
-- included. Each check prints "ok: ..." or raises "PROOF FAILED [...]".

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :migration

-- ── Fixture ─────────────────────────────────────────────────────────────────
-- A business, its owner, and two people who used to work there: one whose
-- staff row is still there (turned off, membership gone), one with nothing
-- left at all (the production state). Both accounts are OLDER than the
-- re-invitation, which is always true of somebody being invited back.
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email, raw_user_meta_data, created_at) VALUES
  ('f0000000-0000-4000-8000-000000765a01', 'owner@back.proof.invalid', '{}', now() - interval '200 days'),
  ('f0000000-0000-4000-8000-000000765a02', 'former@back.proof.invalid', '{"display_name": "Dee Former"}', now() - interval '100 days'),
  ('f0000000-0000-4000-8000-000000765a03', 'orphan@back.proof.invalid', '{"display_name": "Orphan"}', now() - interval '100 days'),
  ('f0000000-0000-4000-8000-000000765a04', 'stranger@back.proof.invalid', '{}', now() - interval '100 days');
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a000000-0000-4000-8000-000000765a00', 'Back Proof Co', 'America/Detroit');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('f0000000-0000-4000-8000-000000765a01', '0a000000-0000-4000-8000-000000765a00', 'owner');
SET LOCAL app.allow_protected_org_write = '';
INSERT INTO public.staff (id, organization_id, user_id, role, display_name, active) VALUES
  ('5a000000-0000-4000-8000-000000765a01', '0a000000-0000-4000-8000-000000765a00',
   'f0000000-0000-4000-8000-000000765a01', 'owner', 'Owner', true),
  ('5a000000-0000-4000-8000-000000765a02', '0a000000-0000-4000-8000-000000765a00',
   'f0000000-0000-4000-8000-000000765a02', 'tech', 'Dee Former', false);

INSERT INTO public.org_invites (organization_id, email, role, token, created_at) VALUES
  ('0a000000-0000-4000-8000-000000765a00', 'former@back.proof.invalid', 'dispatcher', 'back-proof-former', now()),
  ('0a000000-0000-4000-8000-000000765a00', 'orphan@back.proof.invalid', 'tech', 'back-proof-orphan', now()),
  ('0a000000-0000-4000-8000-000000765a00', 'stranger@back.proof.invalid', 'tech', 'back-proof-stranger', now());

CREATE FUNCTION pg_temp.as_user(_uid text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
           json_build_object('sub', _uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
$$;

-- ── A former member signs in without the link, and is back ─────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000765a02');
SET LOCAL ROLE authenticated;
SELECT public.accept_org_invite_for_current_user(NULL);
RESET ROLE;
DO $$
DECLARE _rows int; _active boolean; _role text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_roles
                  WHERE user_id = 'f0000000-0000-4000-8000-000000765a02'
                    AND organization_id = '0a000000-0000-4000-8000-000000765a00') THEN
    RAISE EXCEPTION 'PROOF FAILED [email path]: a former member was not let back in by address';
  END IF;
  RAISE NOTICE 'ok: a former member is accepted by address, with no link';

  SELECT count(*) INTO _rows FROM public.staff
   WHERE user_id = 'f0000000-0000-4000-8000-000000765a02';
  SELECT active, role::text INTO _active, _role FROM public.staff
   WHERE id = '5a000000-0000-4000-8000-000000765a02';
  IF _rows <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [one person]: % staff rows for one returning member', _rows;
  END IF;
  IF _active IS NOT TRUE OR _role IS DISTINCT FROM 'dispatcher' THEN
    RAISE EXCEPTION 'PROOF FAILED [one person]: the old row is (%, %), not on as dispatcher', _active, _role;
  END IF;
  RAISE NOTICE 'ok: they come back as the same staff row, on, with the invited role';
END $$;

-- ── Nothing left at all: the link brings them back ─────────────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000765a03');
SET LOCAL ROLE authenticated;
SELECT public.accept_org_invite_for_current_user('back-proof-orphan');
RESET ROLE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.staff
                  WHERE user_id = 'f0000000-0000-4000-8000-000000765a03'
                    AND organization_id = '0a000000-0000-4000-8000-000000765a00'
                    AND active AND display_name = 'Orphan') THEN
    RAISE EXCEPTION 'PROOF FAILED [orphan]: an account with no membership and no staff row did not join by link';
  END IF;
  RAISE NOTICE 'ok: an account with nothing left joins by the link, with no second-membership refusal';
END $$;

-- ── The pre-claim guard still stands for everybody else ───────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000765a04');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM public.accept_org_invite_for_current_user(NULL);
  RAISE EXCEPTION 'PROOF FAILED [pre-claim]: an older account with no history joined by address';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'PROOF FAILED%' THEN RAISE; END IF;
  RAISE NOTICE 'ok: an older account that was never on the staff still needs the link';
END $$;
RESET ROLE;

ROLLBACK;
\echo ALL INVITED-BACK PROOFS PASSED
