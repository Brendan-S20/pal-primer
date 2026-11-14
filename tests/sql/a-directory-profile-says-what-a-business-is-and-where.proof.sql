-- A directory profile says what a business is, and where (#630; mypets v2
-- step 5a), proved against a real Postgres. Run by
-- tests/a-directory-profile-says-what-a-business-is-and-where.test.ts with
-- :migration, and by CI's database job through
-- supabase/proofs/20261112090000-a-directory-profile-says-what-a-business-is-and-where.sql
-- with no :migration (the database was just built from every migration).
-- One transaction, ROLLED BACK at the end. Each check prints "ok: ..." or
-- raises "PROOF FAILED [...]".
--
-- Four businesses:
--   A  publishes, with a tagline, highlights and three areas;
--   B  another business whose owner must not touch A;
--   U  opted in, with areas, but unpublished;
--   D  published with areas, then deleted.
-- Every business carries an owner email, phone, address and Stripe id, so a
-- leak of any of them is a string to look for.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\if :{?migration}
-- A database that already holds a later version of the view (20261112100000
-- adds three columns after these twelve) cannot take this file's CREATE OR
-- REPLACE, which may only add columns. Inside this rolled-back transaction
-- the view is dropped first so the file builds its own; nothing outlives the
-- run, and on a database without the later file this drops what the file is
-- about to recreate anyway.
DROP VIEW IF EXISTS public.directory_public_listings;
\i :migration
\endif

-- ── Fixture ─────────────────────────────────────────────────────────────────
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('f6350000-0000-4000-8000-000000000a01', 'owner-a@area.proof.invalid'),
  ('f6350000-0000-4000-8000-000000000a02', 'office-a@area.proof.invalid'),
  ('f6350000-0000-4000-8000-000000000b01', 'owner-b@area.proof.invalid'),
  ('f6350000-0000-4000-8000-000000000c01', 'owner-u@area.proof.invalid'),
  ('f6350000-0000-4000-8000-000000000d01', 'owner-d@area.proof.invalid');
INSERT INTO public.organizations (id, name, timezone, service_lines, contact_email, contact_phone, contact_address, stripe_customer_id)
SELECT ('06350000-0000-4000-8000-0000000000' || k)::uuid, 'Area Proof ' || k, 'UTC', '{dog_walking}',
       'owner-' || k || '@area.proof.invalid', '+1313555020' || length(k),
       k || ' Leak Avenue, Detroit MI', 'cus_areaproof' || k
  FROM unnest(ARRAY['aa', 'bb', 'cc', 'dd']) k;
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('f6350000-0000-4000-8000-000000000a01', '06350000-0000-4000-8000-0000000000aa', 'owner'),
  ('f6350000-0000-4000-8000-000000000a02', '06350000-0000-4000-8000-0000000000aa', 'office_manager'),
  ('f6350000-0000-4000-8000-000000000b01', '06350000-0000-4000-8000-0000000000bb', 'owner'),
  ('f6350000-0000-4000-8000-000000000c01', '06350000-0000-4000-8000-0000000000cc', 'owner'),
  ('f6350000-0000-4000-8000-000000000d01', '06350000-0000-4000-8000-0000000000dd', 'owner');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.services (id, organization_id, name, service_line, price_unit, base_price_cents, extra_pet_cents, default_duration_min, active)
SELECT ('56350000-0000-4000-8000-0000000000' || k)::uuid, ('06350000-0000-4000-8000-0000000000' || k)::uuid,
       'Area walk ' || k, 'dog_walking', 'visit', 2500, 0, 30, true
  FROM unnest(ARRAY['aa', 'bb', 'cc', 'dd']) k;

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

-- ── 1. The owner writes tagline, highlights and areas in one call ─────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('f6350000-0000-4000-8000-000000000a01');
SELECT public.set_directory_profile('06350000-0000-4000-8000-0000000000aa', 'area-proof-a', 'Area Proof A', 'We walk dogs.', false,
  ARRAY['48201', '48202', '48203', '48204'], ARRAY['Detroit'],
  '[{"service_id":"56350000-0000-4000-8000-0000000000aa","price_from_cents":2200}]'::jsonb, true,
  '  Small-pack   walks, same walker every week  ',
  ARRAY['Insured', ' ', 'Pet first aid', 'INSURED', '  GPS   photo updates '],
  '[{"name":" Downtown ","zips":["48202","48201","48201"]},
    {"name":"Midtown","zips":["48203"]},
    {"name":"North End","zips":["48204","48203"]}]'::jsonb);
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

