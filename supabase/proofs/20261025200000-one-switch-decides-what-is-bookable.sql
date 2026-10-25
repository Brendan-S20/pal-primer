-- Proof for 20261025200000: one switch decides which service lines are
-- bookable (#531).
--
--   1. The default is the list as it is on main after #530 and #535:
--      pet_waste and dog_walking bookable, every line but training and
--      mobile grooming requestable by a customer.
--   2. anon and an ordinary signed-in owner cannot change it, by table or RPC.
--   3. A platform admin can, through set_service_line_availability, and the
--      change is in platform_admin_audit with the admin as actor. A service
--      role UPDATE is logged too, with no actor.
--   4. The organizations launch gate follows the switch with no migration:
--      on, an owner may add the line; off, a business that already runs it
--      keeps it, and only adding is refused.
--   5. public_services follows customer_requestable.
--   6. Mutation: put the constant array back in bookable_service_lines() and
--      show the switch stops deciding. If it still decides, INCONCLUSIVE.
--
-- Run against a freshly reset local database:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/proofs/20261025200000-one-switch-decides-what-is-bookable.sql

\set ON_ERROR_STOP on
-- The set_config() calls below return a row each; only the NOTICEs matter.
\o /dev/null
BEGIN;

-- ── FIXTURE ───────────────────────────────────────────────────────────────
CREATE TEMP TABLE _ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON _ids TO authenticated, anon, service_role;

DO $$
DECLARE
  _org uuid; _walker uuid; _owner uuid; _walkerOwner uuid; _admin uuid;
BEGIN
  PERFORM set_config('app.allow_protected_org_write', '1', true);
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
  VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', 'owner@bookable-proof.invalid', '', now(), now(), now())
  RETURNING id INTO _owner;
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
  VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', 'admin@bookable-proof.invalid', '', now(), now(), now())
  RETURNING id INTO _admin;
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
  VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', 'walker@bookable-proof.invalid', '', now(), now(), now())
  RETURNING id INTO _walkerOwner;

  INSERT INTO public.organizations (name) VALUES ('Bookable Proof Scoops') RETURNING id INTO _org;
  -- A business that already runs walking, set the way a seed or the platform
  -- would (no request JWT), before the switch says anything about it.
  INSERT INTO public.organizations (name, service_lines)
  VALUES ('Bookable Proof Walks', ARRAY['pet_waste', 'dog_walking'])
  RETURNING id INTO _walker;

  INSERT INTO public.user_roles (user_id, organization_id, role) VALUES (_owner, _org, 'owner');
  INSERT INTO public.user_roles (user_id, organization_id, role) VALUES (_walkerOwner, _walker, 'owner');
  INSERT INTO public.platform_admins (user_id) VALUES (_admin);

  INSERT INTO _ids VALUES ('org', _org), ('walker', _walker), ('owner', _owner),
                          ('walker_owner', _walkerOwner), ('admin', _admin);
  PERFORM set_config('app.allow_protected_org_write', '', true);
END $$;

-- ── 1. The default ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF public.bookable_service_lines() IS DISTINCT FROM ARRAY['dog_walking','pet_waste']::text[] THEN
    RAISE EXCEPTION 'PROOF FAILED [default]: bookable is %, expected {dog_walking,pet_waste}', public.bookable_service_lines();
  END IF;
  IF public.customer_requestable_service_lines()
     IS DISTINCT FROM ARRAY['dog_walking','other','pet_sitting','pet_waste']::text[] THEN
    RAISE EXCEPTION 'PROOF FAILED [default]: requestable is %', public.customer_requestable_service_lines();
  END IF;
  RAISE NOTICE 'ok: the default is pet_waste and dog_walking bookable, training and grooming not requestable';
END $$;

-- The rest of this proof turns walking on and off, so it starts from off.
-- This setup write is logged like any other (actor NULL); section 4 counts
-- on it.
UPDATE public.platform_service_lines SET bookable = false WHERE service_line = 'dog_walking';

-- ── 2. anon and an owner cannot change it ─────────────────────────────────
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
DO $$
BEGIN
  BEGIN
    UPDATE public.platform_service_lines SET bookable = true WHERE service_line = 'dog_walking';
    RAISE EXCEPTION 'PROOF FAILED [anon]: anon updated platform_service_lines';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.set_service_line_availability('dog_walking', true, true);
    RAISE EXCEPTION 'PROOF FAILED [anon]: anon called set_service_line_availability';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok: anon cannot change the switch';
END $$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', (SELECT v FROM _ids WHERE k = 'owner'), 'role', 'authenticated', 'aal', 'aal1')::text, true);
DO $$
BEGIN
  BEGIN
    UPDATE public.platform_service_lines SET bookable = true WHERE service_line = 'dog_walking';
    RAISE EXCEPTION 'PROOF FAILED [owner]: an owner updated platform_service_lines';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.set_service_line_availability('dog_walking', true, true);
    RAISE EXCEPTION 'PROOF FAILED [owner]: an owner called set_service_line_availability';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok: a signed-in owner cannot change the switch';
END $$;

-- While it is off, the owner cannot add walking to the scooping business.
DO $$
BEGIN
  BEGIN
    UPDATE public.organizations SET service_lines = ARRAY['pet_waste', 'dog_walking']
     WHERE id = (SELECT v FROM _ids WHERE k = 'org');
    RAISE EXCEPTION 'PROOF FAILED [gate off]: an owner added a Coming soon line';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%coming soon%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'ok: off, adding the line is refused';
END $$;
RESET ROLE;

-- ── 3. A platform admin can, and it is logged ─────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', (SELECT v FROM _ids WHERE k = 'admin'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
SELECT public.set_service_line_availability('dog_walking', true, true);
RESET ROLE;

DO $$
BEGIN
  IF NOT ('dog_walking' = ANY (public.bookable_service_lines())) THEN
    RAISE EXCEPTION 'PROOF FAILED [admin]: the admin''s switch did not take';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_admin_audit a
     WHERE a.action = 'service_line_availability'
       AND a.actor_user_id = (SELECT v FROM _ids WHERE k = 'admin')
       AND a.before_json ->> 'bookable' = 'false'
       AND a.after_json ->> 'bookable' = 'true'
       AND a.after_json ->> 'service_line' = 'dog_walking'
  ) THEN
    RAISE EXCEPTION 'PROOF FAILED [audit]: the admin''s change is not in platform_admin_audit';
  END IF;
  IF (SELECT updated_by FROM public.platform_service_lines WHERE service_line = 'dog_walking')
     IS DISTINCT FROM (SELECT v FROM _ids WHERE k = 'admin') THEN
    RAISE EXCEPTION 'PROOF FAILED [audit]: updated_by is not the admin';
  END IF;
  RAISE NOTICE 'ok: a platform admin turned walking on, and it is logged';
