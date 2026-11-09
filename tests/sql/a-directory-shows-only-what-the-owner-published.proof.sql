-- A directory shows only what the owner published (#630, phase 1), proved
-- against a real Postgres. Run by
-- tests/a-directory-shows-only-what-the-owner-published.test.ts with
-- :migration, and by CI's database job through
-- supabase/proofs/20261110120000-a-directory-shows-only-what-the-owner-published.sql
-- with no :migration (the database was just built from every migration).
-- One transaction, ROLLED BACK at the end. Each check prints "ok: ..." or
-- raises "PROOF FAILED [...]".
--
-- Three businesses. A publishes a profile. B opts in but leaves it
-- unpublished. C published and was then deleted. A also has a client, whose
-- name must never reach a visitor.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\if :{?migration}
\i :migration
\endif

-- ── Fixture ─────────────────────────────────────────────────────────────────
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('f6300000-0000-4000-8000-000000000a01', 'owner-a@dir.proof.invalid'),
  ('f6300000-0000-4000-8000-000000000a02', 'office-a@dir.proof.invalid'),
  ('f6300000-0000-4000-8000-000000000b01', 'owner-b@dir.proof.invalid'),
  ('f6300000-0000-4000-8000-000000000c01', 'owner-c@dir.proof.invalid');
INSERT INTO public.organizations (id, name, timezone, service_lines, logo_url) VALUES
  ('06300000-0000-4000-8000-0000000000aa', 'Dir Proof A', 'UTC', '{pet_waste,dog_walking}', 'https://example.invalid/a.png'),
  ('06300000-0000-4000-8000-0000000000bb', 'Dir Proof B', 'UTC', '{dog_walking}', NULL),
  ('06300000-0000-4000-8000-0000000000cc', 'Dir Proof C', 'UTC', '{dog_walking}', NULL);
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('f6300000-0000-4000-8000-000000000a01', '06300000-0000-4000-8000-0000000000aa', 'owner'),
  ('f6300000-0000-4000-8000-000000000a02', '06300000-0000-4000-8000-0000000000aa', 'office_manager'),
  ('f6300000-0000-4000-8000-000000000b01', '06300000-0000-4000-8000-0000000000bb', 'owner'),
  ('f6300000-0000-4000-8000-000000000c01', '06300000-0000-4000-8000-0000000000cc', 'owner');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.services (id, organization_id, name, service_line, price_unit, base_price_cents, extra_pet_cents, default_duration_min, active) VALUES
  ('56300000-0000-4000-8000-0000000000a1', '06300000-0000-4000-8000-0000000000aa', 'Dir 30-minute walk', 'dog_walking', 'visit', 2500, 0, 30, true),
  ('56300000-0000-4000-8000-0000000000a2', '06300000-0000-4000-8000-0000000000aa', 'Dir hidden walk', 'dog_walking', 'visit', 9900, 0, 30, true),
  ('56300000-0000-4000-8000-0000000000b1', '06300000-0000-4000-8000-0000000000bb', 'Dir B walk', 'dog_walking', 'visit', 1800, 0, 30, true),
  ('56300000-0000-4000-8000-0000000000c1', '06300000-0000-4000-8000-0000000000cc', 'Dir C walk', 'dog_walking', 'visit', 1800, 0, 30, true);

INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('c6300000-0000-4000-8000-0000000000a1', '06300000-0000-4000-8000-0000000000aa', 'residential', 'Dir Proof Secret Client');

CREATE FUNCTION pg_temp.as_user(_uid text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
           json_build_object('sub', _uid, 'role', 'authenticated', 'aal', 'aal2')::text, true);
$$;
GRANT EXECUTE ON FUNCTION pg_temp.as_user(text) TO authenticated;

-- ── 1. Only an owner of the business writes its profile ───────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('f6300000-0000-4000-8000-000000000a02');
DO $$
DECLARE _err text;
BEGIN
  BEGIN
    PERFORM public.set_directory_profile('06300000-0000-4000-8000-0000000000aa', 'dir-proof-a', 'A', NULL, false,
      ARRAY['48201'], NULL, '[]'::jsonb, true);
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [owner]: an office manager wrote the directory profile'; END IF;
END $$;
SELECT pg_temp.as_user('f6300000-0000-4000-8000-000000000b01');
DO $$
DECLARE _err text;
BEGIN
  BEGIN
    PERFORM public.set_directory_profile('06300000-0000-4000-8000-0000000000aa', 'dir-proof-a', 'A', NULL, false,
      ARRAY['48201'], NULL, '[]'::jsonb, true);
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [owner]: another business''s owner wrote A''s profile'; END IF;
  -- B's own, unpublished.
  PERFORM public.set_directory_profile('06300000-0000-4000-8000-0000000000bb', 'dir-proof-b', 'Dir Proof B', 'B bio', false,
    ARRAY['48201'], ARRAY['Detroit'], '[{"service_id":"56300000-0000-4000-8000-0000000000b1","price_from_cents":1800}]'::jsonb, false);
  -- A table write straight from the API is refused.
  _err := NULL;
  BEGIN
    UPDATE public.directory_profiles SET published = true WHERE organization_id = '06300000-0000-4000-8000-0000000000bb';
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [door]: an owner updated directory_profiles past set_directory_profile'; END IF;
END $$;
SELECT pg_temp.as_user('f6300000-0000-4000-8000-000000000c01');
SELECT public.set_directory_profile('06300000-0000-4000-8000-0000000000cc', 'dir-proof-c', 'Dir Proof C', NULL, false,
  ARRAY['48201'], NULL, '[{"service_id":"56300000-0000-4000-8000-0000000000c1"}]'::jsonb, true);
SELECT pg_temp.as_user('f6300000-0000-4000-8000-000000000a01');
-- A lists its walk at a price-from it confirmed, leaves the second walk out,
-- and names B's service id, which must be ignored.
SELECT public.set_directory_profile('06300000-0000-4000-8000-0000000000aa', 'Dir-Proof-A ', 'Dir Proof A', 'We walk dogs.', true,
  ARRAY['48201', '48202', 'not-a-zip', '48201'], ARRAY['Detroit', ' '],
  '[{"service_id":"56300000-0000-4000-8000-0000000000a1","price_from_cents":2200},
    {"service_id":"56300000-0000-4000-8000-0000000000b1","price_from_cents":1}]'::jsonb, true);
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

SET LOCAL app.allow_protected_org_write = '1';
UPDATE public.organizations SET deleted_at = now() WHERE id = '06300000-0000-4000-8000-0000000000cc';
SET LOCAL app.allow_protected_org_write = '';

DO $$
DECLARE _p record; _n int;
BEGIN
  SELECT * INTO _p FROM public.directory_profiles WHERE organization_id = '06300000-0000-4000-8000-0000000000aa';
  IF _p.slug <> 'dir-proof-a' OR NOT _p.published OR _p.published_at IS NULL
     OR _p.coverage_zips <> ARRAY['48201', '48202'] OR _p.coverage_cities <> ARRAY['Detroit']
     OR _p.service_lines <> ARRAY['dog_walking'] OR _p.confirmed_by <> 'f6300000-0000-4000-8000-000000000a01' THEN
    RAISE EXCEPTION 'PROOF FAILED [write]: A''s profile reads %', row_to_json(_p);
  END IF;
  SELECT count(*) INTO _n FROM public.directory_profile_services WHERE organization_id = '06300000-0000-4000-8000-0000000000aa';
  IF _n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED [write]: A lists % services (want 1: the hidden walk and B''s id left out)', _n; END IF;
  RAISE NOTICE 'ok: only an owner of the business writes its profile, through set_directory_profile only; ZIPs are cleaned, a hidden service is not listed, and another business''s service id is ignored';
END $$;

-- ── 2. What anon reads ─────────────────────────────────────────────────────
SET LOCAL ROLE anon;
DO $$
DECLARE _r record; _n int; _err text; _keys text[];
BEGIN
  SELECT count(*) INTO _n FROM public.directory_search('dog_walking', '48201');
  IF _n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED [search]: anon found % profiles in 48201 (want A only: B is unpublished, C deleted)', _n; END IF;
  SELECT * INTO _r FROM public.directory_search('dog_walking', '48201');
  IF _r.slug <> 'dir-proof-a' OR _r.logo_url IS DISTINCT FROM 'https://example.invalid/a.png'
     OR _r.services->0->>'price_from_cents' <> '2200' OR _r.services->0->>'label' <> 'Dir 30-minute walk' THEN
    RAISE EXCEPTION 'PROOF FAILED [search]: A reads %', row_to_json(_r);
  END IF;
  SELECT count(*) INTO _n FROM public.directory_search('pet_waste', '48201');
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [search]: A is found for a line it does not list'; END IF;
  SELECT count(*) INTO _n FROM public.directory_search('dog_walking', '90210');
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [search]: A is found outside the ZIPs it confirmed'; END IF;
  SELECT count(*) INTO _n FROM public.directory_search('dog_walking', '4820%');
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [search]: a pattern was taken for a ZIP'; END IF;

  SELECT count(*) INTO _n FROM public.directory_profiles_by_slug(ARRAY['dir-proof-a', 'dir-proof-b', 'dir-proof-c']);
  IF _n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED [slug]: anon read % profiles by slug (want A only)', _n; END IF;

  -- No private column in the shape, and no client anywhere in it.
  SELECT array_agg(k) INTO _keys FROM (
    SELECT jsonb_object_keys(to_jsonb(t)) AS k FROM public.directory_profiles_by_slug(ARRAY['dir-proof-a']) t) s;
  IF _keys && ARRAY['organization_id', 'confirmed_by', 'confirmed_at', 'client_id', 'show_logo', 'published'] THEN
    RAISE EXCEPTION 'PROOF FAILED [columns]: the public shape carries %', _keys;
  END IF;
  IF (SELECT to_jsonb(t)::text FROM public.directory_profiles_by_slug(ARRAY['dir-proof-a']) t) LIKE '%Secret Client%'
     OR (SELECT to_jsonb(t)::text FROM public.directory_profiles_by_slug(ARRAY['dir-proof-a']) t) LIKE '%06300000-0000-4000-8000-0000000000aa%' THEN
    RAISE EXCEPTION 'PROOF FAILED [columns]: the public shape carries a client or the org id';
  END IF;

  -- The tables, and the server-only functions, stay shut.
  BEGIN PERFORM 1 FROM public.directory_profiles; EXCEPTION WHEN insufficient_privilege THEN _err := 'x'; END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [door]: anon reads directory_profiles directly'; END IF;
  _err := NULL;
  BEGIN PERFORM 1 FROM public.directory_profile_services; EXCEPTION WHEN insufficient_privilege THEN _err := 'x'; END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [door]: anon reads directory_profile_services directly'; END IF;
  _err := NULL;
  BEGIN PERFORM public.directory_org_for_quote('dir-proof-a'); EXCEPTION WHEN insufficient_privilege THEN _err := 'x'; END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [door]: anon turns a slug into an org id'; END IF;
  _err := NULL;
  BEGIN PERFORM * FROM public.directory_public_rows(NULL, NULL); EXCEPTION WHEN insufficient_privilege THEN _err := 'x'; END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [door]: anon calls directory_public_rows'; END IF;
  _err := NULL;
  BEGIN
    PERFORM public.set_directory_profile('06300000-0000-4000-8000-0000000000bb', 'dir-proof-b', 'B', NULL, false,
      ARRAY['48201'], NULL, '[]'::jsonb, true);
  EXCEPTION WHEN insufficient_privilege THEN _err := 'x';
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [door]: anon published B'; END IF;
  _err := NULL;
  BEGIN
    INSERT INTO public.directory_profiles (organization_id, slug, display_name, published, coverage_zips, service_lines)
    VALUES ('06300000-0000-4000-8000-0000000000bb', 'dir-proof-x', 'X', true, ARRAY['48201'], ARRAY['dog_walking']);
  EXCEPTION WHEN insufficient_privilege THEN _err := 'x';
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [door]: anon inserted a directory profile'; END IF;
  RAISE NOTICE 'ok: anon finds A by line and confirmed ZIP only, reads B (unpublished) and C (deleted) by neither path, sees no private column, client or org id, and cannot read the tables, resolve an org id or write';
END $$;
RESET ROLE;

-- ── 3. Staff read their own; the quote lookup is the server's ─────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('f6300000-0000-4000-8000-000000000b01');
DO $$
DECLARE _n int;
BEGIN
  SELECT count(*) INTO _n FROM public.directory_profiles;
  IF _n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED [staff]: B''s owner reads % directory profiles (want its own)', _n; END IF;
  RAISE NOTICE 'ok: a business''s staff read their own profile and no other';
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

SET LOCAL ROLE service_role;
DO $$
BEGIN
  IF public.directory_org_for_quote('dir-proof-a') IS DISTINCT FROM '06300000-0000-4000-8000-0000000000aa'::uuid
     OR public.directory_org_for_quote('dir-proof-b') IS NOT NULL
     OR public.directory_org_for_quote('dir-proof-c') IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [quote]: the quote lookup resolves an unpublished or deleted business';
  END IF;
  RAISE NOTICE 'ok: a quote resolves only a published, live business';
END $$;
RESET ROLE;

-- ── 4. Mutation: without the published filter, B leaks ────────────────────
-- Replace the shared reader with one that forgets `p.published`, show that
-- anon can then read B, and put it back. If B does NOT appear, the check
-- above was passing for some other reason.
CREATE OR REPLACE FUNCTION public.directory_public_rows(_only uuid[] DEFAULT NULL, _slugs text[] DEFAULT NULL)
 RETURNS TABLE (slug text, display_name text, logo_url text, bio text, service_lines text[],
                coverage_zips text[], coverage_cities text[], services jsonb, published_at timestamptz)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT p.slug, p.display_name, NULL::text, p.bio, p.service_lines, p.coverage_zips, p.coverage_cities,
         '[]'::jsonb, p.published_at
    FROM public.directory_profiles p
   WHERE (_only IS NULL OR p.organization_id = ANY (_only))
     AND (_slugs IS NULL OR p.slug = ANY (_slugs));
$fn$;
SET LOCAL ROLE anon;
DO $$
DECLARE _n int;
BEGIN
  SELECT count(*) INTO _n FROM public.directory_profiles_by_slug(ARRAY['dir-proof-b']);
  IF _n <> 1 THEN
    RAISE EXCEPTION 'PROOF INCONCLUSIVE [mutation]: with the published filter removed anon still reads % rows for B', _n;
  END IF;
  RAISE NOTICE 'ok: mutation reproduces: without the published filter anon reads B, so the filter is what keeps it out';
END $$;
RESET ROLE;

\echo ALL DIRECTORY PROOFS PASSED
ROLLBACK;