DO $$
DECLARE _p record; _a text;
BEGIN
  SELECT * INTO _p FROM public.directory_profiles WHERE organization_id = '06350000-0000-4000-8000-0000000000aa';
  IF _p.tagline IS DISTINCT FROM 'Small-pack walks, same walker every week'
     OR _p.highlights IS DISTINCT FROM ARRAY['Insured', 'Pet first aid', 'GPS photo updates']
     OR NOT _p.published THEN
    RAISE EXCEPTION 'PROOF FAILED [write]: A reads tagline %, highlights %, published %', _p.tagline, _p.highlights, _p.published;
  END IF;
  SELECT string_agg(position || ':' || name || '=' || array_to_string(zips, '+'), ' ' ORDER BY position) INTO _a
    FROM public.directory_profile_areas WHERE organization_id = '06350000-0000-4000-8000-0000000000aa';
  IF _a IS DISTINCT FROM '0:Downtown=48201+48202 1:Midtown=48203 2:North End=48203+48204' THEN
    RAISE EXCEPTION 'PROOF FAILED [write]: A''s areas read %', _a;
  END IF;
  RAISE NOTICE 'ok: an owner writes a tagline (trimmed, spaces collapsed), highlights (blanks and a repeat in another case dropped, order kept) and areas (names trimmed, ZIPs sorted and deduplicated, in the order given)';
END $$;

-- The other businesses, as their own owners.
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('f6350000-0000-4000-8000-000000000c01');
SELECT public.set_directory_profile('06350000-0000-4000-8000-0000000000cc', 'area-proof-u', 'Area Proof U', NULL, false,
  ARRAY['48201'], NULL, '[{"service_id":"56350000-0000-4000-8000-0000000000cc"}]'::jsonb, false,
  'Unpublished tagline', ARRAY['Unpublished point'], '[{"name":"Unpublished area","zips":["48201"]}]'::jsonb);
SELECT pg_temp.as_user('f6350000-0000-4000-8000-000000000d01');
SELECT public.set_directory_profile('06350000-0000-4000-8000-0000000000dd', 'area-proof-d', 'Area Proof D', NULL, false,
  ARRAY['48201'], NULL, '[{"service_id":"56350000-0000-4000-8000-0000000000dd"}]'::jsonb, true,
  'Deleted tagline', ARRAY['Deleted point'], '[{"name":"Deleted area","zips":["48201"]}]'::jsonb);
SELECT pg_temp.as_user('f6350000-0000-4000-8000-000000000b01');
SELECT public.set_directory_profile('06350000-0000-4000-8000-0000000000bb', 'area-proof-b', 'Area Proof B', NULL, false,
  ARRAY['48201'], NULL, '[{"service_id":"56350000-0000-4000-8000-0000000000bb"}]'::jsonb, false,
  NULL, NULL, '[]'::jsonb);
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
UPDATE public.organizations SET deleted_at = now() WHERE id = '06350000-0000-4000-8000-0000000000dd';
SET LOCAL app.allow_protected_org_write = '';

-- ── 2. Nobody but A's owner writes A's content ────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('f6350000-0000-4000-8000-000000000a02');
SELECT pg_temp.refused('owner: office manager, 12-arg writer',
  $q$SELECT public.set_directory_profile('06350000-0000-4000-8000-0000000000aa', 'area-proof-a', 'A', NULL, false,
       ARRAY['48201'], NULL, '[]'::jsonb, false, 'x', NULL, NULL)$q$, '42501');
SELECT pg_temp.refused('owner: office manager, area writer',
  $q$SELECT public.set_directory_profile_areas('06350000-0000-4000-8000-0000000000aa', '[]'::jsonb)$q$, '42501');
SELECT pg_temp.refused('owner: office manager, table insert',
  $q$INSERT INTO public.directory_profile_areas (organization_id, name, zips, position)
     VALUES ('06350000-0000-4000-8000-0000000000aa', 'Office', ARRAY['48201'], 5)$q$, '42501');
