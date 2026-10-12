-- A stranger can see what is for sale (the service catalog, phase 5, public
-- paths), proved against a real Postgres rather than read off the migration's
-- text. Run by tests/a-stranger-can-see-what-is-for-sale-in-a-real-database.test.ts,
-- which passes
--   :lines      20261008120000_a-dog-walker-should-not-have-to-learn-about-dump-sites.sql
--   :p1         20261009200000_a-walk-is-not-a-cleanup.sql
--   :p2         20261009230000_a-visit-knows-its-service.sql
--   :durations  20261009230100_a-walk-takes-as-long-as-the-walk.sql
--   :pricing    20261011100000_a-walk-is-priced-as-a-walk.sql
--   :public     20261011150000_a-stranger-can-see-what-is-for-sale.sql
-- The first five are applied only where the database does not have them yet
-- (the shared stack CI runs proofs against follows main).
--
-- Everything happens inside one transaction that is ROLLED BACK at the end,
-- the migration included. Each group prints "ok: ..." only when every check in
-- it passed, or raises "PROOF FAILED [...]", and ON_ERROR_STOP turns the first
-- failure into a non-zero exit.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

-- The bases, in order, each only where the stack was built before it.
SELECT NOT EXISTS (
  SELECT 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'service_lines'
) AS need_lines \gset
\if :need_lines
\i :lines
\endif
SELECT to_regclass('public.services') IS NULL AS need_services \gset
\if :need_services
\i :p1
\endif
SELECT NOT EXISTS (
  SELECT 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'visits' AND column_name = 'service_id'
) AS need_service_ids \gset
\if :need_service_ids
\i :p2
\i :durations
\endif
SELECT to_regprocedure('public.public_quote(text, text, integer, text, text, uuid)') IS NULL AS need_pricing \gset
\if :need_pricing
\i :pricing
\endif

-- ── Fixture ───────────────────────────────────────────────────────────────
-- Q sells online: a seeded pet-waste service (from the organizations
-- trigger), a priced walk, an hourly groom, a drop-in nobody has priced, and a
-- walk it retired. R sells the same walk but its signup switch is OFF. S is
-- deleted. Each gets its seeded "Pet waste removal" from the trigger.
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO public.organizations (id, name, slug, portal_slug, timezone, work_days, service_lines, public_signup_enabled, currency, deleted_at) VALUES
  ('06600000-0000-4000-8000-0000000000aa', 'For Sale Proof Q', 'for-sale-proof-q', 'for-sale-proof-q-portal', 'America/Chicago',
   '{0,1,2,3,4,5,6}', '{pet_waste,dog_walking,mobile_grooming}', true, 'usd', NULL),
  ('06600000-0000-4000-8000-0000000000bb', 'For Sale Proof R', 'for-sale-proof-r', NULL, 'America/Chicago',
   '{0,1,2,3,4,5,6}', '{dog_walking}', false, 'usd', NULL),
  ('06600000-0000-4000-8000-0000000000cc', 'For Sale Proof S', 'for-sale-proof-s', NULL, 'America/Chicago',
   '{0,1,2,3,4,5,6}', '{pet_waste}', true, 'usd', now());
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.zones (id, organization_id, name, zip_codes, base_price_cents, per_dog_addl_cents, initial_cleanup_cents) VALUES
  ('26600000-0000-4000-8000-0000000000a1', '06600000-0000-4000-8000-0000000000aa', 'Q Zone', ARRAY['60601'], 2000, 500, 7500);

INSERT INTO public.services (id, organization_id, name, service_line, price_unit, base_price_cents, extra_pet_cents, default_duration_min, active) VALUES
  ('56600000-0000-4000-8000-0000000000a1', '06600000-0000-4000-8000-0000000000aa', '30-minute walk', 'dog_walking', 'visit', 2500, 500, 30, true),
  ('56600000-0000-4000-8000-0000000000a2', '06600000-0000-4000-8000-0000000000aa', 'Full groom', 'mobile_grooming', 'hour', 6000, 1000, 90, true),
  ('56600000-0000-4000-8000-0000000000a3', '06600000-0000-4000-8000-0000000000aa', 'Drop-in', 'pet_sitting', 'visit', NULL, 0, 20, true),
  ('56600000-0000-4000-8000-0000000000a4', '06600000-0000-4000-8000-0000000000aa', 'Old walk', 'dog_walking', 'visit', 2000, 0, 30, false),
  ('56600000-0000-4000-8000-0000000000b1', '06600000-0000-4000-8000-0000000000bb', 'R walk', 'dog_walking', 'visit', 1800, 0, 30, true);

