-- A directory profile says what a business is, and where (#630; mypets v2
-- step 5a: directory profile content).
--
-- PROPOSED MIGRATION. File only: not applied to any live database by the
-- change that adds it.
--
-- WHAT THIS ADDS, all of it additive:
--   * directory_profiles.tagline: one line, at most 90 characters, or none.
--   * directory_profiles.highlights: up to four short points (at most 40
--     characters each), in the owner's order. Empty by default.
--   * directory_profile_areas: up to eight named business areas per profile
--     ("Downtown", "North suburbs"), each a name of at most 40 characters and
--     a set of ZIPs that must be ZIPs the profile already COVERS
--     (directory_profiles.coverage_zips). An area is a way of grouping the
--     coverage for a visitor, never a way of claiming more of it.
--   * set_directory_profile(..., _tagline, _highlights, _areas): a twelve-
--     argument writer beside the nine-argument one, which is left exactly as
--     it was. It calls the nine-argument writer (so the owner check, the
--     service snapshot and the publish rules are the same code), then writes
--     the tagline and highlights, then the areas when _areas is given.
--   * set_directory_profile_areas(_org, _areas): replaces the areas in one
--     go, with a message a person can read for each way a list can be wrong.
--   * directory_public_listings gains three columns AT THE END: tagline,
--     highlights, areas ([{name, zips}] in the owner's order). Every existing
--     column keeps its name, type and position.
--
-- WHO WRITES AN AREA. An OWNER of the business, as with the rest of the
-- profile: through either writer above, or straight at the table under RLS
-- (owner-only INSERT, UPDATE and DELETE policies). Either way a trigger
-- checks the ZIPs against the profile's coverage and the constraints cap the
-- count, so no path can write an area the RPC would refuse. Staff of the
-- business read their own areas; nobody else reads the table.
--
-- WHO READS IT PUBLICLY. Only through directory_public_listings, which shows
-- published profiles of live businesses and, for an area, only its name and
-- the ZIPs that are still in the profile's coverage. anon holds no grant on
-- directory_profile_areas, and the view names no organization id.
--
-- WHAT IT DOES NOT CHANGE. directory_search and directory_profiles_by_slug
-- keep their shape (changing a function's return type is a drop, not an
-- addition); the HoundStack /pros pages read those. The base tables stay
-- REVOKE ALL from anon.
--
-- Replays into an empty database: columns, a table, functions, triggers,
-- policies, a view and grants, then assertions about what this file creates.
-- No rows are read or written.

-- ── 1. Tagline and highlights ──────────────────────────────────────────────
ALTER TABLE public.directory_profiles ADD COLUMN IF NOT EXISTS tagline text;
ALTER TABLE public.directory_profiles ADD COLUMN IF NOT EXISTS highlights text[] NOT NULL DEFAULT '{}';

-- A highlight list is one-dimensional, at most four items, each trimmed and
-- 1 to 40 characters. A function because a CHECK cannot hold a subquery.
CREATE OR REPLACE FUNCTION public.directory_highlights_ok(_h text[])
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 PARALLEL SAFE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $fn$
  SELECT _h IS NOT NULL
     AND COALESCE(array_ndims(_h), 1) = 1
     AND cardinality(_h) <= 4
     AND NOT EXISTS (
       SELECT 1 FROM unnest(_h) AS u(x)
        WHERE x IS NULL OR x <> btrim(x) OR char_length(x) NOT BETWEEN 1 AND 40
     );
$fn$;

REVOKE ALL ON FUNCTION public.directory_highlights_ok(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.directory_highlights_ok(text[]) TO authenticated, service_role;

ALTER TABLE public.directory_profiles DROP CONSTRAINT IF EXISTS directory_profiles_tagline_check;
ALTER TABLE public.directory_profiles ADD CONSTRAINT directory_profiles_tagline_check
  CHECK (tagline IS NULL OR (char_length(tagline) BETWEEN 1 AND 90 AND tagline = btrim(tagline)));
ALTER TABLE public.directory_profiles DROP CONSTRAINT IF EXISTS directory_profiles_highlights_check;
ALTER TABLE public.directory_profiles ADD CONSTRAINT directory_profiles_highlights_check
  CHECK (public.directory_highlights_ok(highlights));

COMMENT ON COLUMN public.directory_profiles.tagline IS
  'One line the owner wrote, at most 90 characters (#630, mypets v2 5a). Public on a published profile.';
COMMENT ON COLUMN public.directory_profiles.highlights IS
  'Up to four short points the owner wrote, at most 40 characters each, in order (#630, mypets v2 5a). Public on a published profile.';

-- ── 2. Business areas ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.directory_profile_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.directory_profiles(organization_id) ON DELETE CASCADE,
  name text NOT NULL,
  zips text[] NOT NULL,
  position integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT directory_profile_areas_name_check
    CHECK (char_length(name) BETWEEN 1 AND 40 AND name = btrim(name)),
  CONSTRAINT directory_profile_areas_zips_check
    CHECK (COALESCE(array_ndims(zips), 1) = 1
           AND cardinality(zips) BETWEEN 1 AND 200
           AND array_position(zips, NULL) IS NULL
           AND array_to_string(zips, ',') ~ '^[0-9]{5}(,[0-9]{5})*$'),
  -- Eight per business, structurally: positions 0..7, each used once.
  CONSTRAINT directory_profile_areas_position_check CHECK (position BETWEEN 0 AND 7),
  CONSTRAINT directory_profile_areas_position_key
    UNIQUE (organization_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX IF NOT EXISTS directory_profile_areas_name_key
  ON public.directory_profile_areas (organization_id, lower(name));

COMMENT ON TABLE public.directory_profile_areas IS
  'Up to eight named business areas of a directory profile (#630, mypets v2 5a). Each area''s ZIPs are a subset of the profile''s coverage_zips (checked by trigger; pruned when coverage shrinks). Owners write; staff read their own; anon reads only through directory_public_listings.';

-- An area's ZIPs are ZIPs the profile covers. Sorted and deduplicated here
-- so every writer stores the same thing. SECURITY DEFINER so the check reads
-- the profile whoever is writing; it decides nothing about who may write
-- (RLS does that) and returns only NEW.
CREATE OR REPLACE FUNCTION public.directory_profile_areas_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  _cov text[];
  _outside text[];
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'An area cannot move to another business' USING ERRCODE = '42501';
  END IF;
  NEW.name := btrim(NEW.name);
  NEW.zips := ARRAY(SELECT DISTINCT z FROM unnest(NEW.zips) AS u(z) WHERE z IS NOT NULL ORDER BY z);
  SELECT p.coverage_zips INTO _cov
    FROM public.directory_profiles p
   WHERE p.organization_id = NEW.organization_id
     FOR SHARE;
  _outside := ARRAY(SELECT z FROM unnest(NEW.zips) AS u(z) WHERE NOT (z = ANY (COALESCE(_cov, '{}'::text[]))) ORDER BY z);
  IF cardinality(_outside) > 0 THEN
    RAISE EXCEPTION 'Area "%" uses ZIP codes the profile does not cover: %', NEW.name, array_to_string(_outside, ', ')
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.directory_profile_areas_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS directory_profile_areas_guard ON public.directory_profile_areas;
CREATE TRIGGER directory_profile_areas_guard
  BEFORE INSERT OR UPDATE ON public.directory_profile_areas
  FOR EACH ROW EXECUTE FUNCTION public.directory_profile_areas_guard();

-- When the coverage shrinks, an area keeps only the ZIPs still covered, and
-- an area left with none is removed. Coverage only changes through
-- set_directory_profile (or the service role), so this is the one place that
-- keeps "areas are a subset of coverage" true after the fact.
CREATE OR REPLACE FUNCTION public.directory_profile_areas_follow_coverage()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NEW.coverage_zips IS NOT DISTINCT FROM OLD.coverage_zips THEN
    RETURN NULL;
  END IF;
  DELETE FROM public.directory_profile_areas a
   WHERE a.organization_id = NEW.organization_id
     AND NOT (a.zips && NEW.coverage_zips);
  UPDATE public.directory_profile_areas a
     SET zips = ARRAY(SELECT z FROM unnest(a.zips) AS u(z) WHERE z = ANY (NEW.coverage_zips) ORDER BY z)
   WHERE a.organization_id = NEW.organization_id
     AND NOT (a.zips <@ NEW.coverage_zips);
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.directory_profile_areas_follow_coverage() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS directory_profile_areas_follow_coverage ON public.directory_profiles;
CREATE TRIGGER directory_profile_areas_follow_coverage
  AFTER UPDATE OF coverage_zips ON public.directory_profiles
  FOR EACH ROW EXECUTE FUNCTION public.directory_profile_areas_follow_coverage();

ALTER TABLE public.directory_profile_areas ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.directory_profile_areas');

DROP POLICY IF EXISTS "Members read their directory areas" ON public.directory_profile_areas;
CREATE POLICY "Members read their directory areas" ON public.directory_profile_areas
  FOR SELECT TO authenticated
  USING (public.is_org_member((SELECT auth.uid()), organization_id));

DROP POLICY IF EXISTS "Owners add directory areas" ON public.directory_profile_areas;
CREATE POLICY "Owners add directory areas" ON public.directory_profile_areas
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role((SELECT auth.uid()), organization_id, 'owner'::public.app_role));

DROP POLICY IF EXISTS "Owners change directory areas" ON public.directory_profile_areas;
CREATE POLICY "Owners change directory areas" ON public.directory_profile_areas
  FOR UPDATE TO authenticated
  USING (public.has_role((SELECT auth.uid()), organization_id, 'owner'::public.app_role))
  WITH CHECK (public.has_role((SELECT auth.uid()), organization_id, 'owner'::public.app_role));

DROP POLICY IF EXISTS "Owners remove directory areas" ON public.directory_profile_areas;
CREATE POLICY "Owners remove directory areas" ON public.directory_profile_areas
  FOR DELETE TO authenticated
  USING (public.has_role((SELECT auth.uid()), organization_id, 'owner'::public.app_role));

REVOKE ALL ON public.directory_profile_areas FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.directory_profile_areas TO authenticated;
GRANT ALL ON public.directory_profile_areas TO service_role;

-- ── 3. The writers ─────────────────────────────────────────────────────────
-- _areas: [{ "name": text, "zips": [text, ...] }, ...] in display order.
-- Replaces every area of the business. An empty list removes them all.
CREATE OR REPLACE FUNCTION public.set_directory_profile_areas(_org uuid, _areas jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  _cov text[];
  _e record;
  _name text;
  _zips text[];
  _seen text[] := '{}';
  _outside text[];
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), _org, 'owner'::public.app_role) THEN
    RAISE EXCEPTION 'Only an owner can change the directory profile' USING ERRCODE = '42501';
  END IF;
  IF _areas IS NULL OR jsonb_typeof(_areas) <> 'array' THEN
    RAISE EXCEPTION 'areas must be a list' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(_areas) > 8 THEN
    RAISE EXCEPTION 'A profile has at most 8 areas' USING ERRCODE = '22023';
  END IF;
  SELECT coverage_zips INTO _cov FROM public.directory_profiles WHERE organization_id = _org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Save the directory profile before adding areas' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.directory_profile_areas WHERE organization_id = _org;

  FOR _e IN SELECT item, ord FROM jsonb_array_elements(_areas) WITH ORDINALITY AS e(item, ord) LOOP
    IF jsonb_typeof(_e.item) <> 'object' OR jsonb_typeof(_e.item->'name') <> 'string' THEN
      RAISE EXCEPTION 'Each area needs a name' USING ERRCODE = '22023';
    END IF;
    _name := btrim(regexp_replace(_e.item->>'name', '\s+', ' ', 'g'));
    IF char_length(_name) NOT BETWEEN 1 AND 40 THEN
      RAISE EXCEPTION 'An area name is 1 to 40 characters' USING ERRCODE = '22023';
    END IF;
    IF lower(_name) = ANY (_seen) THEN
      RAISE EXCEPTION 'Two areas are both called "%"', _name USING ERRCODE = '22023';
    END IF;
    _seen := _seen || lower(_name);
    IF jsonb_typeof(_e.item->'zips') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Area "%" needs at least one ZIP code', _name USING ERRCODE = '22023';
    END IF;
    _zips := ARRAY(SELECT DISTINCT btrim(z) FROM jsonb_array_elements_text(_e.item->'zips') AS u(z) ORDER BY 1);
    IF cardinality(_zips) = 0 THEN
      RAISE EXCEPTION 'Area "%" needs at least one ZIP code', _name USING ERRCODE = '22023';
    END IF;
    _outside := ARRAY(SELECT z FROM unnest(_zips) AS u(z) WHERE NOT (z = ANY (_cov)) ORDER BY z);
    IF cardinality(_outside) > 0 THEN
      RAISE EXCEPTION 'Area "%" uses ZIP codes the profile does not cover: %', _name, array_to_string(_outside, ', ')
        USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.directory_profile_areas (organization_id, name, zips, position)
    VALUES (_org, _name, _zips, (_e.ord - 1)::integer);
  END LOOP;
END
$fn$;

REVOKE ALL ON FUNCTION public.set_directory_profile_areas(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_directory_profile_areas(uuid, jsonb) TO authenticated, service_role;

-- The twelve-argument writer. The nine-argument one is unchanged and still
-- callable; this one calls it, so there is one owner check and one snapshot.
-- _areas NULL leaves the areas as they are (minus any ZIPs the new coverage
-- dropped, which the coverage trigger prunes).
CREATE OR REPLACE FUNCTION public.set_directory_profile(
  _org uuid,
  _slug text,
  _display_name text,
  _bio text,
  _show_logo boolean,
  _coverage_zips text[],
  _coverage_cities text[],
  _services jsonb,
  _published boolean,
  _tagline text,
  _highlights text[],
  _areas jsonb
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  _t text;
  _h text[];
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), _org, 'owner'::public.app_role) THEN
    RAISE EXCEPTION 'Only an owner can change the directory profile' USING ERRCODE = '42501';
  END IF;

  _t := NULLIF(btrim(regexp_replace(COALESCE(_tagline, ''), '\s+', ' ', 'g')), '');
  IF char_length(_t) > 90 THEN
    RAISE EXCEPTION 'The tagline is at most 90 characters' USING ERRCODE = '22023';
  END IF;

  -- Trimmed, blanks dropped, a repeat (any case) dropped, order kept.
  SELECT COALESCE(array_agg(h ORDER BY o), '{}') INTO _h FROM (
    SELECT DISTINCT ON (lower(h)) h, o FROM (
      SELECT btrim(regexp_replace(x, '\s+', ' ', 'g')) AS h, o
        FROM unnest(COALESCE(_highlights, '{}'::text[])) WITH ORDINALITY AS u(x, o)
       WHERE x IS NOT NULL) s
     WHERE h <> ''
     ORDER BY lower(h), o) d;
  IF cardinality(_h) > 4 THEN
    RAISE EXCEPTION 'A profile has at most 4 highlights' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(_h) AS u(x) WHERE char_length(x) > 40) THEN
    RAISE EXCEPTION 'A highlight is at most 40 characters' USING ERRCODE = '22023';
  END IF;

  PERFORM public.set_directory_profile(_org, _slug, _display_name, _bio, _show_logo,
                                       _coverage_zips, _coverage_cities, _services, _published);

  UPDATE public.directory_profiles
     SET tagline = _t, highlights = _h, updated_at = now()
   WHERE organization_id = _org;

  IF _areas IS NOT NULL THEN
    PERFORM public.set_directory_profile_areas(_org, _areas);
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION public.set_directory_profile(uuid, text, text, text, boolean, text[], text[], jsonb, boolean, text, text[], jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_directory_profile(uuid, text, text, text, boolean, text[], text[], jsonb, boolean, text, text[], jsonb) TO authenticated, service_role;

-- ── 4. The public view, three columns longer ───────────────────────────────
-- CREATE OR REPLACE VIEW may only ADD columns at the end, so the first nine
-- are copied from 20261112020000 unchanged. An area shows only the ZIPs that
-- are still in the coverage (the trigger already keeps it so; the view does
-- not take that on trust), and an area with none left is not shown.
CREATE OR REPLACE VIEW public.directory_public_listings
  WITH (security_barrier = true)
AS
  SELECT p.slug,
         p.display_name,
         CASE WHEN p.show_logo THEN o.logo_url END AS logo_url,
         p.bio,
         p.service_lines,
         p.coverage_zips,
         p.coverage_cities,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
                    'label', s.label,
                    'service_line', s.service_line,
                    'price_from_cents', s.price_from_cents,
                    'price_unit', s.price_unit)
                  ORDER BY s.position, s.label)
             FROM public.directory_profile_services s
            WHERE s.organization_id = p.organization_id
         ), '[]'::jsonb) AS services,
         p.published_at,
         p.tagline,
         p.highlights,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
                    'name', a.name,
                    'zips', to_jsonb(ARRAY(
                      SELECT z FROM unnest(a.zips) AS u(z)
                       WHERE z = ANY (p.coverage_zips) ORDER BY z)))
                  ORDER BY a.position, a.name)
             FROM public.directory_profile_areas a
            WHERE a.organization_id = p.organization_id
              AND a.zips && p.coverage_zips
         ), '[]'::jsonb) AS areas
    FROM public.directory_profiles p
    JOIN public.organizations o ON o.id = p.organization_id
   WHERE p.published
     AND o.deleted_at IS NULL;