SELECT pg_temp.refused('door: office manager writes the tagline straight to the table',
  $q$UPDATE public.directory_profiles SET tagline = 'x' WHERE organization_id = '06350000-0000-4000-8000-0000000000aa'$q$, '42501');
DO $$
DECLARE _n int;
BEGIN
  -- Staff read their own areas...
  SELECT count(*) INTO _n FROM public.directory_profile_areas;
  IF _n <> 3 THEN RAISE EXCEPTION 'PROOF FAILED [staff]: A''s office manager reads % areas (want A''s 3)', _n; END IF;
  -- ...and an update or delete by a non-owner matches nothing.
  UPDATE public.directory_profile_areas SET name = 'Hijacked';
  DELETE FROM public.directory_profile_areas;
  SELECT count(*) INTO _n FROM public.directory_profile_areas WHERE name <> 'Hijacked';
  IF _n <> 3 THEN RAISE EXCEPTION 'PROOF FAILED [owner]: an office manager changed or removed an area'; END IF;
END $$;

SELECT pg_temp.as_user('f6350000-0000-4000-8000-000000000b01');
SELECT pg_temp.refused('owner: B''s owner, area writer for A',
  $q$SELECT public.set_directory_profile_areas('06350000-0000-4000-8000-0000000000aa', '[]'::jsonb)$q$, '42501');
SELECT pg_temp.refused('owner: B''s owner, table insert for A',
  $q$INSERT INTO public.directory_profile_areas (organization_id, name, zips, position)
     VALUES ('06350000-0000-4000-8000-0000000000aa', 'Theirs', ARRAY['48201'], 5)$q$, '42501');
INSERT INTO public.directory_profile_areas (organization_id, name, zips, position)
VALUES ('06350000-0000-4000-8000-0000000000bb', 'Mine', ARRAY['48201'], 0);
SELECT pg_temp.refused('owner: B moves its own area onto A',
  $q$UPDATE public.directory_profile_areas SET organization_id = '06350000-0000-4000-8000-0000000000aa'
      WHERE organization_id = '06350000-0000-4000-8000-0000000000bb'$q$, '42501');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);
DO $$ BEGIN RAISE NOTICE 'ok: an office manager and another business''s owner can neither write nor remove A''s areas or tagline by any path; staff read their own'; END $$;

-- ── 3. The limits hold on every path ──────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('f6350000-0000-4000-8000-000000000a01');
-- Through the writer: a message a person can read, as invalid_parameter_value.
SELECT pg_temp.refused('limit: a 91-character tagline',
  format($q$SELECT public.set_directory_profile('06350000-0000-4000-8000-0000000000aa', 'area-proof-a', 'Area Proof A', NULL, false,
       ARRAY['48201'], NULL, '[]'::jsonb, false, %L, NULL, NULL)$q$, repeat('t', 91)), '22023');
SELECT pg_temp.refused('limit: five highlights',
  $q$SELECT public.set_directory_profile('06350000-0000-4000-8000-0000000000aa', 'area-proof-a', 'Area Proof A', NULL, false,
       ARRAY['48201'], NULL, '[]'::jsonb, false, NULL, ARRAY['a', 'b', 'c', 'd', 'e'], NULL)$q$, '22023');
SELECT pg_temp.refused('limit: a 41-character highlight',
  format($q$SELECT public.set_directory_profile('06350000-0000-4000-8000-0000000000aa', 'area-proof-a', 'Area Proof A', NULL, false,
       ARRAY['48201'], NULL, '[]'::jsonb, false, NULL, ARRAY[%L], NULL)$q$, repeat('h', 41)), '22023');
SELECT pg_temp.refused('limit: nine areas',
  format($q$SELECT public.set_directory_profile_areas('06350000-0000-4000-8000-0000000000aa', %L::jsonb)$q$,
         (SELECT jsonb_agg(jsonb_build_object('name', 'Area ' || i, 'zips', jsonb_build_array('48201'))) FROM generate_series(1, 9) i)), '22023');
SELECT pg_temp.refused('limit: a ZIP the profile does not cover',
  $q$SELECT public.set_directory_profile_areas('06350000-0000-4000-8000-0000000000aa', '[{"name":"Far","zips":["48201","90210"]}]'::jsonb)$q$, '22023');
