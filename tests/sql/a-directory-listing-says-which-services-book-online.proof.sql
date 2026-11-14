-- A directory listing says which services book online (#630; mypets v2 step
-- 7), proved against a real Postgres. Run by
-- tests/a-directory-listing-says-which-services-book-online.test.ts with
-- :migration, and by CI's database job through
-- supabase/proofs/20261112100000-a-directory-listing-says-which-services-book-online.sql
-- with no :migration (the database was just built from every migration).
-- One transaction, ROLLED BACK at the end. Each check prints "ok: ..." or
-- raises "PROOF FAILED [...]".
--
-- Six businesses, every one a labelled proof fixture:
--   E  exists BEFORE the migration runs (when it is applied here);
--   A  publishes six services, one of each kind the rules tell apart:
--        a1 recurring walk, a2 one-visit walk, a3 request-only walk,
--        a4 training package that can be sold, a5 training package
--        whose package is off sale, a6 zone-priced scoop (no base price);
--   B  another business whose owner must not touch A;
--   U  opted in with every gate on, but unpublished;
--   D  published with every gate on, then deleted;
--   F  created after the migration.
-- Every business carries an owner email, phone, address and Stripe ids, so a
-- leak of any of them is a string to look for.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

-- E exists before the columns do, when this run applies them.
SELECT set_config('request.jwt.claims', '{}', true);
INSERT INTO public.organizations (id, name, timezone, service_lines)
VALUES ('07370000-0000-4000-8000-0000000000ee', 'Booking Proof ee (TEST)', 'UTC', '{dog_walking}');

\if :{?migration}
\i :migration
\endif

-- ── Fixture ─────────────────────────────────────────────────────────────────
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('f7370000-0000-4000-8000-000000000a01', 'owner-a@booking.proof.invalid'),
  ('f7370000-0000-4000-8000-000000000a02', 'office-a@booking.proof.invalid'),
  ('f7370000-0000-4000-8000-000000000b01', 'owner-b@booking.proof.invalid'),
  ('f7370000-0000-4000-8000-000000000c01', 'owner-u@booking.proof.invalid'),
  ('f7370000-0000-4000-8000-000000000d01', 'owner-d@booking.proof.invalid');
INSERT INTO public.organizations (id, name, timezone, service_lines, portal_slug, contact_email, contact_phone, contact_address,
                                  stripe_customer_id, stripe_connect_account_id)
SELECT ('07370000-0000-4000-8000-0000000000' || k)::uuid, 'Booking Proof ' || k || ' (TEST)', 'UTC', '{dog_walking,pet_waste,training}',
       'booking-proof-portal-' || k,
       'owner-' || k || '@booking.proof.invalid', '+1313555030' || length(k),
       k || ' Leak Avenue, Detroit MI', 'cus_bookingproof' || k, 'acct_bookingproof' || k
  FROM unnest(ARRAY['aa', 'bb', 'cc', 'dd']) k;
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('f7370000-0000-4000-8000-000000000a01', '07370000-0000-4000-8000-0000000000aa', 'owner'),
  ('f7370000-0000-4000-8000-000000000a02', '07370000-0000-4000-8000-0000000000aa', 'office_manager'),
  ('f7370000-0000-4000-8000-000000000b01', '07370000-0000-4000-8000-0000000000bb', 'owner'),
  ('f7370000-0000-4000-8000-000000000c01', '07370000-0000-4000-8000-0000000000cc', 'owner'),
  ('f7370000-0000-4000-8000-000000000d01', '07370000-0000-4000-8000-0000000000dd', 'owner');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.services (id, organization_id, name, service_line, price_unit, base_price_cents, extra_pet_cents,
                             default_duration_min, active, public_booking_mode)
