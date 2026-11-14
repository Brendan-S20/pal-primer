-- A directory photo is public only after a moderator approves it (#630;
-- mypets v2 step 5b), proved against a real Postgres. Run by
-- tests/a-directory-photo-waits-for-a-moderator.test.ts with :migration, and
-- by CI's database job through
-- supabase/proofs/20261112110000-a-directory-photo-is-public-only-after-a-moderator-approves-it.sql
-- with no :migration (the database was just built from every migration).
-- One transaction, ROLLED BACK at the end. Each check prints "ok: ..." or
-- raises "PROOF FAILED [...]".
--
-- Five businesses, every one a labelled proof fixture (TEST):
--   E  exists BEFORE the migration runs (when it is applied here);
--   A  published: the business whose photos are moderated;
--   B  published: another business whose owner must not touch A's photos;
--   U  unpublished, with an approved photo;
--   D  published with an approved photo, then deleted.
-- People: A's owner, A's office manager, B's owner, and a HoundStack
-- moderator (platform admin). Every business carries an email, phone and
-- address, so a leak of any of them is a string to look for.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

SELECT set_config('request.jwt.claims', '{}', true);
INSERT INTO public.organizations (id, name, timezone, service_lines)
VALUES ('08820000-0000-4000-8000-0000000000ee', 'Photo Proof ee (TEST)', 'UTC', '{dog_walking}');

\if :{?migration}
\i :migration
\endif

-- ── Fixture ─────────────────────────────────────────────────────────────────
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('f8820000-0000-4000-8000-000000000a01', 'owner-a@photo.proof.invalid'),
  ('f8820000-0000-4000-8000-000000000a02', 'office-a@photo.proof.invalid'),
  ('f8820000-0000-4000-8000-000000000b01', 'owner-b@photo.proof.invalid'),
  ('f8820000-0000-4000-8000-000000000c01', 'owner-u@photo.proof.invalid'),
  ('f8820000-0000-4000-8000-000000000d01', 'owner-d@photo.proof.invalid'),
  ('f8820000-0000-4000-8000-000000000f01', 'moderator@photo.proof.invalid');
INSERT INTO public.organizations (id, name, timezone, service_lines, contact_email, contact_phone, contact_address)
SELECT ('08820000-0000-4000-8000-0000000000' || k)::uuid, 'Photo Proof ' || k || ' (TEST)', 'UTC', '{dog_walking}',
       'owner-' || k || '@photo.proof.invalid', '+1313555088' || length(k), k || ' Leak Avenue, Detroit MI'
  FROM unnest(ARRAY['aa', 'bb', 'cc', 'dd']) k;
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('f8820000-0000-4000-8000-000000000a01', '08820000-0000-4000-8000-0000000000aa', 'owner'),
  ('f8820000-0000-4000-8000-000000000a02', '08820000-0000-4000-8000-0000000000aa', 'office_manager'),
  ('f8820000-0000-4000-8000-000000000b01', '08820000-0000-4000-8000-0000000000bb', 'owner'),
  ('f8820000-0000-4000-8000-000000000c01', '08820000-0000-4000-8000-0000000000cc', 'owner'),
  ('f8820000-0000-4000-8000-000000000d01', '08820000-0000-4000-8000-0000000000dd', 'owner');
SET LOCAL app.allow_protected_org_write = '';
INSERT INTO public.platform_admins (user_id) VALUES ('f8820000-0000-4000-8000-000000000f01');

-- The profiles, written as the table owner (the profile's own rules are
-- 20261110120000's and 20261112090000's proofs; this one is about photos).
INSERT INTO public.directory_profiles (organization_id, slug, published, display_name, coverage_zips, service_lines, published_at)
SELECT ('08820000-0000-4000-8000-0000000000' || k)::uuid, 'photo-proof-' || k, k <> 'cc',
       'Photo Proof ' || k || ' (TEST)', ARRAY['48201'], ARRAY['dog_walking'], now()
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

-- A photo's path in a business's folder: {org}/{8882...n}.jpg
CREATE FUNCTION pg_temp.p(_org text, _n int) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT '08820000-0000-4000-8000-0000000000' || _org || '/a8820000-0000-4000-8000-' || lpad(_n::text, 12, '0') || '.jpg';
$$;
GRANT EXECUTE ON FUNCTION pg_temp.p(text, int) TO authenticated, anon;