SELECT pg_temp.refused('limit: two areas with one name',
  $q$SELECT public.set_directory_profile_areas('06350000-0000-4000-8000-0000000000aa',
       '[{"name":"Downtown","zips":["48201"]},{"name":"downtown","zips":["48202"]}]'::jsonb)$q$, '22023');
SELECT pg_temp.refused('limit: a 41-character area name',
  format($q$SELECT public.set_directory_profile_areas('06350000-0000-4000-8000-0000000000aa', %L::jsonb)$q$,
         jsonb_build_array(jsonb_build_object('name', repeat('n', 41), 'zips', jsonb_build_array('48201')))), '22023');
SELECT pg_temp.refused('limit: an area with no ZIP',
  $q$SELECT public.set_directory_profile_areas('06350000-0000-4000-8000-0000000000aa', '[{"name":"Empty","zips":[]}]'::jsonb)$q$, '22023');
-- Straight at the table, as the owner RLS lets in: the trigger and the
-- constraints, not the RPC, are what refuse.
SELECT pg_temp.refused('limit: table insert with a ZIP the profile does not cover',
  $q$INSERT INTO public.directory_profile_areas (organization_id, name, zips, position)
     VALUES ('06350000-0000-4000-8000-0000000000aa', 'Far', ARRAY['90210'], 5)$q$, '23514');
SELECT pg_temp.refused('limit: table insert at a ninth position',
  $q$INSERT INTO public.directory_profile_areas (organization_id, name, zips, position)
     VALUES ('06350000-0000-4000-8000-0000000000aa', 'Ninth', ARRAY['48201'], 8)$q$, '23514');
SELECT pg_temp.refused('limit: table insert with a 41-character name',
  format($q$INSERT INTO public.directory_profile_areas (organization_id, name, zips, position)
     VALUES ('06350000-0000-4000-8000-0000000000aa', %L, ARRAY['48201'], 5)$q$, repeat('n', 41)), '23514');
SELECT pg_temp.refused('limit: table insert repeating a name in another case',
  $q$INSERT INTO public.directory_profile_areas (organization_id, name, zips, position)
     VALUES ('06350000-0000-4000-8000-0000000000aa', 'MIDTOWN', ARRAY['48201'], 5)$q$, '23505');
-- An owner may manage the table directly within those limits.
INSERT INTO public.directory_profile_areas (organization_id, name, zips, position)
VALUES ('06350000-0000-4000-8000-0000000000aa', 'Corktown', ARRAY['48201', '48201'], 3);
UPDATE public.directory_profile_areas SET name = 'Corktown West'
 WHERE organization_id = '06350000-0000-4000-8000-0000000000aa' AND name = 'Corktown';
DELETE FROM public.directory_profile_areas
 WHERE organization_id = '06350000-0000-4000-8000-0000000000aa' AND name = 'Corktown West';
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

-- The columns themselves, written past every RPC (as the service role could).
SELECT pg_temp.refused('limit: a 91-character tagline on the table',
  format($q$UPDATE public.directory_profiles SET tagline = %L WHERE organization_id = '06350000-0000-4000-8000-0000000000aa'$q$, repeat('t', 91)), '23514');
SELECT pg_temp.refused('limit: five highlights on the table',
  $q$UPDATE public.directory_profiles SET highlights = ARRAY['a', 'b', 'c', 'd', 'e'] WHERE organization_id = '06350000-0000-4000-8000-0000000000aa'$q$, '23514');
SELECT pg_temp.refused('limit: a 41-character highlight on the table',
  format($q$UPDATE public.directory_profiles SET highlights = ARRAY[%L] WHERE organization_id = '06350000-0000-4000-8000-0000000000aa'$q$, repeat('h', 41)), '23514');

DO $$
DECLARE _a text;
BEGIN
  SELECT string_agg(name, ',' ORDER BY position) INTO _a
    FROM public.directory_profile_areas WHERE organization_id = '06350000-0000-4000-8000-0000000000aa';
  IF _a IS DISTINCT FROM 'Downtown,Midtown,North End' THEN
    RAISE EXCEPTION 'PROOF FAILED [limit]: a refused write changed A''s areas to %', _a;
  END IF;
  RAISE NOTICE 'ok: tagline <= 90, highlights <= 4 x 40, areas <= 8, names <= 40 and unique, ZIPs within the coverage: refused through the writers, straight at the table and on the columns; an owner can still add, rename and remove an area directly';