VALUES
  ('57370000-0000-4000-8000-0000000000a1', '07370000-0000-4000-8000-0000000000aa', 'Daily walk', 'dog_walking', 'visit', 2500, 0, 30, true, 'recurring'),
  ('57370000-0000-4000-8000-0000000000a2', '07370000-0000-4000-8000-0000000000aa', 'Single walk', 'dog_walking', 'visit', 3000, 0, 30, true, 'one_time'),
  ('57370000-0000-4000-8000-0000000000a3', '07370000-0000-4000-8000-0000000000aa', 'Meet and greet', 'dog_walking', 'visit', 1000, 0, 30, true, 'request_only'),
  ('57370000-0000-4000-8000-0000000000a4', '07370000-0000-4000-8000-0000000000aa', 'Lesson pack', 'training', 'visit', 6000, 0, 60, true, 'package'),
  ('57370000-0000-4000-8000-0000000000a5', '07370000-0000-4000-8000-0000000000aa', 'Old pack', 'training', 'visit', 6000, 0, 60, true, 'package'),
  ('57370000-0000-4000-8000-0000000000a6', '07370000-0000-4000-8000-0000000000aa', 'Yard scoop', 'pet_waste', 'visit', NULL, 0, 15, true, 'recurring'),
  ('57370000-0000-4000-8000-0000000000bb', '07370000-0000-4000-8000-0000000000bb', 'B walk', 'dog_walking', 'visit', 2500, 0, 30, true, 'recurring'),
  ('57370000-0000-4000-8000-0000000000cc', '07370000-0000-4000-8000-0000000000cc', 'U walk', 'dog_walking', 'visit', 2500, 0, 30, true, 'recurring'),
  ('57370000-0000-4000-8000-0000000000dd', '07370000-0000-4000-8000-0000000000dd', 'D walk', 'dog_walking', 'visit', 2500, 0, 30, true, 'recurring');
INSERT INTO public.service_packages (id, organization_id, service_id, name, sessions_count, price_cents, active) VALUES
  ('67370000-0000-4000-8000-0000000000f1', '07370000-0000-4000-8000-0000000000aa', '57370000-0000-4000-8000-0000000000a4', 'Five lessons', 5, 27500, true),
  ('67370000-0000-4000-8000-0000000000f2', '07370000-0000-4000-8000-0000000000aa', '57370000-0000-4000-8000-0000000000a5', 'Retired pack', 10, 20000, false);
UPDATE public.services SET public_package_id = '67370000-0000-4000-8000-0000000000f1' WHERE id = '57370000-0000-4000-8000-0000000000a4';
UPDATE public.services SET public_package_id = '67370000-0000-4000-8000-0000000000f2' WHERE id = '57370000-0000-4000-8000-0000000000a5';
-- A package is a training service's (training_service_package_guard), and
-- the platform does not let a visitor book training today. The fixture turns
-- it on, inside this transaction, so the package rules have something to
-- decide; section 6 turns a line off to show that gate too.
UPDATE public.platform_service_lines SET bookable = true WHERE service_line IN ('dog_walking', 'pet_waste', 'training');

CREATE FUNCTION pg_temp.as_user(_uid text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
           json_build_object('sub', _uid, 'role', 'authenticated', 'aal', 'aal2')::text, true);
$$;
GRANT EXECUTE ON FUNCTION pg_temp.as_user(text) TO authenticated;

