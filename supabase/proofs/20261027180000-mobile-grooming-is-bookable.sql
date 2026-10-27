-- Proof for 20261027180000: mobile grooming is bookable (#549).
--
--   1. The switch answers {dog_walking, mobile_grooming, pet_sitting,
--      pet_waste, training}; grooming is customer requestable and training is
--      still NOT. The flip is in platform_admin_audit with no actor.
--   2. A signed-in owner of a scooping business may add mobile grooming.
--   3. portal_request_groom takes a request from a client of a grooming
--      business, and a second tap for the same pet and day hands it back.
--   4. Mutation: keep grooming bookable but turn customer_requestable off,
--      and show portal_request_groom refuses with 'groom_requests_off' and
--      writes nothing. If it still takes the request, INCONCLUSIVE.
--
-- Run against a freshly reset local database:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/proofs/20261027180000-mobile-grooming-is-bookable.sql

\set ON_ERROR_STOP on
-- The set_config() calls below return a row each; only the NOTICEs matter.
\o /dev/null
BEGIN;

-- ── FIXTURE ───────────────────────────────────────────────────────────────
CREATE TEMP TABLE _ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON _ids TO authenticated, anon, service_role;

DO $$
DECLARE
  _org uuid; _owner uuid; _groomer uuid; _client uuid; _property uuid; _dog uuid;
  _service uuid; _token uuid;
BEGIN
  PERFORM set_config('app.allow_protected_org_write', '1', true);
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
  VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', 'owner@grooming-proof.invalid', '', now(), now(), now())
  RETURNING id INTO _owner;
  INSERT INTO public.organizations (name) VALUES ('Grooming Proof Scoops') RETURNING id INTO _org;
  INSERT INTO public.user_roles (user_id, organization_id, role) VALUES (_owner, _org, 'owner');

  -- A business that already grooms, every day a working day, on UTC.
  INSERT INTO public.organizations (name, service_lines, timezone, work_days)
  VALUES ('Grooming Proof Groomers', ARRAY['pet_waste', 'mobile_grooming'], 'UTC',
          ARRAY[0,1,2,3,4,5,6])
  RETURNING id INTO _groomer;
  INSERT INTO public.clients (organization_id, display_name, account_type, active)
  VALUES (_groomer, 'Proof portal client', 'residential', true)
  RETURNING id, portal_token INTO _client, _token;
  INSERT INTO public.properties (organization_id, client_id, street, city, postal_code)
  VALUES (_groomer, _client, '1 Proof St', 'Austin', '78701')
  RETURNING id INTO _property;
  INSERT INTO public.dogs (organization_id, property_id, name, active)
  VALUES (_groomer, _property, 'Biscuit', true)
  RETURNING id INTO _dog;
  INSERT INTO public.services (organization_id, name, service_line, price_unit,
                               default_duration_min, base_price_cents, active)
  VALUES (_groomer, 'Proof full groom', 'mobile_grooming', 'visit', 90, 8000, true)
  RETURNING id INTO _service;

  INSERT INTO _ids VALUES ('org', _org), ('owner', _owner), ('groomer', _groomer),
                          ('dog', _dog), ('service', _service), ('token', _token);
  PERFORM set_config('app.allow_protected_org_write', '', true);
END $$;

-- ── 1. The switch ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF public.bookable_service_lines()
     IS DISTINCT FROM ARRAY['dog_walking','mobile_grooming','pet_sitting','pet_waste','training']::text[] THEN
    RAISE EXCEPTION 'PROOF FAILED [switch]: bookable is %, expected {dog_walking,mobile_grooming,pet_sitting,pet_waste,training}',
      public.bookable_service_lines();
  END IF;
  IF NOT ('mobile_grooming' = ANY (public.customer_requestable_service_lines())) THEN
    RAISE EXCEPTION 'PROOF FAILED [switch]: mobile_grooming is not customer requestable';
  END IF;
  IF 'training' = ANY (public.customer_requestable_service_lines()) THEN
    RAISE EXCEPTION 'PROOF FAILED [switch]: training became customer requestable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_admin_audit a
     WHERE a.action = 'service_line_availability'
       AND a.actor_user_id IS NULL
       AND a.before_json ->> 'service_line' = 'mobile_grooming'
       AND a.before_json ->> 'bookable' = 'false'
       AND a.before_json ->> 'customer_requestable' = 'false'
       AND a.after_json ->> 'bookable' = 'true'
       AND a.after_json ->> 'customer_requestable' = 'true'
  ) THEN
    RAISE EXCEPTION 'PROOF FAILED [audit]: the flip is not in platform_admin_audit';
  END IF;
  RAISE NOTICE 'ok: all five offered lines are bookable; grooming is customer requestable; training is not';