SELECT count(*) = 0 AS no_pw FROM public.services s
 WHERE s.organization_id = '06600000-0000-4000-8000-0000000000aa' AND lower(s.name) = 'pet waste removal' \gset
\if :no_pw
\echo PROOF FAILED [fixture]: Q has no seeded pet-waste service
\quit 1
\endif
SELECT s.id AS pw_id FROM public.services s
 WHERE s.organization_id = '06600000-0000-4000-8000-0000000000aa' AND lower(s.name) = 'pet waste removal' \gset

-- ── The migration, inside this transaction ────────────────────────────────
\i :public

-- ── 1. What anon sees, and in what order ──────────────────────────────────
-- The pet-waste id, where anon can read it: psql does not interpolate :'var'
-- inside a dollar-quoted body, and anon cannot read the table.
SELECT set_config('app.pw_id', :'pw_id', true);
SET ROLE anon;
DO $$
DECLARE _ids uuid[]; _r record; _n int; _err text;
BEGIN
  SELECT array_agg(id ORDER BY ord) INTO _ids
    FROM public.public_services('for-sale-proof-q') WITH ORDINALITY AS t(id, name, service_line, price_unit, base_price_cents, extra_pet_cents, default_duration_min, ord);
  IF _ids IS DISTINCT FROM ARRAY[current_setting('app.pw_id', true)::uuid, '56600000-0000-4000-8000-0000000000a1'::uuid, '56600000-0000-4000-8000-0000000000a2'::uuid] THEN
    RAISE EXCEPTION 'PROOF FAILED [list]: Q''s page lists % (want pet waste, walk, groom; not the unpriced drop-in, not the retired walk)', _ids;
  END IF;
  -- The columns a picker and public_quote need, and the pet-waste row's NULL base.
  SELECT * INTO _r FROM public.public_services('for-sale-proof-q') WHERE id = '56600000-0000-4000-8000-0000000000a2';
  IF _r.name <> 'Full groom' OR _r.service_line <> 'mobile_grooming' OR _r.price_unit <> 'hour'
     OR _r.base_price_cents <> 6000 OR _r.extra_pet_cents <> 1000 OR _r.default_duration_min <> 90 THEN
    RAISE EXCEPTION 'PROOF FAILED [list]: the groom row reads %', row_to_json(_r);
  END IF;
  SELECT * INTO _r FROM public.public_services('for-sale-proof-q') WHERE id = current_setting('app.pw_id', true)::uuid;
  IF _r.base_price_cents IS NOT NULL OR _r.service_line <> 'pet_waste' THEN
    RAISE EXCEPTION 'PROOF FAILED [list]: the pet-waste row reads %', row_to_json(_r);
  END IF;
  -- The portal slug answers too, and prefers itself.
  SELECT count(*) INTO _n FROM public.public_services('for-sale-proof-q-portal');
  IF _n <> 3 THEN RAISE EXCEPTION 'PROOF FAILED [list]: the portal slug lists % services', _n; END IF;
  -- Switch off, deleted, unknown: nothing, as public_quote would price nothing.
  SELECT count(*) INTO _n FROM public.public_services('for-sale-proof-r');
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [gate]: R has its signup off and lists % services', _n; END IF;
  SELECT count(*) INTO _n FROM public.public_services('for-sale-proof-s');
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [gate]: deleted S lists % services', _n; END IF;
  SELECT count(*) INTO _n FROM public.public_services('nobody-here');
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [gate]: an unknown slug lists % services', _n; END IF;
  -- The table itself stays shut.
  BEGIN
    PERFORM 1 FROM public.services;
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [door]: anon can read public.services directly'; END IF;
  RAISE NOTICE 'ok: anon lists Q''s pet-waste service, walk and groom in that order, with the picker''s columns; not the unpriced or retired ones; nothing for a switched-off, deleted or unknown business; and cannot read the table';
END $$;