-- Raises PROOF FAILED unless _sql fails with SQLSTATE _state.
CREATE FUNCTION pg_temp.refused(_label text, _sql text, _state text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE _got text;
BEGIN
  BEGIN
    EXECUTE _sql;
  EXCEPTION WHEN OTHERS THEN _got := SQLSTATE;
  END;
  IF _got IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [%]: it was allowed', _label;
  ELSIF _got <> _state THEN
    RAISE EXCEPTION 'PROOF FAILED [%]: refused with % (want %)', _label, _got, _state;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.refused(text, text, text) TO authenticated, anon;

-- A's listing, one line: "books_online|book_path|label=mode[+pkg] ...".
CREATE FUNCTION pg_temp.a_reads() RETURNS text LANGUAGE sql AS $$
  SELECT v.books_online::text || '|' || COALESCE(v.book_path, '-') || '|' ||
         (SELECT string_agg(e->>'label' || '=' || (e->>'booking_mode')
                   || CASE WHEN e->'package' IS NOT NULL AND e->'package' <> 'null'::jsonb
                           THEN '+' || (e->'package'->>'name') || '/' || (e->'package'->>'sessions_count') || '/' || (e->'package'->>'price_cents')
                           ELSE '' END, ' ' ORDER BY o)
            FROM jsonb_array_elements(v.services) WITH ORDINALITY AS u(e, o))
    FROM public.directory_public_listings v WHERE v.slug = 'booking-proof-a';
$$;
GRANT EXECUTE ON FUNCTION pg_temp.a_reads() TO anon, authenticated;

-- The platform-only gates, as the platform (service role / Stripe sync).
CREATE FUNCTION pg_temp.gates(_org text, _signup boolean, _charges boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.allow_protected_org_write', '1', true);
  UPDATE public.organizations SET public_signup_enabled = _signup, stripe_connect_charges_enabled = _charges
   WHERE id = ('07370000-0000-4000-8000-0000000000' || _org)::uuid;
  PERFORM set_config('app.allow_protected_org_write', '', true);
END $$;

-- ── 1. Published profiles, written by their owners ─────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('f7370000-0000-4000-8000-000000000a01');
SELECT public.set_directory_profile('07370000-0000-4000-8000-0000000000aa', 'booking-proof-a', 'Booking Proof A (TEST)', 'We walk dogs.', false,
  ARRAY['48201', '48202'], ARRAY['Detroit'],
  '[{"service_id":"57370000-0000-4000-8000-0000000000a1","price_from_cents":2200},
    {"service_id":"57370000-0000-4000-8000-0000000000a2"},
    {"service_id":"57370000-0000-4000-8000-0000000000a3"},
    {"service_id":"57370000-0000-4000-8000-0000000000a4"},
    {"service_id":"57370000-0000-4000-8000-0000000000a5"},
    {"service_id":"57370000-0000-4000-8000-0000000000a6"}]'::jsonb, true,
  NULL, NULL, NULL);
SELECT pg_temp.as_user('f7370000-0000-4000-8000-000000000c01');
SELECT public.set_directory_profile('07370000-0000-4000-8000-0000000000cc', 'booking-proof-u', 'Booking Proof U (TEST)', NULL, false,
  ARRAY['48201'], NULL, '[{"service_id":"57370000-0000-4000-8000-0000000000cc"}]'::jsonb, false, NULL, NULL, NULL);
SELECT public.set_directory_booking('07370000-0000-4000-8000-0000000000cc', true, 'Unpublished policy');
SELECT pg_temp.as_user('f7370000-0000-4000-8000-000000000d01');
SELECT public.set_directory_profile('07370000-0000-4000-8000-0000000000dd', 'booking-proof-d', 'Booking Proof D (TEST)', NULL, false,
  ARRAY['48201'], NULL, '[{"service_id":"57370000-0000-4000-8000-0000000000dd"}]'::jsonb, true, NULL, NULL, NULL);
SELECT public.set_directory_booking('07370000-0000-4000-8000-0000000000dd', true, 'Deleted policy');
SELECT pg_temp.as_user('f7370000-0000-4000-8000-000000000b01');
SELECT public.set_directory_profile('07370000-0000-4000-8000-0000000000bb', 'booking-proof-b', 'Booking Proof B (TEST)', NULL, false,
  ARRAY['48201'], NULL, '[{"service_id":"57370000-0000-4000-8000-0000000000bb"}]'::jsonb, true, NULL, NULL, NULL);
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);
SELECT pg_temp.gates('cc', true, true);
SELECT pg_temp.gates('dd', true, true);
SET LOCAL app.allow_protected_org_write = '1';
UPDATE public.organizations SET deleted_at = now() WHERE id = '07370000-0000-4000-8000-0000000000dd';
SET LOCAL app.allow_protected_org_write = '';
INSERT INTO public.organizations (id, name, timezone, service_lines)
VALUES ('07370000-0000-4000-8000-0000000000ff', 'Booking Proof ff (TEST)', 'UTC', '{dog_walking}');

