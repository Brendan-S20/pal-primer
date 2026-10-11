-- The service catalog, proved against a real Postgres rather than read off
-- the migration's text. Run by
-- tests/a-walk-is-not-a-cleanup-in-a-real-database.test.ts, which passes the
-- migration's path as :migration.
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

-- A stack built before the service-lines migration has no
-- organizations.service_lines for the fixture to set; apply that one first,
-- inside the same transaction (the shared stack CI runs proofs against
-- follows main, and #358 lands there before this does).
SELECT NOT EXISTS (
  SELECT 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'service_lines'
) AS need_base \gset
\if :need_base
\i :base
\endif

-- ── Fixture, BEFORE the migration, so the seed has businesses to find ──────
-- A runs pet waste (owner, office manager, tech). B has said it only walks
-- dogs (owner).
INSERT INTO auth.users (id, email) VALUES
  ('a5200000-0000-4000-8000-0000000000a1', 'owner-a@services.proof.invalid'),
  ('a5200000-0000-4000-8000-0000000000a2', 'office-a@services.proof.invalid'),
  ('a5200000-0000-4000-8000-0000000000a3', 'tech-a@services.proof.invalid'),
  ('a5200000-0000-4000-8000-0000000000b1', 'owner-b@services.proof.invalid');
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO public.organizations (id, name, service_lines) VALUES
  ('05200000-0000-4000-8000-0000000000aa', 'Services Proof A', '{pet_waste}'),
  ('05200000-0000-4000-8000-0000000000bb', 'Services Proof B', '{dog_walking}');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a5200000-0000-4000-8000-0000000000a1', '05200000-0000-4000-8000-0000000000aa', 'owner'),
  ('a5200000-0000-4000-8000-0000000000a2', '05200000-0000-4000-8000-0000000000aa', 'office_manager'),
  ('a5200000-0000-4000-8000-0000000000a3', '05200000-0000-4000-8000-0000000000aa', 'tech'),
  ('a5200000-0000-4000-8000-0000000000b1', '05200000-0000-4000-8000-0000000000bb', 'owner');
SET LOCAL app.allow_protected_org_write = '';

\i :migration

CREATE FUNCTION pg_temp.as_user(_uid text, _aal text DEFAULT 'aal1') RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
           json_build_object('sub', _uid, 'role', 'authenticated', 'aal', _aal)::text, true);
$$;

-- ── 1. The seed gave each business its pet-waste service ──────────────────
DO $$
DECLARE _a record; _b record;
BEGIN
  SELECT * INTO _a FROM public.services
   WHERE organization_id = '05200000-0000-4000-8000-0000000000aa' AND lower(name) = 'pet waste removal';
  SELECT * INTO _b FROM public.services
   WHERE organization_id = '05200000-0000-4000-8000-0000000000bb' AND lower(name) = 'pet waste removal';
  IF _a.id IS NULL OR _b.id IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [seed]: a business that existed has no Pet waste removal service';
  END IF;
  IF _a.service_line <> 'pet_waste' OR _a.price_unit <> 'visit' OR _a.base_price_cents IS NOT NULL
     OR _a.default_duration_min IS NOT NULL OR NOT _a.active THEN
    RAISE EXCEPTION 'PROOF FAILED [seed]: A''s seeded service is not an active, zone-priced pet-waste visit';
  END IF;
  IF _b.active THEN
    RAISE EXCEPTION 'PROOF FAILED [seed]: B does not run pet waste but its seeded service is active';
  END IF;
  RAISE NOTICE 'ok: the seed gives every business a Pet waste removal service, inactive where it is not run';
END $$;

-- ── 2. Replaying the file adds nothing, whatever the case of the name ─────
UPDATE public.services SET name = 'PET WASTE REMOVAL'
 WHERE organization_id = '05200000-0000-4000-8000-0000000000aa';
\i :migration
DO $$
DECLARE _n integer;
BEGIN
  SELECT count(*) INTO _n FROM public.services
   WHERE organization_id IN ('05200000-0000-4000-8000-0000000000aa', '05200000-0000-4000-8000-0000000000bb');
  IF _n <> 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [idempotent]: a second run left % services for two businesses', _n;
  END IF;
  IF (SELECT name FROM public.services
       WHERE organization_id = '05200000-0000-4000-8000-0000000000aa') <> 'PET WASTE REMOVAL' THEN
    RAISE EXCEPTION 'PROOF FAILED [idempotent]: a second run rewrote a service the business had renamed';
  END IF;
  RAISE NOTICE 'ok: the migration runs twice and seeds once';