END $$;

-- ── 4. The organizations gate follows the switch ──────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', (SELECT v FROM _ids WHERE k = 'owner'), 'role', 'authenticated', 'aal', 'aal1')::text, true);
UPDATE public.organizations SET service_lines = ARRAY['pet_waste', 'dog_walking']
 WHERE id = (SELECT v FROM _ids WHERE k = 'org');
RESET ROLE;

-- The service role turns walking off again: logged, with no actor.
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
UPDATE public.platform_service_lines SET bookable = false WHERE service_line = 'dog_walking';
RESET ROLE;

DO $$
BEGIN
  -- Two: the setup write after section 1, and this one.
  IF (
    SELECT count(*) FROM public.platform_admin_audit a
     WHERE a.action = 'service_line_availability'
       AND a.actor_user_id IS NULL
       AND a.before_json ->> 'bookable' = 'true'
       AND a.after_json ->> 'service_line' = 'dog_walking'
       AND a.after_json ->> 'bookable' = 'false'
  ) < 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [audit]: a service-role change is not in platform_admin_audit';
  END IF;
  IF (SELECT service_lines FROM public.organizations WHERE id = (SELECT v FROM _ids WHERE k = 'org'))
     IS DISTINCT FROM ARRAY['pet_waste', 'dog_walking']::text[] THEN
    RAISE EXCEPTION 'PROOF FAILED [gate on]: the owner could not add walking while it was bookable';
  END IF;
  RAISE NOTICE 'ok: on, an owner added walking; the service role turned it off, logged';
