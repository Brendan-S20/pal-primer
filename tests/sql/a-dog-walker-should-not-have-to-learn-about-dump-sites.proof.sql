-- Service lines, proved against a real Postgres rather than read off the
-- migration's text. Run by
-- tests/a-dog-walker-should-not-have-to-learn-about-dump-sites-in-a-real-database.test.ts,
-- which passes the migration's path as :migration.
--
-- Everything happens inside one transaction that is ROLLED BACK at the end,
-- the migration included. Each group prints "ok: ..." only when every check
-- in it passed, or raises "PROOF FAILED [...]", and ON_ERROR_STOP turns the
-- first failure into a non-zero exit.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :migration

-- ── Fixture ─────────────────────────────────────────────────────────────────
-- Two businesses. A has an owner and a tech; B has an owner.
INSERT INTO auth.users (id, email) VALUES
  ('a5100000-0000-4000-8000-0000000000a1', 'owner-a@service-lines.proof.invalid'),
  ('a5100000-0000-4000-8000-0000000000a2', 'tech-a@service-lines.proof.invalid'),
  ('a5100000-0000-4000-8000-0000000000b1', 'owner-b@service-lines.proof.invalid');
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO public.organizations (id, name) VALUES
  ('05100000-0000-4000-8000-0000000000aa', 'Service Lines Proof A'),
  ('05100000-0000-4000-8000-0000000000bb', 'Service Lines Proof B');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a5100000-0000-4000-8000-0000000000a1', '05100000-0000-4000-8000-0000000000aa', 'owner'),
  ('a5100000-0000-4000-8000-0000000000a2', '05100000-0000-4000-8000-0000000000aa', 'tech'),
  ('a5100000-0000-4000-8000-0000000000b1', '05100000-0000-4000-8000-0000000000bb', 'owner');
SET LOCAL app.allow_protected_org_write = '';

CREATE FUNCTION pg_temp.as_user(_uid text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
           json_build_object('sub', _uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
$$;

-- ── 1. A new business is a pet-waste business until it says otherwise ──────
DO $$
BEGIN
  IF (SELECT service_lines FROM public.organizations
       WHERE id = '05100000-0000-4000-8000-0000000000aa') IS DISTINCT FROM '{pet_waste}'::text[] THEN
    RAISE EXCEPTION 'PROOF FAILED [default]: a new organization does not read {pet_waste}';
  END IF;
  RAISE NOTICE 'ok: a new organization starts as {pet_waste}';
END $$;

-- ── 2. Every set the app can write is stored as written ───────────────────
DO $$
DECLARE _txt text; _set text[];
BEGIN
  FOREACH _txt IN ARRAY ARRAY[
    '{pet_waste,dog_walking,pet_sitting,mobile_grooming,other}',
    '{dog_walking}',
    '{mobile_grooming,pet_waste}'
  ] LOOP
    _set := _txt::text[];
    UPDATE public.organizations SET service_lines = _set
     WHERE id = '05100000-0000-4000-8000-0000000000bb';
    IF (SELECT service_lines FROM public.organizations
         WHERE id = '05100000-0000-4000-8000-0000000000bb') IS DISTINCT FROM _set THEN
      RAISE EXCEPTION 'PROOF FAILED [valid]: % was not stored as written', _set;
    END IF;
  END LOOP;
  UPDATE public.organizations SET service_lines = '{pet_waste}'
   WHERE id = '05100000-0000-4000-8000-0000000000bb';
  RAISE NOTICE 'ok: every valid set is stored as written';
END $$;

-- ── 3. The CHECK refuses every shape the app must never write ─────────────
DO $$
DECLARE _bad text;
BEGIN
  FOREACH _bad IN ARRAY ARRAY['{}', '{lawn_care}', '{pet_waste,pet_waste}', '{pet_waste,NULL}', '{{pet_waste}}', '{Pet_Waste}'] LOOP
    BEGIN
      UPDATE public.organizations SET service_lines = _bad::text[]
       WHERE id = '05100000-0000-4000-8000-0000000000aa';
      RAISE EXCEPTION 'PROOF FAILED [check]: % was accepted', _bad;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  BEGIN
    UPDATE public.organizations SET service_lines = NULL
     WHERE id = '05100000-0000-4000-8000-0000000000aa';
    RAISE EXCEPTION 'PROOF FAILED [check]: NULL was accepted';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
  RAISE NOTICE 'ok: empty, unknown, duplicated, NULL-holding, nested and miscased sets are refused';
END $$;

-- ── 4. The owner writes it through the ordinary org-update path ───────────
-- What updateOwnOrg does: a plain UPDATE, as role authenticated, under the
-- "Settings managers update own org" policy. No RPC, no new grant.
SELECT pg_temp.as_user('a5100000-0000-4000-8000-0000000000a1');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _n integer;
BEGIN
  WITH u AS (
    UPDATE public.organizations SET service_lines = '{pet_waste,dog_walking}'
     WHERE id = '05100000-0000-4000-8000-0000000000aa' RETURNING id
  ) SELECT count(*) INTO _n FROM u;
  IF _n <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [owner]: the owner''s update matched % rows', _n;
  END IF;

  -- Another business's row is not theirs to describe.
  WITH u AS (
    UPDATE public.organizations SET service_lines = '{dog_walking}'
     WHERE id = '05100000-0000-4000-8000-0000000000bb' RETURNING id
  ) SELECT count(*) INTO _n FROM u;
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [owner]: the owner of A rewrote B';
  END IF;
  RAISE NOTICE 'ok: the owner sets their own business''s lines and nobody else''s';
END $$;
RESET ROLE;

-- ── 5. A tech cannot change what the business runs ───────────────────────
SELECT pg_temp.as_user('a5100000-0000-4000-8000-0000000000a2');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _n integer;
BEGIN
  WITH u AS (
    UPDATE public.organizations SET service_lines = '{mobile_grooming}'
     WHERE id = '05100000-0000-4000-8000-0000000000aa' RETURNING id
  ) SELECT count(*) INTO _n FROM u;
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [tech]: a tech changed the business''s service lines';
  END IF;
  RAISE NOTICE 'ok: a tech cannot change the business''s service lines';
END $$;
RESET ROLE;

DO $$
BEGIN
  IF (SELECT service_lines FROM public.organizations
       WHERE id = '05100000-0000-4000-8000-0000000000aa') IS DISTINCT FROM '{pet_waste,dog_walking}'::text[] THEN
    RAISE EXCEPTION 'PROOF FAILED [tech]: A no longer reads what its owner wrote';
  END IF;
  IF (SELECT service_lines FROM public.organizations
       WHERE id = '05100000-0000-4000-8000-0000000000bb') IS DISTINCT FROM '{pet_waste}'::text[] THEN
    RAISE EXCEPTION 'PROOF FAILED [owner]: B was changed by somebody outside it';
  END IF;
  RAISE NOTICE 'ok: each business reads exactly what its own owner wrote';
END $$;

-- ── 6. Nothing was widened ────────────────────────────────────────────────
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.service_lines_are_valid(text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'PROOF FAILED [grants]: anon can execute service_lines_are_valid';
  END IF;
  IF has_column_privilege('anon', 'public.organizations', 'service_lines', 'UPDATE')
     AND EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'organizations'
                    AND 'anon' = ANY (roles) AND cmd IN ('UPDATE', 'ALL')) THEN
    RAISE EXCEPTION 'PROOF FAILED [grants]: anon has a path to update service_lines';
  END IF;
  RAISE NOTICE 'ok: anon gains nothing';
END $$;

ROLLBACK;
\echo ALL SERVICE-LINES PROOFS PASSED