END $$;

-- ── 3. The table refuses every shape the app must never write ────────────
DO $$
DECLARE _org constant uuid := '05200000-0000-4000-8000-0000000000aa';
BEGIN
  BEGIN
    INSERT INTO public.services (organization_id, name, service_line, price_unit, default_duration_min)
    VALUES (_org, 'Pet Waste Removal', 'pet_waste', 'visit', NULL);
    RAISE EXCEPTION 'PROOF FAILED [unique]: a second "pet waste removal" in another case was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.services (organization_id, name, service_line, price_unit, default_duration_min)
    VALUES (_org, 'Overnight walk', 'dog_walking', 'night', 60);
    RAISE EXCEPTION 'PROOF FAILED [check]: a nightly walk was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.services (organization_id, name, service_line, price_unit)
    VALUES (_org, 'By the mile', 'dog_walking', 'mile');
    RAISE EXCEPTION 'PROOF FAILED [check]: price_unit mile was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.services (organization_id, name, service_line)
    VALUES (_org, 'Lawn mowing', 'lawn_care');
    RAISE EXCEPTION 'PROOF FAILED [check]: an unknown service line was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.services (organization_id, name, service_line, base_price_cents)
    VALUES (_org, 'Negative walk', 'dog_walking', -1);
    RAISE EXCEPTION 'PROOF FAILED [check]: a negative price was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.services (organization_id, name, service_line, default_duration_min)
    VALUES (_org, 'Instant walk', 'dog_walking', 0);
    RAISE EXCEPTION 'PROOF FAILED [check]: a zero-minute service was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.services (organization_id, name, service_line)
    VALUES (_org, '   ', 'dog_walking');
    RAISE EXCEPTION 'PROOF FAILED [check]: a blank name was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- The same name in ANOTHER business is that business's own.
  INSERT INTO public.services (organization_id, name, service_line, price_unit, default_duration_min)
  VALUES ('05200000-0000-4000-8000-0000000000bb', '30-minute walk', 'dog_walking', 'visit', 30),
         (_org, '30-minute walk', 'dog_walking', 'hour', 30),
         (_org, 'Overnight stay', 'pet_sitting', 'night', 720);
  RAISE NOTICE 'ok: duplicate names in any case, nightly walks, unknown units and lines, negative prices, zero minutes and blank names are refused';
END $$;

-- ── 4. A member reads their own business's catalog and nobody else's ─────
SELECT pg_temp.as_user('a5200000-0000-4000-8000-0000000000a3');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _mine integer; _theirs integer;
BEGIN
  SELECT count(*) FILTER (WHERE organization_id = '05200000-0000-4000-8000-0000000000aa'),
         count(*) FILTER (WHERE organization_id <> '05200000-0000-4000-8000-0000000000aa')
    INTO _mine, _theirs FROM public.services;
  IF _mine <> 3 THEN
    RAISE EXCEPTION 'PROOF FAILED [read]: a tech of A reads % of A''s 3 services', _mine;
  END IF;
  IF _theirs <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [read]: a tech of A reads % services of other businesses', _theirs;
  END IF;
  RAISE NOTICE 'ok: a member reads their own catalog and no other business''s';
END $$;

-- ── 5. A tech cannot change it ────────────────────────────────────────────
DO $$
DECLARE _n integer;
BEGIN
  BEGIN
    INSERT INTO public.services (organization_id, name, service_line, default_duration_min)
    VALUES ('05200000-0000-4000-8000-0000000000aa', 'Tech special', 'dog_walking', 30);
    RAISE EXCEPTION 'PROOF FAILED [tech]: a tech added a service';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  WITH u AS (
    UPDATE public.services SET base_price_cents = 1 WHERE organization_id = '05200000-0000-4000-8000-0000000000aa'
    RETURNING id
  ) SELECT count(*) INTO _n FROM u;
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [tech]: a tech repriced % services', _n;
  END IF;
  RAISE NOTICE 'ok: a tech can neither add nor reprice a service';
END $$;
RESET ROLE;