-- ── 2. The id it was handed prices through public_quote ───────────────────
DO $$
DECLARE r record; _before text; _after text;
BEGIN
  SELECT * INTO r FROM public.public_quote('for-sale-proof-q', '60601', 2, 'weekly', NULL, '56600000-0000-4000-8000-0000000000a1');
  IF r.recurring_price_cents <> 3000 OR r.initial_cleanup_cents <> 0 OR r.first_cleanup_mode <> 'off' THEN
    RAISE EXCEPTION 'PROOF FAILED [quote]: the listed walk quoted %', row_to_json(r);
  END IF;
  -- The pet-waste row's id is the zone quote, byte for byte.
  SELECT row_to_json(q)::text INTO _before FROM public.public_quote('for-sale-proof-q', '60601', 2, 'weekly') q;
  SELECT row_to_json(q)::text INTO _after FROM public.public_quote('for-sale-proof-q', '60601', 2, 'weekly', NULL, current_setting('app.pw_id', true)::uuid) q;
  IF _before IS DISTINCT FROM _after OR _before NOT LIKE '%"recurring_price_cents":2500%' THEN
    RAISE EXCEPTION 'PROOF FAILED [quote]: the pet-waste id does not quote the yard: % / %', _before, _after;
  END IF;
  RAISE NOTICE 'ok: the walk the list named prices as a walk through public_quote, and the pet-waste id prices the yard exactly as no service does';
END $$;
RESET ROLE;

-- ── 3. A lead and a signup can say what was asked for ─────────────────────
DO $$
DECLARE _lead uuid; _sr uuid; _err text; _svc uuid;
BEGIN
  INSERT INTO public.leads (organization_id, name, email, source, status, service_id)
  VALUES ('06600000-0000-4000-8000-0000000000aa', 'Proof Lead', 'lead@for-sale.proof.invalid', 'website', 'new', '56600000-0000-4000-8000-0000000000a1')
  RETURNING id INTO _lead;
  INSERT INTO public.signup_requests (organization_id, zone_id, name, email, street, postal_code, dog_count, frequency, recurring_price_cents, initial_cleanup_cents, currency, service_id)
  VALUES ('06600000-0000-4000-8000-0000000000aa', '26600000-0000-4000-8000-0000000000a1', 'Proof Signup', 'signup@for-sale.proof.invalid', '1 Proof Lane', '60601', 1, 'weekly', 2500, 0, 'usd', '56600000-0000-4000-8000-0000000000a1')
  RETURNING id INTO _sr;
  -- A made-up service is refused by the foreign key.
  BEGIN
    INSERT INTO public.leads (organization_id, name, email, source, status, service_id)
    VALUES ('06600000-0000-4000-8000-0000000000aa', 'Bad Lead', 'bad@for-sale.proof.invalid', 'website', 'new', '56600000-0000-4000-8000-00000000dead');
  EXCEPTION WHEN foreign_key_violation THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [lead]: a lead can name a service that does not exist'; END IF;
  -- Retiring a service leaves the lead; deleting one lets go of it.
  UPDATE public.services SET active = false WHERE id = '56600000-0000-4000-8000-0000000000a1';
  SELECT service_id INTO _svc FROM public.leads WHERE id = _lead;
  IF _svc IS DISTINCT FROM '56600000-0000-4000-8000-0000000000a1' THEN
    RAISE EXCEPTION 'PROOF FAILED [lead]: retiring the walk changed the lead to %', _svc;
  END IF;
  DELETE FROM public.services WHERE id = '56600000-0000-4000-8000-0000000000a1';
  SELECT service_id INTO _svc FROM public.leads WHERE id = _lead;
  IF _svc IS NOT NULL THEN RAISE EXCEPTION 'PROOF FAILED [lead]: deleting the walk left the lead pointing at %', _svc; END IF;
  SELECT service_id INTO _svc FROM public.signup_requests WHERE id = _sr;
  IF _svc IS NOT NULL THEN RAISE EXCEPTION 'PROOF FAILED [signup]: deleting the walk left the signup pointing at %', _svc; END IF;
  -- And the rows every business wrote before: no service, as ever.
  INSERT INTO public.leads (organization_id, name, email, source, status)
  VALUES ('06600000-0000-4000-8000-0000000000aa', 'Plain Lead', 'plain@for-sale.proof.invalid', 'website', 'new')
  RETURNING service_id INTO _svc;
  IF _svc IS NOT NULL THEN RAISE EXCEPTION 'PROOF FAILED [lead]: a lead with no service was given one'; END IF;
  RAISE NOTICE 'ok: a lead and a signup record the service asked for, refuse one that does not exist, keep a retired one, let go of a deleted one, and default to none';
END $$;

DO $$ BEGIN RAISE NOTICE 'ALL PUBLIC SERVICE PROOFS PASSED'; END $$;
ROLLBACK;