-- A's photos as a visitor reads them: "alt@position alt@position ...".
CREATE FUNCTION pg_temp.a_reads() RETURNS text LANGUAGE sql AS $$
  SELECT COALESCE(string_agg((e->>'alt') || '@' || (e->>'position'), ' ' ORDER BY o), '')
    FROM public.directory_public_listings v, jsonb_array_elements(v.photos) WITH ORDINALITY AS u(e, o)
   WHERE v.slug = 'photo-proof-aa';
$$;
GRANT EXECUTE ON FUNCTION pg_temp.a_reads() TO anon, authenticated;

-- A photo's id by its alt, read as the proof (a moderator cannot read the
-- table; it acts by id, as the console does from the queue).
CREATE FUNCTION pg_temp.id_of(_alt text) RETURNS uuid LANGUAGE sql SECURITY DEFINER AS $$
  SELECT id FROM public.directory_profile_photos
   WHERE organization_id = '08820000-0000-4000-8000-0000000000aa' AND alt = _alt;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.id_of(text) TO authenticated, service_role;

-- ── 1. What an upload has to carry ──────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('f8820000-0000-4000-8000-000000000a01');
SELECT pg_temp.refused('attest: no attestation',
  format($q$INSERT INTO public.directory_profile_photos (organization_id, path, alt, position)
            VALUES ('08820000-0000-4000-8000-0000000000aa', %L, 'Gate latched after a visit', 0)$q$, pg_temp.p('aa', 1)), '22023');
SELECT pg_temp.refused('alt: empty',
  format($q$INSERT INTO public.directory_profile_photos (organization_id, path, alt, position, rights_attested_at)
            VALUES ('08820000-0000-4000-8000-0000000000aa', %L, '', 0, now())$q$, pg_temp.p('aa', 1)), '23514');
SELECT pg_temp.refused('alt: 141 characters',
  format($q$INSERT INTO public.directory_profile_photos (organization_id, path, alt, position, rights_attested_at)
            VALUES ('08820000-0000-4000-8000-0000000000aa', %L, repeat('x', 141), 0, now())$q$, pg_temp.p('aa', 1)), '23514');
SELECT pg_temp.refused('path: another business''s folder',
  format($q$INSERT INTO public.directory_profile_photos (organization_id, path, alt, position, rights_attested_at)
            VALUES ('08820000-0000-4000-8000-0000000000aa', %L, 'Yard', 0, now())$q$, pg_temp.p('bb', 1)), '23514');
SELECT pg_temp.refused('owner: A''s owner, into B',
  format($q$INSERT INTO public.directory_profile_photos (organization_id, path, alt, position, rights_attested_at)
            VALUES ('08820000-0000-4000-8000-0000000000bb', %L, 'Yard', 0, now())$q$, pg_temp.p('bb', 1)), '42501');

-- Four photos. The first claims to be approved already, with a backdated
-- attestation: the database stores it pending, attested now.
INSERT INTO public.directory_profile_photos (organization_id, path, alt, position, rights_attested_at, status, moderated_at, moderated_by)
VALUES ('08820000-0000-4000-8000-0000000000aa', pg_temp.p('aa', 1), 'Gate latched after a visit', 0, '2000-01-01',
        'approved', now(), 'f8820000-0000-4000-8000-000000000a01');