-- ── 2. Off by default, for a business that existed and one created after ──
DO $$
DECLARE _r text;
BEGIN
  SELECT string_agg(right(id::text, 2) || '=' || directory_booking_enabled::text || '/' || COALESCE(booking_policy_text, '-'), ' ' ORDER BY id)
    INTO _r FROM public.organizations
   WHERE id IN ('07370000-0000-4000-8000-0000000000ee', '07370000-0000-4000-8000-0000000000ff',
                '07370000-0000-4000-8000-0000000000aa', '07370000-0000-4000-8000-0000000000bb');
  IF _r IS DISTINCT FROM 'aa=false/- bb=false/- ee=false/- ff=false/-' THEN
    RAISE EXCEPTION 'PROOF FAILED [default]: %', _r;
  END IF;
  IF pg_temp.a_reads() IS DISTINCT FROM
     'false|-|Daily walk=request_only Single walk=request_only Meet and greet=request_only Lesson pack=request_only Old pack=request_only Yard scoop=request_only' THEN
    RAISE EXCEPTION 'PROOF FAILED [default]: A reads %', pg_temp.a_reads();
  END IF;
  RAISE NOTICE 'ok: directory booking is off and the policy empty for a business that existed before the migration, one created after, and two that published; every service reads request_only, books_online false, no book_path';
END $$;

-- ── 3. Nobody but A's owner changes A's switch or policy ───────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('f7370000-0000-4000-8000-000000000a02');
SELECT pg_temp.refused('owner: office manager, writer',
  $q$SELECT public.set_directory_booking('07370000-0000-4000-8000-0000000000aa', true, NULL)$q$, '42501');
SELECT pg_temp.as_user('f7370000-0000-4000-8000-000000000b01');
SELECT pg_temp.refused('owner: another business''s owner, writer',
  $q$SELECT public.set_directory_booking('07370000-0000-4000-8000-0000000000aa', true, NULL)$q$, '42501');
SELECT pg_temp.as_user('f7370000-0000-4000-8000-000000000a01');
SELECT pg_temp.refused('owner: A''s owner, straight at the column',
  $q$UPDATE public.organizations SET directory_booking_enabled = true WHERE id = '07370000-0000-4000-8000-0000000000aa'$q$, '42501');
SELECT pg_temp.refused('owner: A''s owner, policy straight at the column',
  $q$UPDATE public.organizations SET booking_policy_text = 'x' WHERE id = '07370000-0000-4000-8000-0000000000aa'$q$, '42501');
SELECT pg_temp.refused('limit: 401 characters',
  $q$SELECT public.set_directory_booking('07370000-0000-4000-8000-0000000000aa', false, repeat('x', 401))$q$, '22023');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT pg_temp.refused('owner: a visitor, writer',
  $q$SELECT public.set_directory_booking('07370000-0000-4000-8000-0000000000aa', true, NULL)$q$, '42501');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);
DO $$
BEGIN
  IF (SELECT directory_booking_enabled OR booking_policy_text IS NOT NULL FROM public.organizations
       WHERE id = '07370000-0000-4000-8000-0000000000aa') THEN
    RAISE EXCEPTION 'PROOF FAILED [owner]: a refused write changed A';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conname = 'organizations_booking_policy_text_check') <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [limit]: the policy CHECK is missing';
  END IF;
  RAISE NOTICE 'ok: an office manager, another business''s owner and a visitor cannot call the writer; A''s own owner cannot write either column directly; 401 characters is refused; nothing changed';
END $$;

-- ── 4. The switch alone sells nothing ──────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('f7370000-0000-4000-8000-000000000a01');
SELECT public.set_directory_booking('07370000-0000-4000-8000-0000000000aa', true,
  '  Cancel 24 hours ahead for a full refund.  ');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);
DO $$
BEGIN
  IF (SELECT booking_policy_text FROM public.organizations WHERE id = '07370000-0000-4000-8000-0000000000aa')
     IS DISTINCT FROM 'Cancel 24 hours ahead for a full refund.' THEN
    RAISE EXCEPTION 'PROOF FAILED [policy]: not stored trimmed';
  END IF;
  IF (SELECT booking_policy_text FROM public.directory_public_listings WHERE slug = 'booking-proof-a')
     IS DISTINCT FROM 'Cancel 24 hours ahead for a full refund.' THEN
    RAISE EXCEPTION 'PROOF FAILED [policy]: the view does not show the owner''s policy';
  END IF;
  IF pg_temp.a_reads() NOT LIKE 'false|-|%' OR pg_temp.a_reads() ~ '=(recurring|one_time|package)' THEN
    RAISE EXCEPTION 'PROOF FAILED [gates]: switch on, signup and charges off, A reads %', pg_temp.a_reads();
  END IF;
  PERFORM pg_temp.gates('aa', true, false);
  IF pg_temp.a_reads() NOT LIKE 'false|-|%' OR pg_temp.a_reads() ~ '=(recurring|one_time|package)' THEN
    RAISE EXCEPTION 'PROOF FAILED [gates]: switch and signup on, charges off, A reads %', pg_temp.a_reads();
  END IF;
  PERFORM pg_temp.gates('aa', false, true);
  IF pg_temp.a_reads() NOT LIKE 'false|-|%' OR pg_temp.a_reads() ~ '=(recurring|one_time|package)' THEN
    RAISE EXCEPTION 'PROOF FAILED [gates]: switch and charges on, signup off, A reads %', pg_temp.a_reads();
  END IF;
  RAISE NOTICE 'ok: the owner''s policy is stored trimmed and shown; with the switch on but signup or charges off, every service still reads request_only';