COMMENT ON VIEW public.directory_public_listings IS
  'Every PUBLISHED directory profile of a live business, in the public shape only (slug, display_name, logo_url, bio, service_lines, coverage_zips, coverage_cities, services[label, service_line, price_from_cents, price_unit], published_at, tagline, highlights, areas[name, zips]). Read-only; anon may SELECT this view and not the tables under it (#630, mypets.services).';

REVOKE ALL ON public.directory_public_listings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.directory_public_listings TO anon, authenticated;
GRANT SELECT ON public.directory_public_listings TO service_role;

-- ── 5. What this file establishes ──────────────────────────────────────────
DO $check$
DECLARE _priv text; _cols text[]; _fn text;
BEGIN
  -- The new table is shut to a visitor, and the old ones still are.
  FOREACH _priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
    IF has_table_privilege('anon', 'public.directory_profile_areas', _priv)
       OR has_table_privilege('anon', 'public.directory_profiles', _priv)
       OR has_table_privilege('anon', 'public.directory_profile_services', _priv) THEN
      RAISE EXCEPTION 'anon holds % on a directory table', _priv;
    END IF;
  END LOOP;
  FOREACH _priv IN ARRAY ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
    IF has_table_privilege('authenticated', 'public.directory_profile_areas', _priv) THEN
      RAISE EXCEPTION 'authenticated holds % on directory_profile_areas', _priv;
    END IF;
  END LOOP;
  -- The profile itself is still written only through the RPC.
  FOREACH _priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
    IF has_table_privilege('authenticated', 'public.directory_profiles', _priv) THEN
      RAISE EXCEPTION 'authenticated holds % on directory_profiles', _priv;
    END IF;
  END LOOP;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.directory_profile_areas'::regclass) THEN
    RAISE EXCEPTION 'directory_profile_areas has no row level security';
  END IF;
  -- Every write policy asks for an owner of the row's business.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'directory_profile_areas'
       AND permissive = 'PERMISSIVE' AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
       AND (strpos(COALESCE(qual, '') || COALESCE(with_check, ''), 'has_role(') = 0
            OR strpos(COALESCE(qual, '') || COALESCE(with_check, ''), '''owner''::') = 0)
  ) THEN
    RAISE EXCEPTION 'a write policy on directory_profile_areas does not ask for an owner';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.directory_profile_areas'::regclass AND tgname = 'directory_profile_areas_guard'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.directory_profiles'::regclass AND tgname = 'directory_profile_areas_follow_coverage'
  ) THEN
    RAISE EXCEPTION 'the area triggers are missing';
  END IF;

  -- Writers: owners only, never anon.
  FOREACH _fn IN ARRAY ARRAY[
    'public.set_directory_profile(uuid, text, text, text, boolean, text[], text[], jsonb, boolean, text, text[], jsonb)',
    'public.set_directory_profile_areas(uuid, jsonb)'
  ] LOOP
    IF has_function_privilege('anon', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% is callable by anon', _fn;
    END IF;
    IF strpos((SELECT prosrc FROM pg_proc WHERE oid = _fn::regprocedure),
              'public.has_role(auth.uid(), _org, ''owner''::public.app_role)') = 0 THEN
      RAISE EXCEPTION '% does not ask for an owner', _fn;
    END IF;
  END LOOP;
  FOREACH _fn IN ARRAY ARRAY[
    'public.directory_profile_areas_guard()',
    'public.directory_profile_areas_follow_coverage()'
  ] LOOP
    IF has_function_privilege('anon', _fn, 'EXECUTE') OR has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% is callable by a client role', _fn;
    END IF;
  END LOOP;

  -- The view: the nine columns it had, in place, then the three this adds.
  SELECT array_agg(a.attname::text ORDER BY a.attnum) INTO _cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.directory_public_listings'::regclass
     AND a.attnum > 0 AND NOT a.attisdropped;
  IF _cols IS DISTINCT FROM ARRAY['slug', 'display_name', 'logo_url', 'bio', 'service_lines',
                                  'coverage_zips', 'coverage_cities', 'services', 'published_at',
                                  'tagline', 'highlights', 'areas'] THEN
    RAISE EXCEPTION 'directory_public_listings has columns %', _cols;
  END IF;
  IF NOT has_table_privilege('anon', 'public.directory_public_listings', 'SELECT') THEN
    RAISE EXCEPTION 'a visitor cannot read directory_public_listings';
  END IF;
  FOREACH _priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
    IF has_table_privilege('anon', 'public.directory_public_listings', _priv)
       OR has_table_privilege('authenticated', 'public.directory_public_listings', _priv) THEN
      RAISE EXCEPTION 'a client role holds % on directory_public_listings', _priv;
    END IF;
  END LOOP;

  -- The limits are the database's, not only the form's.
  IF public.directory_highlights_ok(ARRAY['a', 'b', 'c', 'd', 'e'])
     OR public.directory_highlights_ok(ARRAY[repeat('x', 41)])
     OR public.directory_highlights_ok(ARRAY[' padded'])
     OR public.directory_highlights_ok(ARRAY[NULL::text])
     OR NOT public.directory_highlights_ok('{}'::text[])
     OR NOT public.directory_highlights_ok(ARRAY['Pet first aid certified', repeat('x', 40)]) THEN
    RAISE EXCEPTION 'directory_highlights_ok does not hold the 4 x 40 limit';
  END IF;
END
$check$;