INSERT INTO public.directory_profile_photos (organization_id, path, alt, position, rights_attested_at) VALUES
  ('08820000-0000-4000-8000-0000000000aa', pg_temp.p('aa', 2), 'Clean back lawn', 1, now()),
  ('08820000-0000-4000-8000-0000000000aa', pg_temp.p('aa', 3), 'Our van at the curb', 2, now()),
  ('08820000-0000-4000-8000-0000000000aa', pg_temp.p('aa', 4), 'Bagged waste by the bin', 3, now());
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);
DO $$
DECLARE _r text;
BEGIN
  SELECT string_agg(alt || '=' || status || '/' || (moderated_at IS NULL)::text || '/' || (rights_attested_at > now() - interval '1 minute')::text, ' ' ORDER BY position)
    INTO _r FROM public.directory_profile_photos WHERE organization_id = '08820000-0000-4000-8000-0000000000aa';
  IF _r IS DISTINCT FROM 'Gate latched after a visit=pending/true/true Clean back lawn=pending/true/true Our van at the curb=pending/true/true Bagged waste by the bin=pending/true/true' THEN
    RAISE EXCEPTION 'PROOF FAILED [pending]: %', _r;
  END IF;
  IF pg_temp.a_reads() <> '' THEN
    RAISE EXCEPTION 'PROOF FAILED [pending]: a visitor reads %', pg_temp.a_reads();
  END IF;
  RAISE NOTICE 'ok: an upload without the attestation, with no alt, with 141 characters of alt, in another business''s folder or into another business is refused; a new photo is pending and attested now even when the insert claimed approved and backdated it; a visitor reads no pending photo';
END $$;

-- ── 2. Nobody approves their own photo, and nobody else touches A's ─────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('f8820000-0000-4000-8000-000000000a01');
SELECT pg_temp.refused('self-approval: status',
  $q$UPDATE public.directory_profile_photos SET status = 'approved' WHERE organization_id = '08820000-0000-4000-8000-0000000000aa'$q$, '42501');
SELECT pg_temp.refused('self-approval: moderated_at',
  $q$UPDATE public.directory_profile_photos SET moderated_at = now() WHERE organization_id = '08820000-0000-4000-8000-0000000000aa'$q$, '42501');
SELECT pg_temp.refused('self-approval: the moderator''s function',
  format($q$SELECT public.moderate_directory_photo(%L, true)$q$, (SELECT id FROM public.directory_profile_photos WHERE path = pg_temp.p('aa', 1))), '42501');
SELECT pg_temp.refused('self-approval: the queue',
  $q$SELECT * FROM public.directory_photo_queue('pending')$q$, '42501');
SELECT pg_temp.refused('immutable: path',
  $q$UPDATE public.directory_profile_photos SET path = path WHERE organization_id = '08820000-0000-4000-8000-0000000000aa'$q$, '42501');
SELECT pg_temp.as_user('f8820000-0000-4000-8000-000000000a02');
DO $$
BEGIN
  IF (SELECT count(*) FROM public.directory_profile_photos) <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [owner]: A''s office manager reads A''s photos';
  END IF;
END $$;
SELECT pg_temp.refused('owner: A''s office manager, insert',
  format($q$INSERT INTO public.directory_profile_photos (organization_id, path, alt, position, rights_attested_at)
            VALUES ('08820000-0000-4000-8000-0000000000aa', %L, 'Yard', 0, now())$q$, pg_temp.p('aa', 20)), '42501');
SELECT pg_temp.as_user('f8820000-0000-4000-8000-000000000b01');
DO $$
DECLARE _n int;
BEGIN
  IF (SELECT count(*) FROM public.directory_profile_photos) <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [owner]: B''s owner reads A''s photos';
  END IF;
  UPDATE public.directory_profile_photos SET alt = 'B was here' WHERE organization_id = '08820000-0000-4000-8000-0000000000aa';
  GET DIAGNOSTICS _n = ROW_COUNT;
  DELETE FROM public.directory_profile_photos WHERE organization_id = '08820000-0000-4000-8000-0000000000aa';
  IF _n <> 0 OR FOUND THEN
    RAISE EXCEPTION 'PROOF FAILED [owner]: B''s owner changed A''s photos';
  END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE anon;
SELECT pg_temp.refused('anon: moderate', $q$SELECT public.moderate_directory_photo(gen_random_uuid(), true)$q$, '42501');
SELECT pg_temp.refused('anon: queue', $q$SELECT * FROM public.directory_photo_queue('pending')$q$, '42501');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.directory_profile_photos
              WHERE organization_id = '08820000-0000-4000-8000-0000000000aa' AND (status <> 'pending' OR alt = 'B was here')) THEN
    RAISE EXCEPTION 'PROOF FAILED [owner]: a refused write changed A''s photos';
  END IF;
  RAISE NOTICE 'ok: A''s owner cannot set status or moderated_at, call the moderator''s function or read the queue, or move a photo''s file; A''s office manager and B''s owner read none of A''s photos and change none; a visitor can call neither moderator function';