END $$;

-- ── 5. All three gates on: each service by its own stored mode ─────────────
SELECT pg_temp.gates('aa', true, true);
DO $$
DECLARE _want text := 'true|/d/booking-proof-a/book|Daily walk=recurring Single walk=one_time Meet and greet=request_only Lesson pack=package+Five lessons/5/27500 Old pack=request_only Yard scoop=recurring';
BEGIN
  IF pg_temp.a_reads() IS DISTINCT FROM _want THEN
    RAISE EXCEPTION 'PROOF FAILED [modes]: A reads %, want %', pg_temp.a_reads(), _want;
  END IF;
  RAISE NOTICE 'ok: with the switch, signup and charges on: recurring and one-visit sell, request-only stays request-only, a package with a package on sale sells (name, sessions, price, no id), a package whose package is off sale is request-only, zone-priced scoop sells; books_online true and book_path names the directory slug';
END $$;

-- The owner turns the switch off again: everything is request_only.
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('f7370000-0000-4000-8000-000000000a01');
SELECT public.set_directory_booking('07370000-0000-4000-8000-0000000000aa', false, '');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);
DO $$
BEGIN
  IF pg_temp.a_reads() NOT LIKE 'false|-|%' OR pg_temp.a_reads() ~ '=(recurring|one_time|package)' THEN
    RAISE EXCEPTION 'PROOF FAILED [switch]: switched off, A reads %', pg_temp.a_reads();
  END IF;
  IF (SELECT booking_policy_text FROM public.directory_public_listings WHERE slug = 'booking-proof-a') IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [policy]: an empty policy is not NULL';
  END IF;
  RAISE NOTICE 'ok: the owner switches it off and every service is request_only again; an empty policy reads NULL';
END $$;
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('f7370000-0000-4000-8000-000000000a01');
SELECT public.set_directory_booking('07370000-0000-4000-8000-0000000000aa', true, 'Cancel 24 hours ahead for a full refund.');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

-- ── 6. What the service itself has to be ───────────────────────────────────
DO $$
BEGIN
  UPDATE public.services SET active = false WHERE id = '57370000-0000-4000-8000-0000000000a1';
  IF pg_temp.a_reads() NOT LIKE '%Daily walk=request_only%' THEN
    RAISE EXCEPTION 'PROOF FAILED [service]: a retired service still sells: %', pg_temp.a_reads();
  END IF;
  UPDATE public.services SET active = true WHERE id = '57370000-0000-4000-8000-0000000000a1';

  UPDATE public.platform_service_lines SET bookable = false WHERE service_line = 'dog_walking';
  IF pg_temp.a_reads() IS DISTINCT FROM
     'true|/d/booking-proof-a/book|Daily walk=request_only Single walk=request_only Meet and greet=request_only Lesson pack=package+Five lessons/5/27500 Old pack=request_only Yard scoop=recurring' THEN
    RAISE EXCEPTION 'PROOF FAILED [service]: a line the platform does not book still sells: %', pg_temp.a_reads();
  END IF;
  UPDATE public.platform_service_lines SET bookable = true WHERE service_line = 'dog_walking';

  UPDATE public.service_packages SET price_cents = 0 WHERE id = '67370000-0000-4000-8000-0000000000f1';
  IF pg_temp.a_reads() NOT LIKE '%Lesson pack=request_only %' THEN
    RAISE EXCEPTION 'PROOF FAILED [service]: a free package sells: %', pg_temp.a_reads();
  END IF;
  UPDATE public.service_packages SET price_cents = 27500 WHERE id = '67370000-0000-4000-8000-0000000000f1';

  UPDATE public.services SET base_price_cents = NULL WHERE id = '57370000-0000-4000-8000-0000000000a2';
  IF pg_temp.a_reads() NOT LIKE '%Single walk=request_only%' THEN
    RAISE EXCEPTION 'PROOF FAILED [service]: an unpriced walk sells: %', pg_temp.a_reads();
  END IF;
  UPDATE public.services SET base_price_cents = 3000 WHERE id = '57370000-0000-4000-8000-0000000000a2';

  UPDATE public.services SET public_booking_mode = 'request_only' WHERE id = '57370000-0000-4000-8000-0000000000a6';
  IF pg_temp.a_reads() NOT LIKE '%Yard scoop=request_only' THEN
    RAISE EXCEPTION 'PROOF FAILED [service]: the owner set request only and it still sells: %', pg_temp.a_reads();
  END IF;
  UPDATE public.services SET public_booking_mode = 'recurring' WHERE id = '57370000-0000-4000-8000-0000000000a6';
  RAISE NOTICE 'ok: a retired service, a line the platform does not book, a free package, an unpriced walk and a service the owner set to request only each read request_only with every gate on';