END $$;

-- ── 4. The coverage shrinks; the areas follow ─────────────────────────────
-- The NINE-argument writer, unchanged, drops 48203 from A's coverage: Midtown
-- (48203 only) goes, North End keeps 48204, and the tagline and highlights
-- the old writer knows nothing about are left alone.
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('f6350000-0000-4000-8000-000000000a01');
SELECT public.set_directory_profile('06350000-0000-4000-8000-0000000000aa', 'area-proof-a', 'Area Proof A', 'We walk dogs.', false,
  ARRAY['48201', '48202', '48204'], ARRAY['Detroit'],
  '[{"service_id":"56350000-0000-4000-8000-0000000000aa","price_from_cents":2200}]'::jsonb, true);
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);
DO $$
DECLARE _a text; _p record;
BEGIN
  SELECT string_agg(name || '=' || array_to_string(zips, '+'), ' ' ORDER BY position) INTO _a
    FROM public.directory_profile_areas WHERE organization_id = '06350000-0000-4000-8000-0000000000aa';
  IF _a IS DISTINCT FROM 'Downtown=48201+48202 North End=48204' THEN
    RAISE EXCEPTION 'PROOF FAILED [coverage]: after 48203 left the coverage A''s areas read %', _a;
  END IF;
  SELECT tagline, highlights INTO _p FROM public.directory_profiles WHERE organization_id = '06350000-0000-4000-8000-0000000000aa';
  IF _p.tagline IS NULL OR cardinality(_p.highlights) <> 3 THEN
    RAISE EXCEPTION 'PROOF FAILED [legacy]: the nine-argument writer cleared the tagline or highlights';
  END IF;
  RAISE NOTICE 'ok: when the coverage loses a ZIP an area keeps only what is still covered and an area left with nothing is removed; the nine-argument writer still works and leaves tagline and highlights alone';
END $$;

-- ── 5. What anon reads ─────────────────────────────────────────────────────
SET LOCAL ROLE anon;
DO $$
DECLARE _r record; _keys text[]; _area_keys text[]; _blob text; _slugs text[];
BEGIN
  SELECT array_agg(slug ORDER BY slug) INTO _slugs FROM public.directory_public_listings WHERE slug LIKE 'area-proof-%';
  IF _slugs IS DISTINCT FROM ARRAY['area-proof-a'] THEN
    RAISE EXCEPTION 'PROOF FAILED [view]: anon lists % (want A only: B and U unpublished, D deleted)', _slugs;
  END IF;
  SELECT * INTO _r FROM public.directory_public_listings WHERE slug = 'area-proof-a';
  IF _r.tagline IS DISTINCT FROM 'Small-pack walks, same walker every week'
     OR _r.highlights IS DISTINCT FROM ARRAY['Insured', 'Pet first aid', 'GPS photo updates']
     OR _r.areas IS DISTINCT FROM '[{"name":"Downtown","zips":["48201","48202"]},{"name":"North End","zips":["48204"]}]'::jsonb THEN
    RAISE EXCEPTION 'PROOF FAILED [view]: A reads tagline %, highlights %, areas %', _r.tagline, _r.highlights, _r.areas;
  END IF;

  SELECT array_agg(k ORDER BY k) INTO _keys FROM (
    -- 20261112100000 adds books_online, booking_policy_text and book_path
    -- after these twelve; its own proof pins those three. This one pins the
    -- twelve, so it holds before and after that file.
    SELECT jsonb_object_keys(to_jsonb(t) - ARRAY['books_online', 'booking_policy_text', 'book_path']) k
      FROM public.directory_public_listings t WHERE slug = 'area-proof-a') s;
  IF _keys IS DISTINCT FROM ARRAY['areas', 'bio', 'coverage_cities', 'coverage_zips', 'display_name', 'highlights',
                                  'logo_url', 'published_at', 'service_lines', 'services', 'slug', 'tagline'] THEN
    RAISE EXCEPTION 'PROOF FAILED [fields]: the view carries %', _keys;
  END IF;
  SELECT array_agg(DISTINCT k ORDER BY k) INTO _area_keys FROM (
    SELECT jsonb_object_keys(e) k FROM public.directory_public_listings t, jsonb_array_elements(t.areas) e
     WHERE t.slug LIKE 'area-proof-%') s;
  IF _area_keys IS DISTINCT FROM ARRAY['name', 'zips'] THEN
    RAISE EXCEPTION 'PROOF FAILED [fields]: an area carries %', _area_keys;
  END IF;

  SELECT string_agg(to_jsonb(v)::text, ' ') INTO _blob FROM public.directory_public_listings v;
  IF _blob ~ '06350000-|56350000-|f6350000-|area\.proof\.invalid|\+1313555020|Leak Avenue|cus_areaproof|Unpublished|Deleted (tagline|point|area)|Midtown|organization_id|confirmed_by' THEN
    RAISE EXCEPTION 'PROOF FAILED [leak]: anon can read a private value: %', _blob;
  END IF;
  RAISE NOTICE 'ok: anon reads A''s tagline, highlights and areas (name and ZIPs only, in order) through the view, nothing of an unpublished or deleted business, and no org id, contact detail or removed area';