END $$;

-- ── 3. The moderator: three approved, one left pending ──────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('f8820000-0000-4000-8000-000000000f01');
DO $$
DECLARE _r text;
BEGIN
  SELECT string_agg(alt || '@' || business_name || '@' || COALESCE(profile_slug, '-'), ' ' ORDER BY "position") INTO _r
    FROM public.directory_photo_queue('pending') WHERE business_name = 'Photo Proof aa (TEST)';
  IF _r IS DISTINCT FROM 'Gate latched after a visit@Photo Proof aa (TEST)@photo-proof-aa Clean back lawn@Photo Proof aa (TEST)@photo-proof-aa Our van at the curb@Photo Proof aa (TEST)@photo-proof-aa Bagged waste by the bin@Photo Proof aa (TEST)@photo-proof-aa' THEN
    RAISE EXCEPTION 'PROOF FAILED [queue]: the moderator reads %', _r;
  END IF;
END $$;
SELECT public.moderate_directory_photo(pg_temp.id_of('Gate latched after a visit'), true);
SELECT public.moderate_directory_photo(pg_temp.id_of('Clean back lawn'), true);
SELECT public.moderate_directory_photo(pg_temp.id_of('Our van at the curb'), true);
SELECT pg_temp.refused('moderator: no such photo', $q$SELECT public.moderate_directory_photo(gen_random_uuid(), true)$q$, 'P0002');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);
DO $$
DECLARE _r text;
BEGIN
  SELECT string_agg(alt || '=' || status || '/' || COALESCE(moderated_by::text, '-') || '/' || (moderated_at IS NOT NULL)::text, ' ' ORDER BY position)
    INTO _r FROM public.directory_profile_photos WHERE organization_id = '08820000-0000-4000-8000-0000000000aa';
  IF _r IS DISTINCT FROM
     'Gate latched after a visit=approved/f8820000-0000-4000-8000-000000000f01/true Clean back lawn=approved/f8820000-0000-4000-8000-000000000f01/true Our van at the curb=approved/f8820000-0000-4000-8000-000000000f01/true Bagged waste by the bin=pending/-/false' THEN
    RAISE EXCEPTION 'PROOF FAILED [moderated]: %', _r;
  END IF;
  RAISE NOTICE 'ok: the moderator reads the four pending photos with the business''s name and directory slug, approves three, and each decision records who and when; the fourth stays pending';
END $$;

-- ── 4. AC2.1 / AC2.4: a visitor reads exactly the three approved ────────────
-- Approved photos for U (unpublished) and D (published, then deleted).
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO public.directory_profile_photos (organization_id, path, alt, position, rights_attested_at)
SELECT ('08820000-0000-4000-8000-0000000000' || k)::uuid, pg_temp.p(k, 9), 'Photo of ' || k, 0, now()
  FROM unnest(ARRAY['bb', 'cc', 'dd']) k;
SET LOCAL app.directory_photo_moderator = '1';
UPDATE public.directory_profile_photos SET status = 'approved', moderated_at = now(), moderated_by = 'f8820000-0000-4000-8000-000000000f01'
 WHERE organization_id IN ('08820000-0000-4000-8000-0000000000bb', '08820000-0000-4000-8000-0000000000cc', '08820000-0000-4000-8000-0000000000dd');
SET LOCAL app.directory_photo_moderator = '';
UPDATE public.organizations SET deleted_at = now() WHERE id = '08820000-0000-4000-8000-0000000000dd';
SET LOCAL app.allow_protected_org_write = '';