END $$;

-- ── 7. A visitor, with the publishable key only ────────────────────────────
SET LOCAL ROLE anon;
DO $$
DECLARE _keys text[]; _svc text[]; _pkg text[]; _row text; _slugs text[];
BEGIN
  SELECT array_agg(slug ORDER BY slug) INTO _slugs FROM public.directory_public_listings WHERE slug LIKE 'booking-proof-%';
  IF _slugs IS DISTINCT FROM ARRAY['booking-proof-a', 'booking-proof-b'] THEN
    RAISE EXCEPTION 'PROOF FAILED [published]: a visitor reads %', _slugs;
  END IF;
  SELECT array_agg(DISTINCT k ORDER BY k) INTO _keys FROM (
    SELECT jsonb_object_keys(to_jsonb(t)) k FROM public.directory_public_listings t WHERE slug LIKE 'booking-proof-%') s;
  IF _keys IS DISTINCT FROM ARRAY['areas', 'bio', 'book_path', 'booking_policy_text', 'books_online', 'coverage_cities',
                                  'coverage_zips', 'display_name', 'highlights', 'logo_url', 'published_at',
                                  'service_lines', 'services', 'slug', 'tagline'] THEN
    RAISE EXCEPTION 'PROOF FAILED [shape]: a listing has keys %', _keys;
  END IF;
  SELECT array_agg(DISTINCT k ORDER BY k) INTO _svc FROM (
    SELECT jsonb_object_keys(e) k FROM public.directory_public_listings t, jsonb_array_elements(t.services) e
     WHERE slug LIKE 'booking-proof-%') s;
  IF _svc IS DISTINCT FROM ARRAY['booking_key', 'booking_mode', 'label', 'package', 'price_from_cents', 'price_unit', 'service_line'] THEN
    RAISE EXCEPTION 'PROOF FAILED [shape]: a listed service has keys %', _svc;
  END IF;
  SELECT array_agg(DISTINCT k ORDER BY k) INTO _pkg FROM (
    SELECT jsonb_object_keys(e->'package') k FROM public.directory_public_listings t, jsonb_array_elements(t.services) e
     WHERE slug LIKE 'booking-proof-%' AND jsonb_typeof(e->'package') = 'object') s;
  IF _pkg IS DISTINCT FROM ARRAY['name', 'price_cents', 'sessions_count'] THEN
    RAISE EXCEPTION 'PROOF FAILED [shape]: a package has keys %', _pkg;
  END IF;
  IF EXISTS (SELECT 1 FROM public.directory_public_listings t, jsonb_array_elements(t.services) e
              WHERE slug LIKE 'booking-proof-%' AND (e->>'booking_key') !~ '^[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'PROOF FAILED [shape]: a booking_key is not 12 hex characters';
  END IF;
  SELECT string_agg(to_jsonb(t)::text, ' ') INTO _row FROM public.directory_public_listings t WHERE slug LIKE 'booking-proof-%';
  IF _row ~* '07370000-|57370000-|67370000-|f7370000-|booking\.proof\.invalid|Leak Avenue|cus_bookingproof|acct_bookingproof|\+1313555030|booking-proof-portal' THEN
    RAISE EXCEPTION 'PROOF FAILED [leak]: a listing carries an id, contact, address, Stripe id or the booking slug';
  END IF;
  RAISE NOTICE 'ok: a visitor reads only the published listings of live businesses (not U, not D), with exactly fifteen columns, seven keys per service, three per package, an opaque booking key, and no org, service or package id, contact, address, Stripe id or booking slug';
END $$;
SELECT pg_temp.refused('anon: organizations rows',
  $q$DO $d$ BEGIN IF (SELECT count(*) FROM public.organizations WHERE id = '07370000-0000-4000-8000-0000000000aa') = 0 THEN RAISE EXCEPTION USING ERRCODE = '42501'; END IF; END $d$$q$, '42501');
SELECT pg_temp.refused('anon: directory_profiles', $q$SELECT 1 FROM public.directory_profiles LIMIT 1$q$, '42501');
SELECT pg_temp.refused('anon: directory_profile_services', $q$SELECT 1 FROM public.directory_profile_services LIMIT 1$q$, '42501');
SELECT pg_temp.refused('anon: services', $q$SELECT 1 FROM public.services LIMIT 1$q$, '42501');
SELECT pg_temp.refused('anon: service_packages', $q$SELECT 1 FROM public.service_packages LIMIT 1$q$, '42501');
SELECT pg_temp.refused('anon: the hand-off lookup', $q$SELECT * FROM public.directory_booking_handoff('booking-proof-a', 'x')$q$, '42501');
RESET ROLE;
DO $$ BEGIN RAISE NOTICE 'ok: a visitor reads no organizations row and cannot read directory_profiles, directory_profile_services, services or service_packages, or call the hand-off lookup'; END $$;

-- ── 8. The hand-off lookup agrees with the view ────────────────────────────
DO $$
DECLARE _k1 text; _k3 text; _r record; _n int;
BEGIN
  SELECT e->>'booking_key' INTO _k1 FROM public.directory_public_listings t, jsonb_array_elements(t.services) e
   WHERE slug = 'booking-proof-a' AND e->>'label' = 'Daily walk';
  SELECT e->>'booking_key' INTO _k3 FROM public.directory_public_listings t, jsonb_array_elements(t.services) e
   WHERE slug = 'booking-proof-a' AND e->>'label' = 'Meet and greet';
  SELECT * INTO _r FROM public.directory_booking_handoff('booking-proof-a', _k1);
  IF _r.signup_slug IS DISTINCT FROM 'booking-proof-portal-aa' OR _r.service_id IS DISTINCT FROM '57370000-0000-4000-8000-0000000000a1'
     OR _r.booking_mode IS DISTINCT FROM 'recurring' OR NOT _r.books_online THEN
    RAISE EXCEPTION 'PROOF FAILED [handoff]: a1 reads %', row_to_json(_r);
  END IF;
  SELECT * INTO _r FROM public.directory_booking_handoff(' BOOKING-PROOF-A ', _k3);
  IF _r.service_id IS DISTINCT FROM '57370000-0000-4000-8000-0000000000a3' OR _r.booking_mode IS DISTINCT FROM 'request_only' THEN
    RAISE EXCEPTION 'PROOF FAILED [handoff]: a3 reads %', row_to_json(_r);
  END IF;
  SELECT * INTO _r FROM public.directory_booking_handoff('booking-proof-a', 'not-a-key');
  IF _r.service_id IS NOT NULL OR _r.booking_mode IS DISTINCT FROM 'request_only' THEN
    RAISE EXCEPTION 'PROOF FAILED [handoff]: an unknown key reads %', row_to_json(_r);
  END IF;
  SELECT * INTO _r FROM public.directory_booking_handoff('booking-proof-b', _k1);
  IF _r.service_id IS NOT NULL OR _r.booking_mode IS DISTINCT FROM 'request_only' THEN
    RAISE EXCEPTION 'PROOF FAILED [handoff]: A''s key on B''s listing reads %', row_to_json(_r);
  END IF;
  SELECT count(*) INTO _n FROM (
    SELECT * FROM public.directory_booking_handoff('booking-proof-u', NULL)
    UNION ALL SELECT * FROM public.directory_booking_handoff('booking-proof-d', NULL)
    UNION ALL SELECT * FROM public.directory_booking_handoff('no-such-listing', NULL)) s;
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [handoff]: an unpublished, deleted or unknown listing answered (% rows)', _n;
  END IF;
  -- Switched off, the same key is request_only.
  PERFORM set_config('app.directory_booking_writer', '1', true);
  UPDATE public.organizations SET directory_booking_enabled = false WHERE id = '07370000-0000-4000-8000-0000000000aa';
  SELECT * INTO _r FROM public.directory_booking_handoff('booking-proof-a', _k1);
  IF _r.booking_mode IS DISTINCT FROM 'request_only' OR _r.books_online THEN
    RAISE EXCEPTION 'PROOF FAILED [handoff]: switched off, a1 reads %', row_to_json(_r);
  END IF;
  UPDATE public.organizations SET directory_booking_enabled = true WHERE id = '07370000-0000-4000-8000-0000000000aa';
  PERFORM set_config('app.directory_booking_writer', '', true);
  RAISE NOTICE 'ok: the hand-off lookup turns A''s directory slug and a booking key into A''s own booking slug, that service''s id and the view''s mode; a key from another listing or none names no service; an unpublished, deleted or unknown listing answers nothing; switched off it reads request_only';
END $$;

-- ── 9. Mutations: the proof sees each rule go ──────────────────────────────
-- Built from the live definition with one fragment replaced, so the mutant
-- is this file's view minus exactly one rule. DROP and CREATE because
-- REPLACE keeps the old column list. Rolled back with everything else.
CREATE FUNCTION pg_temp.mutate(_from text, _to text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE _def text := pg_get_viewdef('public.directory_public_listings'::regclass);
BEGIN
  IF strpos(_def, _from) = 0 THEN
    RAISE EXCEPTION 'PROOF INCONCLUSIVE [mutation]: "%" is not in the view', _from;
  END IF;
  DROP FUNCTION public.directory_booking_handoff(text, text);
  DROP VIEW public.directory_public_listings;
  EXECUTE 'CREATE VIEW public.directory_public_listings WITH (security_barrier = true) AS ' || replace(_def, _from, _to);
END $$;

SAVEPOINT before_mutation;
SET LOCAL app.directory_booking_writer = '1';
UPDATE public.organizations SET directory_booking_enabled = false WHERE id = '07370000-0000-4000-8000-0000000000aa';
SET LOCAL app.directory_booking_writer = '';
SELECT pg_temp.mutate('NOT (o.directory_booking_enabled AND ', 'NOT (');
DO $$
BEGIN
  IF pg_temp.a_reads() NOT LIKE '%Daily walk=recurring%' THEN
    RAISE EXCEPTION 'PROOF INCONCLUSIVE [mutation: switch]: without the switch in the view, a1 still reads %', pg_temp.a_reads();
  END IF;
  RAISE NOTICE 'ok: mutation reproduces: without the directory switch in the view, a switched-off business sells its recurring walk';
END $$;
ROLLBACK TO SAVEPOINT before_mutation;

SAVEPOINT before_mutation;
SELECT pg_temp.mutate(' AND pk.active', '');
DO $$
BEGIN
  IF pg_temp.a_reads() NOT LIKE '%Old pack=package+Retired pack/10/20000%' THEN
    RAISE EXCEPTION 'PROOF INCONCLUSIVE [mutation: package]: without pk.active, a5 still reads %', pg_temp.a_reads();
  END IF;
  RAISE NOTICE 'ok: mutation reproduces: without "the package is on sale", a package mode with a retired package sells';
END $$;
ROLLBACK TO SAVEPOINT before_mutation;

DO $$
BEGIN
  IF pg_temp.a_reads() NOT LIKE 'true|/d/booking-proof-a/book|Daily walk=recurring %' THEN
    RAISE EXCEPTION 'PROOF FAILED [restore]: after the mutations A reads %', pg_temp.a_reads();
  END IF;
  RAISE NOTICE 'ALL DIRECTORY BOOKING PROOFS PASSED';
END $$;

ROLLBACK;