END $$;

-- ── 2. An owner may add grooming ──────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', (SELECT v FROM _ids WHERE k = 'owner'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
DO $$
BEGIN
  UPDATE public.organizations SET service_lines = ARRAY['pet_waste', 'mobile_grooming']
   WHERE id = (SELECT v FROM _ids WHERE k = 'org');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROOF FAILED [owner]: the owner''s save reached no row';
  END IF;
  RAISE NOTICE 'ok: an owner added mobile grooming';
END $$;
RESET ROLE;

DO $$
BEGIN
  IF (SELECT service_lines FROM public.organizations WHERE id = (SELECT v FROM _ids WHERE k = 'org'))
     IS DISTINCT FROM ARRAY['pet_waste', 'mobile_grooming']::text[] THEN
    RAISE EXCEPTION 'PROOF FAILED [owner]: grooming is not on the business';
  END IF;
END $$;

-- ── 3. A client may ask for a groom ───────────────────────────────────────
DO $$
DECLARE
  _day date := (now() AT TIME ZONE 'UTC')::date + 5;
  _first record; _again record;
BEGIN
  SELECT * INTO _first FROM public.portal_request_groom(
    (SELECT v FROM _ids WHERE k = 'token'), (SELECT v FROM _ids WHERE k = 'dog'),
    (SELECT v FROM _ids WHERE k = 'service'), '[]'::jsonb, _day,
    '08:00'::time, '12:00'::time, 'Short cut', 8000, 120);
  IF _first.ticket_id IS NULL OR NOT _first.created THEN
    RAISE EXCEPTION 'PROOF FAILED [request]: the request was not taken (%)', row_to_json(_first);
  END IF;
  SELECT * INTO _again FROM public.portal_request_groom(
    (SELECT v FROM _ids WHERE k = 'token'), (SELECT v FROM _ids WHERE k = 'dog'),
    (SELECT v FROM _ids WHERE k = 'service'), '[]'::jsonb, _day,
    NULL, NULL, '', NULL, NULL);
  IF _again.ticket_id IS DISTINCT FROM _first.ticket_id OR _again.created THEN
    RAISE EXCEPTION 'PROOF FAILED [request]: a second tap did not hand back the first request';
  END IF;
  IF EXISTS (SELECT 1 FROM public.visits v WHERE v.organization_id = (SELECT v FROM _ids WHERE k = 'groomer')) THEN
    RAISE EXCEPTION 'PROOF FAILED [request]: a groom request booked a visit';
  END IF;
  RAISE NOTICE 'ok: a client asked for a groom; it is one request in the office queue and no visit';
END $$;

-- ── 4. Mutation: bookable but not customer requestable is refused ─────────
UPDATE public.platform_service_lines SET customer_requestable = false
 WHERE service_line = 'mobile_grooming';

DO $$
DECLARE
  _refused boolean := false;
  _before integer;
  _after integer;
BEGIN
  SELECT count(*) INTO _before FROM public.qc_tickets t
   WHERE t.organization_id = (SELECT v FROM _ids WHERE k = 'groomer');
  BEGIN
    PERFORM * FROM public.portal_request_groom(
      (SELECT v FROM _ids WHERE k = 'token'), (SELECT v FROM _ids WHERE k = 'dog'),
      (SELECT v FROM _ids WHERE k = 'service'), '[]'::jsonb,
      (now() AT TIME ZONE 'UTC')::date + 6, NULL, NULL, '', NULL, NULL);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'groom_requests_off' THEN RAISE; END IF;
    _refused := true;
  END;
  IF NOT _refused THEN
    RAISE EXCEPTION 'INCONCLUSIVE [mutation]: with customer_requestable off, portal_request_groom still took a request';
  END IF;
  SELECT count(*) INTO _after FROM public.qc_tickets t
   WHERE t.organization_id = (SELECT v FROM _ids WHERE k = 'groomer');
  IF _after <> _before THEN
    RAISE EXCEPTION 'PROOF FAILED [mutation]: the refused request wrote a row';
  END IF;
  RAISE NOTICE 'ok: mutation reproduced; bookable but not customer requestable, portal_request_groom refuses';
END $$;

ROLLBACK;