SET LOCAL ROLE anon;
DO $$
DECLARE _keys text[]; _ph text[]; _row text; _slugs text[]; _n int;
BEGIN
  IF pg_temp.a_reads() IS DISTINCT FROM 'Gate latched after a visit@0 Clean back lawn@1 Our van at the curb@2' THEN
    RAISE EXCEPTION 'PROOF FAILED [approved only]: a visitor reads %', pg_temp.a_reads();
  END IF;
  SELECT array_agg(slug ORDER BY slug) INTO _slugs FROM public.directory_public_listings
   WHERE slug LIKE 'photo-proof-%' AND jsonb_array_length(photos) > 0;
  IF _slugs IS DISTINCT FROM ARRAY['photo-proof-aa', 'photo-proof-bb'] THEN
    RAISE EXCEPTION 'PROOF FAILED [published]: a visitor reads photos for %', _slugs;
  END IF;
  SELECT count(*) INTO _n FROM public.directory_public_listings WHERE slug IN ('photo-proof-cc', 'photo-proof-dd');
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [published]: an unpublished or deleted listing is visible';
  END IF;
  SELECT array_agg(DISTINCT k ORDER BY k) INTO _keys FROM (
    SELECT jsonb_object_keys(to_jsonb(t)) k FROM public.directory_public_listings t WHERE slug LIKE 'photo-proof-%') s;
  IF _keys IS DISTINCT FROM ARRAY['areas', 'bio', 'book_path', 'booking_policy_text', 'books_online', 'coverage_cities',
                                  'coverage_zips', 'display_name', 'highlights', 'logo_url', 'photos', 'published_at',
                                  'service_lines', 'services', 'slug', 'tagline'] THEN
    RAISE EXCEPTION 'PROOF FAILED [shape]: a listing has keys %', _keys;
  END IF;
  SELECT array_agg(DISTINCT k ORDER BY k) INTO _ph FROM (
    SELECT jsonb_object_keys(e) k FROM public.directory_public_listings t, jsonb_array_elements(t.photos) e
     WHERE slug LIKE 'photo-proof-%') s;
  IF _ph IS DISTINCT FROM ARRAY['alt', 'position', 'url'] THEN
    RAISE EXCEPTION 'PROOF FAILED [shape]: a photo has keys %', _ph;
  END IF;
  IF EXISTS (SELECT 1 FROM public.directory_public_listings t, jsonb_array_elements(t.photos) e
              WHERE slug LIKE 'photo-proof-%'
                AND ((e->>'url') !~ ('^/d/' || t.slug || '/photos/[0-9a-f]{16}$') OR btrim(e->>'alt') = '')) THEN
    RAISE EXCEPTION 'PROOF FAILED [shape]: a photo url is not /d/{slug}/photos/{16 hex}, or has no alt';
  END IF;
  SELECT string_agg(to_jsonb(t)::text, ' ') INTO _row FROM public.directory_public_listings t WHERE slug LIKE 'photo-proof-%';
  IF _row ~* '08820000-|a8820000-|f8820000-|\.jpg|directory-photos|storage|photo\.proof\.invalid|Leak Avenue|\+1313555088|Bagged waste|Photo by|Pexels|Unsplash|credit|licen[cs]e|photographer' THEN
    RAISE EXCEPTION 'PROOF FAILED [leak]: a listing carries an id, a storage path, a contact, an address, a pending photo or a credit line';
  END IF;
  RAISE NOTICE 'ok: a visitor reads exactly the three approved photos of A, each with its alt, in position order, never the pending one; U (unpublished) and D (deleted) show nothing; sixteen columns, photos[url, alt, position], url a HoundStack path with an opaque key; no org, user or photo id, storage path, bucket, contact, address or credit line';
END $$;
SELECT pg_temp.refused('anon: directory_profile_photos', $q$SELECT 1 FROM public.directory_profile_photos LIMIT 1$q$, '42501');
SELECT pg_temp.refused('anon: directory_profiles', $q$SELECT 1 FROM public.directory_profiles LIMIT 1$q$, '42501');
SELECT pg_temp.refused('anon: the photo lookup', $q$SELECT * FROM public.directory_photo_object('photo-proof-aa', 'x')$q$, '42501');
SELECT pg_temp.refused('anon: insert a photo',
  format($q$INSERT INTO public.directory_profile_photos (organization_id, path, alt, position, rights_attested_at)
            VALUES ('08820000-0000-4000-8000-0000000000aa', %L, 'Yard', 0, now())$q$, pg_temp.p('aa', 21)), '42501');
RESET ROLE;
DO $$ BEGIN RAISE NOTICE 'ok: a visitor cannot read directory_profile_photos or directory_profiles, call the photo lookup, or insert a photo'; END $$;

