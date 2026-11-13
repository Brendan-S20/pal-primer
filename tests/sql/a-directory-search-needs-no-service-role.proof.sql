-- A directory search needs no service role (#630; mypets.services), proved
-- against a real Postgres. Run by
-- tests/a-directory-search-needs-no-service-role.test.ts with :migration, and
-- by CI's database job through
-- supabase/proofs/20261112020000-a-directory-search-needs-no-service-role.sql
-- with no :migration (the database was just built from every migration).
-- One transaction, ROLLED BACK at the end. Each check prints "ok: ..." or
-- raises "PROOF FAILED [...]".
--
-- Eight businesses, all listing dog walking in 48201:
--   aa  no zones                         -> unknown -> listed
--   dd  one zone, listing 90210 only     -> outside -> dropped
--   ee  a zone listing 48201             -> inside  -> listed
--   ff  a 5 km circle on 48201's centre  -> inside  -> listed
--   0f  its only zone is turned off      -> unknown -> listed
--   bb  90210 and a polygon in Chicago   -> outside -> dropped
--   cc  nine circles in Chicago          -> unknown -> listed (past the
--       eight-shape cost bound a verdict is unsure, never outside)
--   00  unpublished                      -> never
--   de  published, business deleted      -> never
-- (The two-character keys are the last byte of each fixture uuid, so they
-- are hex.)
-- Every business carries an owner email, phone, address and Stripe id, and aa
-- has a client, so a leak of any of them is a string to look for.

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

-- 48201's centre, pinned so the circle below is about a known point.
INSERT INTO reference.zip_centroids (zip, lat, lng, radius_m) VALUES ('48201', 42.3471, -83.0603, 1500)
ON CONFLICT (zip) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, radius_m = EXCLUDED.radius_m;

SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO public.organizations (id, name, timezone, service_lines, logo_url,
                                  contact_email, contact_phone, contact_address, stripe_customer_id)
SELECT ('06311000-0000-4000-8000-0000000000' || k)::uuid, 'Anon Dir ' || k, 'UTC', '{dog_walking}',
       'https://example.invalid/' || k || '.png',
       'owner-' || k || '@anon-dir.proof.invalid', '+1313555010' || length(k),
       k || ' Leak Street, Detroit MI', 'cus_anondirproof' || k
  FROM unnest(ARRAY['aa', 'dd', 'ee', 'ff', '0f', 'bb', 'cc', '00', 'de']) k;
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.services (id, organization_id, name, service_line, price_unit, base_price_cents, extra_pet_cents, default_duration_min, active)
SELECT ('56311000-0000-4000-8000-0000000000' || k)::uuid, ('06311000-0000-4000-8000-0000000000' || k)::uuid,
       'Anon walk ' || k, 'dog_walking', 'visit', 2500, 0, 30, true
  FROM unnest(ARRAY['aa', 'dd', 'ee', 'ff', '0f', 'bb', 'cc', '00', 'de']) k;

INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('c6311000-0000-4000-8000-0000000000aa', '06311000-0000-4000-8000-0000000000aa', 'residential', 'Anon Dir Secret Client');

-- Profiles straight into the tables, as the definer would write them: the
-- writer is 20261110120000's proof's subject, not this one's.
INSERT INTO public.directory_profiles (organization_id, slug, published, display_name, show_logo, bio,
                                       service_lines, coverage_zips, coverage_cities,
                                       confirmed_by, confirmed_at, published_at)
SELECT ('06311000-0000-4000-8000-0000000000' || k)::uuid, 'anon-dir-' || k, k <> '00', 'Anon Dir ' || k,
       true, 'Bio ' || k, '{dog_walking}', '{48201}', '{Detroit}',
       NULL, now(), CASE WHEN k <> '00' THEN now() END
  FROM unnest(ARRAY['aa', 'dd', 'ee', 'ff', '0f', 'bb', 'cc', '00', 'de']) k;
INSERT INTO public.directory_profile_services (organization_id, service_id, label, service_line, price_from_cents, price_unit, position)
SELECT ('06311000-0000-4000-8000-0000000000' || k)::uuid, ('56311000-0000-4000-8000-0000000000' || k)::uuid,
       'Anon walk ' || k, 'dog_walking', 2200, 'visit', 0
  FROM unnest(ARRAY['aa', 'dd', 'ee', 'ff', '0f', 'bb', 'cc', '00', 'de']) k;

INSERT INTO public.zones (organization_id, name, zip_codes, geo_match_mode, enabled) VALUES
  ('06311000-0000-4000-8000-0000000000dd', 'Beverly Hills only', ARRAY['90210'], 'zip', true),
  ('06311000-0000-4000-8000-0000000000ee', 'Downtown', ARRAY['48201'], 'zip', true),
  ('06311000-0000-4000-8000-00000000000f', 'Turned off', ARRAY['90210'], 'zip', false),
  ('06311000-0000-4000-8000-0000000000bb', 'Beverly Hills too', ARRAY['90210'], 'zip', true);
INSERT INTO public.zones (organization_id, name, zip_codes, geo_match_mode, center_latitude, center_longitude, radius_meters, enabled) VALUES
  ('06311000-0000-4000-8000-0000000000ff', 'Five km of downtown', '{}', 'radius', 42.3471, -83.0603, 5000, true);
INSERT INTO public.zones (organization_id, name, zip_codes, geo_match_mode, center_latitude, center_longitude, radius_meters, enabled)
SELECT '06311000-0000-4000-8000-0000000000cc', 'Chicago circle ' || i, '{}', 'radius', 41.88, -87.63 + i * 0.01, 2000, true
  FROM generate_series(1, 9) i;
INSERT INTO public.zones (organization_id, name, zip_codes, geo_match_mode, boundary, enabled) VALUES
  ('06311000-0000-4000-8000-0000000000bb', 'The Loop', '{}', 'polygon',
   '{"type":"Polygon","coordinates":[[[-87.64,41.87],[-87.62,41.87],[-87.62,41.89],[-87.64,41.89],[-87.64,41.87]]]}'::jsonb, true);

SET LOCAL app.allow_protected_org_write = '1';
UPDATE public.organizations SET deleted_at = now() WHERE id = '06311000-0000-4000-8000-0000000000de';
SET LOCAL app.allow_protected_org_write = '';

-- ── 1. The verdict, as the server would have read it ──────────────────────
DO $$
DECLARE _got text;
BEGIN
  SELECT string_agg(k || '=' || public.directory_zone_verdict(('06311000-0000-4000-8000-0000000000' || k)::uuid, '48201'), ' ' ORDER BY k)
    INTO _got FROM unnest(ARRAY['aa', 'dd', 'ee', 'ff', '0f', 'bb', 'cc']) k;
  IF _got <> '0f=unknown aa=unknown bb=outside cc=unknown dd=outside ee=inside ff=inside' THEN
    RAISE EXCEPTION 'PROOF FAILED [verdict]: %', _got;
  END IF;
  IF public.directory_zone_verdict('06311000-0000-4000-8000-0000000000dd', '"48201"') <> 'unknown'
     OR public.directory_zone_verdict('06311000-0000-4000-8000-0000000000dd', '4820%') <> 'unknown' THEN
    RAISE EXCEPTION 'PROOF FAILED [verdict]: a quoted or patterned ZIP got a verdict';
  END IF;
  RAISE NOTICE 'ok: the zone verdict reads no zones, a turned-off zone and more drawn zones than it will pay for as unknown, a listed ZIP and a circle as inside, and a ZIP no zone serves as outside';
END $$;

-- ── 2. What anon reads ─────────────────────────────────────────────────────
SET LOCAL ROLE anon;
DO $$
DECLARE
  _slugs text[];
  _keys text[];
  _svc_keys text[];
  _blob text;
  _err text;
  _want_keys constant text[] := ARRAY['bio', 'coverage_cities', 'coverage_zips', 'display_name', 'logo_url',
                                      'published_at', 'service_lines', 'services', 'slug'];
  _want_svc constant text[] := ARRAY['label', 'price_from_cents', 'price_unit', 'service_line'];
BEGIN
  -- The search: "outside" dropped, "unknown" kept, nothing unpublished or deleted.
  SELECT array_agg(slug ORDER BY slug) INTO _slugs
    FROM public.directory_search('dog_walking', '48201') WHERE slug LIKE 'anon-dir-%';
  IF _slugs IS DISTINCT FROM ARRAY['anon-dir-0f', 'anon-dir-aa', 'anon-dir-cc', 'anon-dir-ee', 'anon-dir-ff'] THEN
    RAISE EXCEPTION 'PROOF FAILED [search]: anon found % (want 0f, aa, cc, ee, ff: dd and bb are outside, 00 unpublished, de deleted)', _slugs;
  END IF;
  SELECT array_agg(slug) INTO _slugs FROM public.directory_search('dog_walking', '"48201"');
  IF _slugs IS NOT NULL THEN RAISE EXCEPTION 'PROOF FAILED [search]: a quoted ZIP found %', _slugs; END IF;

  -- The view: every published profile of a live business, no zone filter.
  SELECT array_agg(slug ORDER BY slug) INTO _slugs
    FROM public.directory_public_listings WHERE slug LIKE 'anon-dir-%';
  IF _slugs IS DISTINCT FROM ARRAY['anon-dir-0f', 'anon-dir-aa', 'anon-dir-bb', 'anon-dir-cc', 'anon-dir-dd', 'anon-dir-ee', 'anon-dir-ff'] THEN
    RAISE EXCEPTION 'PROOF FAILED [view]: anon lists % (want every published, live one; never 00 or de)', _slugs;
  END IF;

  -- Exactly the public fields, from all three readers.
  SELECT array_agg(DISTINCT k ORDER BY k) INTO _keys FROM (
    SELECT jsonb_object_keys(to_jsonb(t)) k FROM public.directory_public_listings t WHERE slug LIKE 'anon-dir-%'
    UNION ALL
    SELECT jsonb_object_keys(to_jsonb(t)) FROM public.directory_search('dog_walking', '48201') t
    UNION ALL
    SELECT jsonb_object_keys(to_jsonb(t)) FROM public.directory_profiles_by_slug(ARRAY['anon-dir-aa']) t) s;
  IF _keys IS DISTINCT FROM _want_keys THEN
    RAISE EXCEPTION 'PROOF FAILED [fields]: the public shape carries %', _keys;
  END IF;
  SELECT array_agg(DISTINCT k ORDER BY k) INTO _svc_keys FROM (
    SELECT jsonb_object_keys(e) k
      FROM public.directory_public_listings t, jsonb_array_elements(t.services) e
     WHERE t.slug LIKE 'anon-dir-%') s;
  IF _svc_keys IS DISTINCT FROM _want_svc THEN
    RAISE EXCEPTION 'PROOF FAILED [fields]: a listed service carries %', _svc_keys;
  END IF;

  -- None of the planted private values, anywhere in what anon can read.
  SELECT string_agg(to_jsonb(t)::text, ' ') INTO _blob FROM (
    SELECT to_jsonb(v) FROM public.directory_public_listings v WHERE v.slug LIKE 'anon-dir-%'
    UNION ALL SELECT to_jsonb(s) FROM public.directory_search('dog_walking', '48201') s
    UNION ALL SELECT to_jsonb(b) FROM public.directory_profiles_by_slug(ARRAY['anon-dir-aa', 'anon-dir-00', 'anon-dir-de']) b) t;
  IF _blob ~ '06311000-|56311000-|c6311000-|anon-dir\.proof\.invalid|\+1313555|Leak Street|cus_anondirproof|Secret Client|anon-dir-00|anon-dir-de|confirmed_by|organization_id' THEN
    RAISE EXCEPTION 'PROOF FAILED [leak]: anon can read a private value: %', _blob;
  END IF;

  -- The view and the profile reader agree, row for row.
  IF (SELECT to_jsonb(v) FROM public.directory_public_listings v WHERE v.slug = 'anon-dir-aa')
     IS DISTINCT FROM (SELECT to_jsonb(b) FROM public.directory_profiles_by_slug(ARRAY['anon-dir-aa']) b) THEN
    RAISE EXCEPTION 'PROOF FAILED [shape]: the view and directory_profiles_by_slug disagree about aa';
  END IF;

  -- The base tables and the org-id functions stay shut; the view is read-only.
  BEGIN PERFORM 1 FROM public.directory_profiles; EXCEPTION WHEN insufficient_privilege THEN _err := 'x'; END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [door]: anon reads directory_profiles'; END IF;
  _err := NULL;
  BEGIN PERFORM 1 FROM public.directory_profile_services; EXCEPTION WHEN insufficient_privilege THEN _err := 'x'; END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [door]: anon reads directory_profile_services'; END IF;
  IF to_regclass('public.directory_reviews') IS NOT NULL THEN
    _err := NULL;
    BEGIN EXECUTE 'SELECT 1 FROM public.directory_reviews'; EXCEPTION WHEN insufficient_privilege THEN _err := 'x'; END;
    IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [door]: anon reads directory_reviews'; END IF;
  END IF;
  _err := NULL;
  BEGIN PERFORM public.directory_zone_verdict('06311000-0000-4000-8000-0000000000aa', '48201'); EXCEPTION WHEN insufficient_privilege THEN _err := 'x'; END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [door]: anon calls directory_zone_verdict'; END IF;
  _err := NULL;
  BEGIN PERFORM public.directory_org_for_quote('anon-dir-aa'); EXCEPTION WHEN insufficient_privilege THEN _err := 'x'; END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [door]: anon turns a slug into an org id'; END IF;
  _err := NULL;
  BEGIN PERFORM * FROM public.directory_public_rows(NULL, NULL); EXCEPTION WHEN insufficient_privilege THEN _err := 'x'; END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [door]: anon calls directory_public_rows'; END IF;
  _err := NULL;
  BEGIN DELETE FROM public.directory_public_listings; EXCEPTION WHEN insufficient_privilege OR object_not_in_prerequisite_state OR feature_not_supported THEN _err := 'x'; END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [door]: anon deleted through the view'; END IF;
  _err := NULL;
  BEGIN UPDATE public.directory_public_listings SET bio = 'x'; EXCEPTION WHEN insufficient_privilege OR object_not_in_prerequisite_state OR feature_not_supported THEN _err := 'x'; END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [door]: anon updated through the view'; END IF;

  RAISE NOTICE 'ok: anon searches with the zone filter applied in the database, lists every published live profile through the view, reads exactly the public fields and none of the planted private values, and cannot read the tables, resolve an org id, ask for a verdict or write through the view';
END $$;
RESET ROLE;

-- ── 3. Mutation: without the verdict, dd and bb come back ───────────────────
-- If they do NOT, the search above was dropping them for some other reason.
CREATE OR REPLACE FUNCTION public.directory_zone_verdict(_org uuid, _zip text)
 RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$ SELECT 'unknown'::text $fn$;
SET LOCAL ROLE anon;
DO $$
DECLARE _n int;
BEGIN
  SELECT count(*) INTO _n FROM public.directory_search('dog_walking', '48201')
   WHERE slug IN ('anon-dir-dd', 'anon-dir-bb');
  IF _n <> 2 THEN
    RAISE EXCEPTION 'PROOF INCONCLUSIVE [mutation]: with no zone verdict anon still misses dd or bb (% of 2)', _n;
  END IF;
  RAISE NOTICE 'ok: mutation reproduces: without the zone verdict the outside businesses are listed, so the verdict is what drops them';
END $$;
RESET ROLE;

-- ── 4. Mutation: without the published filter, the view leaks 00 ───────────
CREATE OR REPLACE VIEW public.directory_public_listings WITH (security_barrier = true) AS
  SELECT p.slug, p.display_name, NULL::text AS logo_url, p.bio, p.service_lines, p.coverage_zips,
         p.coverage_cities, '[]'::jsonb AS services, p.published_at
    FROM public.directory_profiles p;
SET LOCAL ROLE anon;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.directory_public_listings WHERE slug = 'anon-dir-00') THEN
    RAISE EXCEPTION 'PROOF INCONCLUSIVE [mutation]: with the published filter removed the view still hides 00';
  END IF;
  RAISE NOTICE 'ok: mutation reproduces: without the published filter the view lists 00, so the filter is what keeps it out';
END $$;
RESET ROLE;

\echo ALL ANON DIRECTORY PROOFS PASSED
ROLLBACK;