-- ── 6. manage_pricing writes its own business's catalog, and only that ────
SELECT pg_temp.as_user('a5200000-0000-4000-8000-0000000000a2');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _n integer;
BEGIN
  INSERT INTO public.services (organization_id, name, service_line, price_unit, base_price_cents, extra_pet_cents, default_duration_min)
  VALUES ('05200000-0000-4000-8000-0000000000aa', 'Full groom (90 min)', 'mobile_grooming', 'visit', 9500, 4000, 90);

  WITH u AS (
    UPDATE public.services SET active = false
     WHERE organization_id = '05200000-0000-4000-8000-0000000000aa' AND name = 'Overnight stay'
    RETURNING id
  ) SELECT count(*) INTO _n FROM u;
  IF _n <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [office]: the office manager''s deactivate matched % rows', _n;
  END IF;

  BEGIN
    INSERT INTO public.services (organization_id, name, service_line, default_duration_min)
    VALUES ('05200000-0000-4000-8000-0000000000bb', 'Planted in B', 'dog_walking', 30);
    RAISE EXCEPTION 'PROOF FAILED [cross-org]: A''s office manager added a service to B';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  WITH u AS (
    UPDATE public.services SET base_price_cents = 1
     WHERE organization_id = '05200000-0000-4000-8000-0000000000bb' RETURNING id
  ) SELECT count(*) INTO _n FROM u;
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [cross-org]: A''s office manager repriced % of B''s services', _n;
  END IF;

  -- Moving a service into another business is a write to that business.
  BEGIN
    UPDATE public.services SET organization_id = '05200000-0000-4000-8000-0000000000bb'
     WHERE organization_id = '05200000-0000-4000-8000-0000000000aa' AND name = '30-minute walk';
    RAISE EXCEPTION 'PROOF FAILED [cross-org]: a service was moved into another business';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- Nobody deletes through the API: a sold service is deactivated.
  BEGIN
    DELETE FROM public.services WHERE organization_id = '05200000-0000-4000-8000-0000000000aa';
    RAISE EXCEPTION 'PROOF FAILED [delete]: the API deleted a service';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok: manage_pricing adds and deactivates its own services, cannot touch another business''s, and nobody deletes';
END $$;
RESET ROLE;

-- ── 7. Two-step sign-in: a password alone reads and writes nothing ────────
INSERT INTO auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
VALUES (gen_random_uuid(), 'a5200000-0000-4000-8000-0000000000a1', 'Phone', 'totp', 'verified', now(), now(), 'x');

SELECT pg_temp.as_user('a5200000-0000-4000-8000-0000000000a1', 'aal1');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _n integer;
BEGIN
  SELECT count(*) INTO _n FROM public.services;
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [mfa]: a password-only session of a two-step owner read % services', _n;
  END IF;
  BEGIN
    INSERT INTO public.services (organization_id, name, service_line, default_duration_min)
    VALUES ('05200000-0000-4000-8000-0000000000aa', 'Password only', 'dog_walking', 30);
    RAISE EXCEPTION 'PROOF FAILED [mfa]: a password-only session added a service';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;

SELECT pg_temp.as_user('a5200000-0000-4000-8000-0000000000a1', 'aal2');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _n integer;
BEGIN
  SELECT count(*) INTO _n FROM public.services
   WHERE organization_id = '05200000-0000-4000-8000-0000000000aa';
  IF _n <> 4 THEN
    RAISE EXCEPTION 'PROOF FAILED [mfa]: the owner, after the code, reads % of A''s 4 services', _n;
  END IF;
  INSERT INTO public.services (organization_id, name, service_line, default_duration_min)
  VALUES ('05200000-0000-4000-8000-0000000000aa', 'After the code', 'dog_walking', 30);
  RAISE NOTICE 'ok: a two-step owner needs the code to read or write the catalog, and has it after';
END $$;
RESET ROLE;

-- ── 8. anon gets nothing ──────────────────────────────────────────────────
SET LOCAL ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM 1 FROM public.services LIMIT 1;
    RAISE EXCEPTION 'PROOF FAILED [anon]: anon read public.services';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok: anon cannot read the catalog';
END $$;
RESET ROLE;

ROLLBACK;
\echo ALL SERVICE-CATALOG PROOFS PASSED