-- ── 5. The bucket: private, and only the owner (or moderator) reads ─────────
-- Objects stand in for uploads, one per photo of A and one of B.
SELECT set_config('request.jwt.claims', '{}', true);
INSERT INTO storage.objects (bucket_id, name, owner)
SELECT 'directory-photos', path, NULL FROM public.directory_profile_photos
 WHERE organization_id IN ('08820000-0000-4000-8000-0000000000aa', '08820000-0000-4000-8000-0000000000bb');
CREATE FUNCTION pg_temp.objects_seen() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE _n int;
BEGIN
  BEGIN
    SELECT count(*) INTO _n FROM storage.objects WHERE bucket_id = 'directory-photos' AND name LIKE '08820000-%';
  EXCEPTION WHEN insufficient_privilege THEN _n := 0;
  END;
  RETURN _n;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.objects_seen() TO anon, authenticated;
DO $$
BEGIN
  IF (SELECT public FROM storage.buckets WHERE id = 'directory-photos') THEN
    RAISE EXCEPTION 'PROOF FAILED [bucket]: directory-photos is public';
  END IF;
END $$;
SET LOCAL ROLE anon;
DO $$ BEGIN IF pg_temp.objects_seen() <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [bucket]: a visitor reads % objects', pg_temp.objects_seen(); END IF; END $$;
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('f8820000-0000-4000-8000-000000000a01');
DO $$ BEGIN IF pg_temp.objects_seen() <> 4 THEN RAISE EXCEPTION 'PROOF FAILED [bucket]: A''s owner reads % objects, want 4', pg_temp.objects_seen(); END IF; END $$;
SELECT pg_temp.refused('bucket: A''s owner uploads into B''s folder',
  format($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('directory-photos', %L)$q$, pg_temp.p('bb', 30)), '42501');
SELECT pg_temp.as_user('f8820000-0000-4000-8000-000000000a02');
DO $$ BEGIN IF pg_temp.objects_seen() <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [bucket]: A''s office manager reads objects'; END IF; END $$;
SELECT pg_temp.as_user('f8820000-0000-4000-8000-000000000b01');
DO $$ BEGIN IF pg_temp.objects_seen() <> 1 THEN RAISE EXCEPTION 'PROOF FAILED [bucket]: B''s owner reads % objects, want 1', pg_temp.objects_seen(); END IF; END $$;
SELECT pg_temp.as_user('f8820000-0000-4000-8000-000000000f01');
DO $$ BEGIN IF pg_temp.objects_seen() <> 5 THEN RAISE EXCEPTION 'PROOF FAILED [bucket]: the moderator reads % objects, want 5', pg_temp.objects_seen(); END IF; END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);
DO $$ BEGIN RAISE NOTICE 'ok: the bucket is private; a visitor and A''s office manager read none of its objects, A''s owner reads A''s four and B''s owner B''s one, the moderator reads all five; A''s owner cannot upload into B''s folder'; END $$;

-- ── 6. The lookup serves only what the view shows ──────────────────────────
SET LOCAL ROLE service_role;
DO $$
DECLARE _k text; _kp text; _r text; _n int;
BEGIN
  _k := left(md5('directory-photo:' || pg_temp.id_of('Clean back lawn')::text), 16);
  _kp := left(md5('directory-photo:' || pg_temp.id_of('Bagged waste by the bin')::text), 16);
  SELECT path INTO _r FROM public.directory_photo_object('photo-proof-aa', _k);
  IF _r IS DISTINCT FROM pg_temp.p('aa', 2) THEN
    RAISE EXCEPTION 'PROOF FAILED [lookup]: an approved key reads %', _r;
  END IF;
  SELECT path INTO _r FROM public.directory_photo_object(' PHOTO-PROOF-AA ', _k);
  IF _r IS DISTINCT FROM pg_temp.p('aa', 2) THEN
    RAISE EXCEPTION 'PROOF FAILED [lookup]: the slug is not read as the view reads it';
  END IF;
  SELECT count(*) INTO _n FROM (
    SELECT * FROM public.directory_photo_object('photo-proof-aa', _kp)
    UNION ALL SELECT * FROM public.directory_photo_object('photo-proof-bb', _k)
    UNION ALL SELECT * FROM public.directory_photo_object('photo-proof-aa', 'not-a-key')
    UNION ALL SELECT * FROM public.directory_photo_object('photo-proof-cc',
      left(md5('directory-photo:' || (SELECT id FROM public.directory_profile_photos WHERE path = pg_temp.p('cc', 9))::text), 16))
    UNION ALL SELECT * FROM public.directory_photo_object('photo-proof-dd',
      left(md5('directory-photo:' || (SELECT id FROM public.directory_profile_photos WHERE path = pg_temp.p('dd', 9))::text), 16))) s;
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [lookup]: a pending photo, another listing''s key, a junk key, an unpublished or a deleted listing answered (% rows)', _n;
  END IF;
  RAISE NOTICE 'ok: the photo lookup turns an approved photo''s key into its path; a pending photo, A''s key on B''s listing, a junk key, U''s and D''s approved photos answer nothing';
