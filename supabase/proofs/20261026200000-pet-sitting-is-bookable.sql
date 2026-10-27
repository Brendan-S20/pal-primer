-- Proof for 20261026200000: pet sitting is bookable (#547).
--
--   1. The switch answers {dog_walking, pet_sitting, pet_waste}; sitting is
--      still requestable by a customer; grooming and training are still
--      Coming soon. The flip is in platform_admin_audit with no actor.
--   2. A signed-in owner of a scooping business may add pet_sitting, and is
--      still refused grooming and training.
--   3. public_services lists a PRICED sitting service to a stranger and
--      leaves an unpriced one out.
--   4. Mutation: put sitting back to Coming soon and show the owner's add is
--      refused again. If it still goes through, INCONCLUSIVE.
--
-- Run against a freshly reset local database:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/proofs/20261026200000-pet-sitting-is-bookable.sql

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
          'authenticated', 'owner@sitting-proof.invalid', '', now(), now(), now())
  RETURNING id INTO _owner;
  INSERT INTO public.organizations (name, public_signup_enabled, portal_slug)
  VALUES ('Sitting Proof Scoops', true, 'sitting-proof-scoops')
  RETURNING id INTO _org;
  INSERT INTO public.user_roles (user_id, organization_id, role) VALUES (_owner, _org, 'owner');
  -- A second scooping business, for the mutation: it never adds sitting
  -- while sitting is on, so it does not have to drop it again.
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
  VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', 'other@sitting-proof.invalid', '', now(), now(), now())
  RETURNING id INTO _otherOwner;
  INSERT INTO public.organizations (name) VALUES ('Sitting Proof Other Scoops') RETURNING id INTO _other;
  INSERT INTO public.user_roles (user_id, organization_id, role) VALUES (_otherOwner, _other, 'owner');
  INSERT INTO _ids VALUES ('org', _org), ('owner', _owner),
                          ('other', _other), ('other_owner', _otherOwner);
  PERFORM set_config('app.allow_protected_org_write', '', true);
END $$;

-- ── 1. The switch ─────────────────────────────────────────────────────────
-- This proof is about the sitting flip. A later migration that flips another
-- row (20261027120000, training; 20261027180000, mobile grooming) is a
-- different file with its own proof, so put those back to their seed first;
-- sections 1 and 2 rely on them being Coming soon. Logged with no actor, like
-- any setup write; nothing below counts training or mobile_grooming rows.
UPDATE public.platform_service_lines SET bookable = false WHERE service_line = 'training';
UPDATE public.platform_service_lines SET bookable = false, customer_requestable = false
 WHERE service_line = 'mobile_grooming';

DO $$
BEGIN
  IF public.bookable_service_lines() IS DISTINCT FROM ARRAY['dog_walking','pet_sitting','pet_waste']::text[] THEN
    RAISE EXCEPTION 'PROOF FAILED [switch]: bookable is %, expected {dog_walking,pet_sitting,pet_waste}',
      public.bookable_service_lines();
  END IF;
  IF NOT ('pet_sitting' = ANY (public.customer_requestable_service_lines())) THEN
    RAISE EXCEPTION 'PROOF FAILED [switch]: pet_sitting is no longer customer requestable';
  END IF;
  IF 'mobile_grooming' = ANY (public.bookable_service_lines())
     OR 'training' = ANY (public.bookable_service_lines()) THEN
    RAISE EXCEPTION 'PROOF FAILED [switch]: grooming or training was turned on with sitting';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_admin_audit a
     WHERE a.action = 'service_line_availability'
       AND a.actor_user_id IS NULL
       AND a.before_json ->> 'service_line' = 'pet_sitting'
       AND a.before_json ->> 'bookable' = 'false'
       AND a.after_json ->> 'bookable' = 'true'
       AND a.after_json ->> 'customer_requestable' = 'true'
  ) THEN
    RAISE EXCEPTION 'PROOF FAILED [audit]: the flip is not in platform_admin_audit';
  END IF;
  RAISE NOTICE 'ok: pet_waste, dog_walking and pet_sitting are bookable; grooming and training are not';
END $$;

-- ── 2. An owner may add sitting, and nothing else that is Coming soon ─────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', (SELECT v FROM _ids WHERE k = 'owner'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
DO $$
DECLARE
  _line text;
BEGIN
  FOREACH _line IN ARRAY ARRAY['mobile_grooming', 'training'] LOOP
    BEGIN
      UPDATE public.organizations SET service_lines = ARRAY['pet_waste', _line]
       WHERE id = (SELECT v FROM _ids WHERE k = 'org');
      RAISE EXCEPTION 'PROOF FAILED [owner]: an owner added %', _line;
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM NOT LIKE '%coming soon%' THEN RAISE; END IF;
    END;
  END LOOP;
  UPDATE public.organizations SET service_lines = ARRAY['pet_waste', 'pet_sitting']
   WHERE id = (SELECT v FROM _ids WHERE k = 'org');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROOF FAILED [owner]: the owner''s save reached no row';
  END IF;
  RAISE NOTICE 'ok: an owner added pet_sitting; grooming and training are still refused';
END $$;
RESET ROLE;

DO $$
BEGIN
  IF (SELECT service_lines FROM public.organizations WHERE id = (SELECT v FROM _ids WHERE k = 'org'))
     IS DISTINCT FROM ARRAY['pet_waste', 'pet_sitting']::text[] THEN
    RAISE EXCEPTION 'PROOF FAILED [owner]: pet_sitting is not on the business';
  END IF;
END $$;

-- ── 3. A stranger sees a priced stay and not an unpriced one ──────────────
DO $$
DECLARE
  _org uuid := (SELECT v FROM _ids WHERE k = 'org');
  _names text[];
BEGIN
  INSERT INTO public.services (organization_id, name, service_line, price_unit, base_price_cents, active)
  VALUES (_org, 'Proof overnight stay', 'pet_sitting', 'night', 8500, true),
         (_org, 'Proof drop-in, no price yet', 'pet_sitting', 'visit', NULL, true);
  -- Adding the line seeds starter sitting services of its own, so look only
  -- at the two this section made.
  SELECT array_agg(s.name ORDER BY s.name) INTO _names
    FROM public.public_services('sitting-proof-scoops') s
   WHERE s.service_line = 'pet_sitting'
     AND s.name LIKE 'Proof %';
  IF _names IS DISTINCT FROM ARRAY['Proof overnight stay']::text[] THEN
    RAISE EXCEPTION 'PROOF FAILED [public]: public_services listed % for sitting', _names;
  END IF;
  RAISE NOTICE 'ok: a priced stay is listed to a stranger; an unpriced one is not';
END $$;

-- ── 4. Mutation: back to Coming soon, the owner is refused ────────────────
UPDATE public.platform_service_lines SET bookable = false WHERE service_line = 'pet_sitting';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', (SELECT v FROM _ids WHERE k = 'other_owner'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
DO $$
DECLARE
  _refused boolean := false;
BEGIN
  BEGIN
    UPDATE public.organizations SET service_lines = ARRAY['pet_waste', 'pet_sitting']
     WHERE id = (SELECT v FROM _ids WHERE k = 'other');
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%coming soon%' THEN RAISE; END IF;
    _refused := true;
  END;
  IF NOT _refused THEN
    RAISE EXCEPTION 'INCONCLUSIVE [mutation]: with sitting off, the owner could still add it';
  END IF;
  RAISE NOTICE 'ok: mutation reproduced; with the switch off, adding sitting is refused';
END $$;
RESET ROLE;

ROLLBACK;