END $$;

SELECT pg_temp.refused('door: anon reads directory_profile_areas', $q$SELECT 1 FROM public.directory_profile_areas$q$, '42501');
SELECT pg_temp.refused('door: anon reads directory_profiles', $q$SELECT 1 FROM public.directory_profiles$q$, '42501');
SELECT pg_temp.refused('door: anon inserts an area',
  $q$INSERT INTO public.directory_profile_areas (organization_id, name, zips, position)
     VALUES ('06350000-0000-4000-8000-0000000000aa', 'Anon', ARRAY['48201'], 6)$q$, '42501');
SELECT pg_temp.refused('door: anon calls the area writer',
  $q$SELECT public.set_directory_profile_areas('06350000-0000-4000-8000-0000000000aa', '[]'::jsonb)$q$, '42501');
SELECT pg_temp.refused('door: anon calls the twelve-argument writer',
  $q$SELECT public.set_directory_profile('06350000-0000-4000-8000-0000000000aa', 'area-proof-a', 'A', NULL, false,
       ARRAY['48201'], NULL, '[]'::jsonb, false, 'x', NULL, NULL)$q$, '42501');
SELECT pg_temp.refused('door: anon writes through the view',
  $q$UPDATE public.directory_public_listings SET tagline = 'x'$q$, '55000');
RESET ROLE;
DO $$ BEGIN RAISE NOTICE 'ok: anon cannot read or write directory_profile_areas or directory_profiles, call either writer, or write through the view'; END $$;

-- ── 6. Mutation: without the guard, an owner claims a ZIP it does not cover ─
-- If the insert is STILL refused, the check above was passing for some
-- other reason.
DROP TRIGGER directory_profile_areas_guard ON public.directory_profile_areas;
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('f6350000-0000-4000-8000-000000000a01');
DO $$
BEGIN
  BEGIN
    INSERT INTO public.directory_profile_areas (organization_id, name, zips, position)
    VALUES ('06350000-0000-4000-8000-0000000000aa', 'Far', ARRAY['90210'], 5);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'PROOF INCONCLUSIVE [mutation]: with the guard dropped an uncovered ZIP is still refused (%)', SQLSTATE;
  END;
  RAISE NOTICE 'ok: mutation reproduces: without the guard trigger an owner can store a ZIP the profile does not cover, so the trigger is what stops it';
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

-- ── 7. Mutation: a member-level write policy lets the office manager in ────
DROP POLICY "Owners add directory areas" ON public.directory_profile_areas;
CREATE POLICY "Owners add directory areas" ON public.directory_profile_areas
  FOR INSERT TO authenticated
  WITH CHECK (public.is_org_member((SELECT auth.uid()), organization_id));
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('f6350000-0000-4000-8000-000000000a02');
DO $$
BEGIN
  BEGIN
    INSERT INTO public.directory_profile_areas (organization_id, name, zips, position)
    VALUES ('06350000-0000-4000-8000-0000000000aa', 'Office', ARRAY['48201'], 6);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'PROOF INCONCLUSIVE [mutation]: with a member-level policy the office manager is still refused (%)', SQLSTATE;
  END;
  RAISE NOTICE 'ok: mutation reproduces: with a member-level insert policy the office manager writes an area, so the owner check in the policy is what keeps them out';
END $$;
RESET ROLE;

\echo ALL DIRECTORY CONTENT PROOFS PASSED
ROLLBACK;