END $$;
RESET ROLE;

-- ── 7. Rejected, edited, reordered ──────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('f8820000-0000-4000-8000-000000000f01');
SELECT public.moderate_directory_photo(pg_temp.id_of('Our van at the curb'), false);
SELECT pg_temp.as_user('f8820000-0000-4000-8000-000000000a01');
UPDATE public.directory_profile_photos SET alt = 'Gate latched and checked' WHERE alt = 'Gate latched after a visit';
UPDATE public.directory_profile_photos SET position = 7 WHERE alt = 'Clean back lawn';
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);
DO $$
DECLARE _r text;
BEGIN
  SELECT string_agg(alt || '=' || status, ' ' ORDER BY alt) INTO _r
    FROM public.directory_profile_photos WHERE organization_id = '08820000-0000-4000-8000-0000000000aa';
  IF _r IS DISTINCT FROM 'Bagged waste by the bin=pending Clean back lawn=approved Gate latched and checked=pending Our van at the curb=rejected' THEN
    RAISE EXCEPTION 'PROOF FAILED [states]: %', _r;
  END IF;
  IF pg_temp.a_reads() IS DISTINCT FROM 'Clean back lawn@7' THEN
    RAISE EXCEPTION 'PROOF FAILED [states]: a visitor reads %', pg_temp.a_reads();
  END IF;
  RAISE NOTICE 'ok: a rejected photo leaves the listing; new alt on an approved photo sends it back to pending and off the listing; a new position alone keeps it approved';
END $$;

-- ── 8. Eight at most, and a rejected photo does not count ───────────────────
-- A has 3 that count (2 pending, 1 approved) and 1 rejected.
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('f8820000-0000-4000-8000-000000000a01');
INSERT INTO public.directory_profile_photos (organization_id, path, alt, position, rights_attested_at)
SELECT '08820000-0000-4000-8000-0000000000aa', pg_temp.p('aa', n), 'Extra ' || n, n, now() FROM generate_series(5, 9) n;
SELECT pg_temp.refused('limit: a ninth',
  format($q$INSERT INTO public.directory_profile_photos (organization_id, path, alt, position, rights_attested_at)
            VALUES ('08820000-0000-4000-8000-0000000000aa', %L, 'Ninth', 10, now())$q$, pg_temp.p('aa', 10)), '23514');
SELECT pg_temp.refused('limit: a rejected photo re-sent for review as the ninth',
  $q$UPDATE public.directory_profile_photos SET alt = 'Our van, new words' WHERE alt = 'Our van at the curb'$q$, '23514');
-- The owner removes the rejected one: still eight, still no room.
DELETE FROM public.directory_profile_photos WHERE alt = 'Our van at the curb';
SELECT pg_temp.refused('limit: still eight after deleting a rejected one',
  format($q$INSERT INTO public.directory_profile_photos (organization_id, path, alt, position, rights_attested_at)
            VALUES ('08820000-0000-4000-8000-0000000000aa', %L, 'Ninth', 10, now())$q$, pg_temp.p('aa', 10)), '23514');