END $$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', (SELECT v FROM _ids WHERE k = 'owner'), 'role', 'authenticated', 'aal', 'aal1')::text, true);
DO $$
BEGIN
  -- The scooping business keeps the walking it added while it was on,
  -- through a save that adds nothing.
  UPDATE public.organizations SET service_lines = ARRAY['pet_waste', 'dog_walking']
   WHERE id = (SELECT v FROM _ids WHERE k = 'org');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROOF FAILED [kept]: the owner''s save reached no row';
  END IF;
  -- Dropping walking is allowed; adding it back is not.
  UPDATE public.organizations SET service_lines = ARRAY['pet_waste']
   WHERE id = (SELECT v FROM _ids WHERE k = 'org');
  BEGIN
    UPDATE public.organizations SET service_lines = ARRAY['pet_waste', 'dog_walking']
     WHERE id = (SELECT v FROM _ids WHERE k = 'org');
    RAISE EXCEPTION 'PROOF FAILED [kept]: walking was added back while off';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%coming soon%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'ok: off, a business that added walking keeps it until it drops it';
END $$;
RESET ROLE;

-- The business that ran walking before the switch existed keeps it too, and
-- still cannot add another Coming soon line.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', (SELECT v FROM _ids WHERE k = 'walker_owner'), 'role', 'authenticated', 'aal', 'aal1')::text, true);
DO $$
BEGIN
  UPDATE public.organizations SET service_lines = ARRAY['dog_walking', 'pet_waste']
   WHERE id = (SELECT v FROM _ids WHERE k = 'walker');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROOF FAILED [kept]: the walker''s save reached no row';
  END IF;
  BEGIN
    UPDATE public.organizations SET service_lines = ARRAY['pet_waste', 'dog_walking', 'pet_sitting']
     WHERE id = (SELECT v FROM _ids WHERE k = 'walker');
    RAISE EXCEPTION 'PROOF FAILED [kept]: an owner added pet_sitting';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%coming soon%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'ok: off, a business that already runs walking keeps it; only adding is refused';
END $$;
RESET ROLE;

-- ── 5. public_services follows customer_requestable ───────────────────────
DO $$
DECLARE
  _walker uuid := (SELECT v FROM _ids WHERE k = 'walker');
  _slug text;
  _n integer;
BEGIN
  PERFORM set_config('app.allow_protected_org_write', '1', true);
  UPDATE public.organizations SET public_signup_enabled = true, portal_slug = 'bookable-proof-walks'
   WHERE id = _walker;
  PERFORM set_config('app.allow_protected_org_write', '', true);
  _slug := 'bookable-proof-walks';
  INSERT INTO public.services (organization_id, name, service_line, price_unit, base_price_cents, active)
  VALUES (_walker, 'Proof walk', 'dog_walking', 'visit', 2500, true);

  UPDATE public.platform_service_lines SET bookable = true, customer_requestable = true
   WHERE service_line = 'dog_walking';
  SELECT count(*) INTO _n FROM public.public_services(_slug) s WHERE s.service_line = 'dog_walking';
  IF _n <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [public]: a bookable, requestable walk is not listed (% rows)', _n;
  END IF;
  UPDATE public.platform_service_lines SET customer_requestable = false WHERE service_line = 'dog_walking';
  SELECT count(*) INTO _n FROM public.public_services(_slug) s WHERE s.service_line = 'dog_walking';
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [public]: a walk customers cannot request is still listed';
  END IF;
  RAISE NOTICE 'ok: public_services follows customer_requestable';
END $$;

-- ── 6. Mutation: a constant array stops the switch deciding ───────────────
DO $$
BEGIN
  UPDATE public.platform_service_lines SET bookable = true WHERE service_line = 'pet_sitting';
  IF NOT ('pet_sitting' = ANY (public.bookable_service_lines())) THEN
    RAISE EXCEPTION 'PROOF FAILED [mutation]: the switch did not decide before the mutation';
  END IF;
  CREATE OR REPLACE FUNCTION public.bookable_service_lines()
  RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path TO 'public'
  AS $f$ SELECT ARRAY['pet_waste']::text[]; $f$;
  IF 'pet_sitting' = ANY (public.bookable_service_lines()) THEN
    RAISE EXCEPTION 'INCONCLUSIVE [mutation]: the constant still followed the switch';
  END IF;
  RAISE NOTICE 'ok: mutation reproduced; with a constant, the switch decides nothing';
END $$;

ROLLBACK;
