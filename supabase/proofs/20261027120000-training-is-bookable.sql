-- Proof for 20261027120000: training is bookable (#548).
--
--   1. The switch answers {dog_walking, pet_sitting, pet_waste, training};
--      training is still NOT requestable by a customer; grooming is still
--      Coming soon. The flip is in platform_admin_audit with no actor.
--   2. A signed-in owner of a scooping business may add training, and is
--      still refused grooming.
--   3. public_services lists the business's training to a stranger, priced
--      or not: since 20261028120000 (#560) the booking link sells every live
--      line, though training stays off customer_requestable (the portal
--      one-off and the receptionist still leave it to the office).
--   4. Mutation: put training back to Coming soon and show the owner's add is
--      refused again. If it still goes through, INCONCLUSIVE.
--
-- Run against a freshly reset local database:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/proofs/20261027120000-training-is-bookable.sql

\set ON_ERROR_STOP on
-- The set_config() calls below return a row each; only the NOTICEs matter.
\o /dev/null
BEGIN;

-- ── FIXTURE ───────────────────────────────────────────────────────────────
CREATE TEMP TABLE _ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON _ids TO authenticated, anon, service_role;

DO $$
DECLARE
  _org uuid; _owner uuid; _other uuid; _otherOwner uuid;
BEGIN
  PERFORM set_config('app.allow_protected_org_write', '1', true);
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
  VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', 'owner@training-proof.invalid', '', now(), now(), now())
  RETURNING id INTO _owner;
  INSERT INTO public.organizations (name, public_signup_enabled, portal_slug)
  VALUES ('Training Proof Scoops', true, 'training-proof-scoops')
  RETURNING id INTO _org;
  INSERT INTO public.user_roles (user_id, organization_id, role) VALUES (_owner, _org, 'owner');
  -- A second scooping business, for the mutation: it never adds training
  -- while training is on, so it does not have to drop it again.
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
  VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', 'other@training-proof.invalid', '', now(), now(), now())
  RETURNING id INTO _otherOwner;
  INSERT INTO public.organizations (name) VALUES ('Training Proof Other Scoops') RETURNING id INTO _other;
  INSERT INTO public.user_roles (user_id, organization_id, role) VALUES (_otherOwner, _other, 'owner');
  INSERT INTO _ids VALUES ('org', _org), ('owner', _owner),
                          ('other', _other), ('other_owner', _otherOwner);
  PERFORM set_config('app.allow_protected_org_write', '', true);
END $$;

-- ── 1. The switch ─────────────────────────────────────────────────────────
-- This proof is about the training flip. A later migration that flips another
-- row (20261027180000, mobile grooming) is a different file with its own
-- proof, so put grooming back to its seed first; sections 1 and 2 rely on it
-- being Coming soon. Logged with no actor, like any setup write; nothing
-- below counts mobile_grooming rows.
UPDATE public.platform_service_lines SET bookable = false, customer_requestable = false
 WHERE service_line = 'mobile_grooming';

DO $$
BEGIN
  IF public.bookable_service_lines()
     IS DISTINCT FROM ARRAY['dog_walking','pet_sitting','pet_waste','training']::text[] THEN
    RAISE EXCEPTION 'PROOF FAILED [switch]: bookable is %, expected {dog_walking,pet_sitting,pet_waste,training}',
      public.bookable_service_lines();
  END IF;
  IF 'training' = ANY (public.customer_requestable_service_lines()) THEN
    RAISE EXCEPTION 'PROOF FAILED [switch]: training became customer requestable';
  END IF;
  IF 'mobile_grooming' = ANY (public.bookable_service_lines()) THEN
    RAISE EXCEPTION 'PROOF FAILED [switch]: grooming was turned on with training';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_admin_audit a
     WHERE a.action = 'service_line_availability'
       AND a.actor_user_id IS NULL
       AND a.before_json ->> 'service_line' = 'training'
       AND a.before_json ->> 'bookable' = 'false'
       AND a.after_json ->> 'bookable' = 'true'
       AND a.after_json ->> 'customer_requestable' = 'false'
  ) THEN
    RAISE EXCEPTION 'PROOF FAILED [audit]: the flip is not in platform_admin_audit';
  END IF;
  RAISE NOTICE 'ok: pet_waste, dog_walking, pet_sitting and training are bookable; grooming is not; training is not customer requestable';
END $$;

-- ── 2. An owner may add training, and still not grooming ──────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', (SELECT v FROM _ids WHERE k = 'owner'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
DO $$
BEGIN
  BEGIN
    UPDATE public.organizations SET service_lines = ARRAY['pet_waste', 'mobile_grooming']
     WHERE id = (SELECT v FROM _ids WHERE k = 'org');
    RAISE EXCEPTION 'PROOF FAILED [owner]: an owner added mobile_grooming';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%coming soon%' THEN RAISE; END IF;
  END;
  UPDATE public.organizations SET service_lines = ARRAY['pet_waste', 'training']
   WHERE id = (SELECT v FROM _ids WHERE k = 'org');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROOF FAILED [owner]: the owner''s save reached no row';
  END IF;
  RAISE NOTICE 'ok: an owner added training; grooming is still refused';
END $$;
RESET ROLE;

DO $$
BEGIN
  IF (SELECT service_lines FROM public.organizations WHERE id = (SELECT v FROM _ids WHERE k = 'org'))
     IS DISTINCT FROM ARRAY['pet_waste', 'training']::text[] THEN
    RAISE EXCEPTION 'PROOF FAILED [owner]: training is not on the business';
  END IF;
END $$;

-- ── 3. A stranger is offered the training, priced or not (#560) ───────────
DO $$
DECLARE
  _org uuid := (SELECT v FROM _ids WHERE k = 'org');
  _n int;
BEGIN
  INSERT INTO public.services (organization_id, name, service_line, price_unit, base_price_cents, active)
  VALUES (_org, 'Proof private lesson', 'training', 'visit', 9000, true),
         (_org, 'Proof evaluation, no price yet', 'training', 'visit', NULL, true);
  SELECT count(*) INTO _n
    FROM public.public_services('training-proof-scoops') s
   WHERE s.service_line = 'training';
  IF _n <> 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [public]: public_services listed % training service(s) to a stranger, want 2', _n;
  END IF;
  IF 'training' = ANY (public.customer_requestable_service_lines()) THEN
    RAISE EXCEPTION 'PROOF FAILED [public]: listing training on the link made it customer requestable';
  END IF;
  RAISE NOTICE 'ok: both training services are listed on the booking link; the switch is unchanged';
END $$;

-- ── 4. Mutation: back to Coming soon, the owner is refused ────────────────
UPDATE public.platform_service_lines SET bookable = false WHERE service_line = 'training';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', (SELECT v FROM _ids WHERE k = 'other_owner'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
DO $$
DECLARE
  _refused boolean := false;
BEGIN
  BEGIN
    UPDATE public.organizations SET service_lines = ARRAY['pet_waste', 'training']
     WHERE id = (SELECT v FROM _ids WHERE k = 'other');
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%coming soon%' THEN RAISE; END IF;
    _refused := true;
  END;
  IF NOT _refused THEN
    RAISE EXCEPTION 'INCONCLUSIVE [mutation]: with training off, the owner could still add it';
  END IF;
  RAISE NOTICE 'ok: mutation reproduced; with the switch off, adding training is refused';
END $$;
RESET ROLE;

ROLLBACK;