SELECT pg_temp.as_user('f8820000-0000-4000-8000-000000000f01');
SELECT public.moderate_directory_photo(pg_temp.id_of('Extra 9'), false);
SELECT pg_temp.as_user('f8820000-0000-4000-8000-000000000a01');
-- Rejected, so it no longer counts: its replacement goes in.
INSERT INTO public.directory_profile_photos (organization_id, path, alt, position, rights_attested_at)
VALUES ('08820000-0000-4000-8000-0000000000aa', pg_temp.p('aa', 10), 'Replacement', 9, now());
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);
DO $$
DECLARE _counted int; _all int;
BEGIN
  SELECT count(*) FILTER (WHERE status <> 'rejected'), count(*) INTO _counted, _all
    FROM public.directory_profile_photos WHERE organization_id = '08820000-0000-4000-8000-0000000000aa';
  IF _counted <> 8 OR _all <> 9 THEN
    RAISE EXCEPTION 'PROOF FAILED [limit]: % counted, % rows', _counted, _all;
  END IF;
  RAISE NOTICE 'ok: eight pending or approved is the most; a ninth is refused, and so is re-sending a rejected photo as the ninth; once one is rejected its replacement goes in (8 counted, 1 rejected kept)';
END $$;

-- ── 9. Mutations: the proof sees each rule go ───────────────────────────────
CREATE FUNCTION pg_temp.mutate_view(_from text, _to text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE _def text := pg_get_viewdef('public.directory_public_listings'::regclass);
BEGIN
  IF strpos(_def, _from) = 0 THEN
    RAISE EXCEPTION 'PROOF INCONCLUSIVE [mutation]: "%" is not in the view', _from;
  END IF;
  DROP FUNCTION public.directory_booking_handoff(text, text);
  DROP FUNCTION public.directory_photo_object(text, text);
  DROP VIEW public.directory_public_listings;
  EXECUTE 'CREATE VIEW public.directory_public_listings WITH (security_barrier = true) AS ' || replace(_def, _from, _to);
END $$;

SAVEPOINT before_mutation;
SELECT pg_temp.mutate_view('ph.status = ''approved''::text', 'true');
DO $$
BEGIN
  IF pg_temp.a_reads() NOT LIKE '%Bagged waste by the bin%' THEN
    RAISE EXCEPTION 'PROOF INCONCLUSIVE [mutation: approved]: without the status filter A reads %', pg_temp.a_reads();
  END IF;
  RAISE NOTICE 'ok: mutation reproduces: without "approved" in the view, a pending photo is public';
END $$;
ROLLBACK TO SAVEPOINT before_mutation;

SAVEPOINT before_mutation;
DO $$
DECLARE
  _def text := pg_get_functiondef('public.directory_profile_photos_guard()'::regprocedure);
  -- The insert branch's "new is pending, whoever inserts it", all three lines.
  _block text := E'    NEW.status := ''pending'';\n    NEW.moderated_by := NULL;\n    NEW.moderated_at := NULL;\n';
BEGIN
  IF strpos(_def, _block) = 0 THEN
    RAISE EXCEPTION 'PROOF INCONCLUSIVE [mutation]: the guard does not set pending on insert';
  END IF;
  EXECUTE replace(_def, _block, '');
END $$;
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('f8820000-0000-4000-8000-000000000b01');
INSERT INTO public.directory_profile_photos (organization_id, path, alt, position, rights_attested_at, status, moderated_at)
VALUES ('08820000-0000-4000-8000-0000000000bb', pg_temp.p('bb', 11), 'Self approved', 1, now(), 'approved', now());
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.directory_public_listings t, jsonb_array_elements(t.photos) e
                  WHERE t.slug = 'photo-proof-bb' AND e->>'alt' = 'Self approved') THEN
    RAISE EXCEPTION 'PROOF INCONCLUSIVE [mutation: pending]: without pending-on-insert, a self-approved photo still did not show';
  END IF;
  RAISE NOTICE 'ok: mutation reproduces: without pending-on-insert, an owner publishes their own photo';
END $$;
ROLLBACK TO SAVEPOINT before_mutation;

DO $$
BEGIN
  IF pg_temp.a_reads() IS DISTINCT FROM 'Clean back lawn@7' THEN
    RAISE EXCEPTION 'PROOF FAILED [restore]: after the mutations A reads %', pg_temp.a_reads();
  END IF;
  RAISE NOTICE 'ALL DIRECTORY PHOTO PROOFS PASSED';
END $$;

ROLLBACK;
