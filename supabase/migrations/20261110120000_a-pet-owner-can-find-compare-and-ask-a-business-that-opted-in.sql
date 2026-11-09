-- A pet owner can find, compare and ask a business that opted in (#630,
-- phase 1: HoundStack's own directory; not an Angi listing).
--
-- PROPOSED MIGRATION. Not applied to any live database by the change that
-- adds it.
--
-- WHAT THIS ADDS. An owner may publish a profile of their business in a
-- HoundStack directory, off by default. A visitor searches by service and
-- ZIP, compares up to three, and asks one for a quote, which arrives in the
-- business's /leads as source = 'directory' (written by the server through
-- /api/public/leads, behind its honeypot and rate limit; nothing here lets
-- a browser write a lead).
--
-- WHAT A PROFILE IS. Only facts the owner confirmed when they opted in:
--   * the name to show, and whether to show the logo already on the account;
--   * a bio the owner wrote;
--   * the services to list, each with a price-from the owner confirmed (or
--     none, which reads "ask for a quote"); a service left out is hidden;
--   * the ZIPs and city names it covers. Never an address, a phone number or
--     an email: a visitor reaches the business through the quote form only.
-- A snapshot, not a live join: changing a price in Services does not change
-- what the directory says until the owner confirms the profile again.
--
-- WHO READS WHAT.
--   * anon / authenticated, as a visitor: two SECURITY DEFINER functions,
--     directory_search and directory_profiles_by_slug, which return PUBLISHED
--     profiles of businesses that are not deleted, and only the public
--     columns. Neither returns organization_id, confirmed_by, or anything
--     from a client. The tables themselves are shut to anon.
--   * staff of the business: SELECT on their own rows (to show the settings
--     page what is published).
--   * writes: set_directory_profile only, which asks for an OWNER of the
--     business. No client role holds INSERT, UPDATE or DELETE on either
--     table.
--   * directory_org_for_quote (service role only): the server's lookup from a
--     published slug to the business a quote is for.
--
-- REVIEWS ARE PHASE 2 and nothing for them is created here.
--
-- Replays into an empty database: tables, functions, policies and grants,
-- then assertions about what this file creates. No rows are read or written.

-- ── 1. The profile ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.directory_profiles (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  slug text NOT NULL,
  published boolean NOT NULL DEFAULT false,
  display_name text NOT NULL,
  show_logo boolean NOT NULL DEFAULT false,
  bio text,
  service_lines text[] NOT NULL DEFAULT '{}',
  coverage_zips text[] NOT NULL DEFAULT '{}',
  coverage_cities text[] NOT NULL DEFAULT '{}',
  -- Private: who confirmed it, and when. Never returned to a visitor.
  confirmed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT directory_profiles_slug_key UNIQUE (slug),
  CONSTRAINT directory_profiles_slug_check
    CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{1,58}[a-z0-9])$'),
  CONSTRAINT directory_profiles_display_name_check
    CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 120),
  CONSTRAINT directory_profiles_bio_check
    CHECK (bio IS NULL OR char_length(bio) <= 1200),
  CONSTRAINT directory_profiles_zips_check
    CHECK (cardinality(coverage_zips) <= 200
           AND array_to_string(coverage_zips, ',') ~ '^([0-9]{5}(,[0-9]{5})*)?$'),
  CONSTRAINT directory_profiles_cities_check
    CHECK (cardinality(coverage_cities) <= 30),
  CONSTRAINT directory_profiles_lines_check
    CHECK (service_lines <@ ARRAY['pet_waste','dog_walking','pet_sitting','mobile_grooming','training','other']::text[]),
  -- A published profile names at least one place and one service line, or a
  -- search could never find it and a profile page would promise nothing.
  CONSTRAINT directory_profiles_published_complete_check
    CHECK (NOT published OR (cardinality(coverage_zips) > 0 AND cardinality(service_lines) > 0))
);

COMMENT ON TABLE public.directory_profiles IS
  'An owner''s opt-in profile in the HoundStack directory (#630). Off by default. Only facts the owner confirmed: no address, phone or email. Visitors read published rows through directory_search / directory_profiles_by_slug only. Written only by set_directory_profile (owner only).';

CREATE INDEX IF NOT EXISTS directory_profiles_published_zips_idx
  ON public.directory_profiles USING gin (coverage_zips) WHERE published;

ALTER TABLE public.directory_profiles ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.directory_profiles');

DROP POLICY IF EXISTS "Members read their directory profile" ON public.directory_profiles;
CREATE POLICY "Members read their directory profile" ON public.directory_profiles
  FOR SELECT TO authenticated
  USING (public.is_org_member((SELECT auth.uid()), organization_id));

REVOKE ALL ON public.directory_profiles FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.directory_profiles FROM authenticated;
GRANT SELECT ON public.directory_profiles TO authenticated;
GRANT ALL ON public.directory_profiles TO service_role;

-- ── 2. The services it lists, with the price-from the owner confirmed ──────
CREATE TABLE IF NOT EXISTS public.directory_profile_services (
  organization_id uuid NOT NULL REFERENCES public.directory_profiles(organization_id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES public.services(id) ON DELETE CASCADE,
  label text NOT NULL,
  service_line text NOT NULL,
  price_from_cents integer,
  price_unit text,
  position integer NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id, service_id),
  CONSTRAINT directory_profile_services_price_check
    CHECK (price_from_cents IS NULL OR price_from_cents BETWEEN 0 AND 10000000),
  CONSTRAINT directory_profile_services_label_check
    CHECK (char_length(btrim(label)) BETWEEN 1 AND 120)
);

COMMENT ON TABLE public.directory_profile_services IS
  'The services a directory profile lists (#630), each with the price-from the owner confirmed at opt-in (NULL = ask for a quote). A service not listed here is hidden. Written only by set_directory_profile.';

ALTER TABLE public.directory_profile_services ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.directory_profile_services');

DROP POLICY IF EXISTS "Members read their directory services" ON public.directory_profile_services;
CREATE POLICY "Members read their directory services" ON public.directory_profile_services
  FOR SELECT TO authenticated
  USING (public.is_org_member((SELECT auth.uid()), organization_id));

REVOKE ALL ON public.directory_profile_services FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.directory_profile_services FROM authenticated;
GRANT SELECT ON public.directory_profile_services TO authenticated;
GRANT ALL ON public.directory_profile_services TO service_role;

-- ── 3. What a visitor may read ──────────────────────────────────────────────
-- One shape for both readers, so search and profile can never disagree about
-- which columns are public.
CREATE OR REPLACE FUNCTION public.directory_public_rows(_only uuid[] DEFAULT NULL, _slugs text[] DEFAULT NULL)
 RETURNS TABLE (
   slug text,
   display_name text,
   logo_url text,
   bio text,
   service_lines text[],
   coverage_zips text[],
   coverage_cities text[],
   services jsonb,
   published_at timestamptz
 )
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT p.slug,
         p.display_name,
         CASE WHEN p.show_logo THEN o.logo_url END,
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
         ), '[]'::jsonb),
         p.published_at
    FROM public.directory_profiles p
    JOIN public.organizations o ON o.id = p.organization_id
   WHERE p.published
     AND o.deleted_at IS NULL
     AND (_only IS NULL OR p.organization_id = ANY (_only))
     AND (_slugs IS NULL OR p.slug = ANY (_slugs));
$fn$;

-- Internal: it takes organization ids, so a visitor never calls it directly.
REVOKE ALL ON FUNCTION public.directory_public_rows(uuid[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.directory_public_rows(uuid[], text[]) TO service_role;

CREATE OR REPLACE FUNCTION public.directory_search(_service_line text, _zip text)
 RETURNS TABLE (
   slug text,
   display_name text,
   logo_url text,
   bio text,
   service_lines text[],
   coverage_zips text[],
   coverage_cities text[],
   services jsonb,
   published_at timestamptz
 )
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT r.*
    FROM public.directory_public_rows(
           ARRAY(
             SELECT p.organization_id
               FROM public.directory_profiles p
              WHERE p.published
                AND _zip ~ '^[0-9]{5}$'
                AND _zip = ANY (p.coverage_zips)
                AND (_service_line IS NULL OR _service_line = ANY (p.service_lines))
           ),
           NULL
         ) r
   ORDER BY r.display_name, r.slug
   LIMIT 50;
$fn$;

CREATE OR REPLACE FUNCTION public.directory_profiles_by_slug(_slugs text[])
 RETURNS TABLE (
   slug text,
   display_name text,
   logo_url text,
   bio text,
   service_lines text[],
   coverage_zips text[],
   coverage_cities text[],
   services jsonb,
   published_at timestamptz
 )
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
  -- Compare is "up to 3": a longer list is answered with its first three.
  SELECT r.*
    FROM public.directory_public_rows(NULL, (SELECT array_agg(x) FROM (
             SELECT x FROM unnest(COALESCE(_slugs, '{}'::text[])) AS u(x) LIMIT 3) t)) r;
$fn$;

REVOKE ALL ON FUNCTION public.directory_search(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.directory_profiles_by_slug(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.directory_search(text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.directory_profiles_by_slug(text[]) TO anon, authenticated, service_role;

-- The server's lookup for a quote: a PUBLISHED slug of a live business to its
-- id. Service role only, so a visitor cannot turn a slug into an org id.
CREATE OR REPLACE FUNCTION public.directory_org_for_quote(_slug text)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT p.organization_id
    FROM public.directory_profiles p
    JOIN public.organizations o ON o.id = p.organization_id
   WHERE p.slug = _slug AND p.published AND o.deleted_at IS NULL;
$fn$;

REVOKE ALL ON FUNCTION public.directory_org_for_quote(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.directory_org_for_quote(text) TO service_role;

-- ── 4. The owner's opt-in ──────────────────────────────────────────────────
-- _services: [{ "service_id": uuid, "price_from_cents": int|null }, ...] in
-- display order. Only this business's own services are kept; the label, line
-- and unit are read from the service itself, the price-from is the owner's.
CREATE OR REPLACE FUNCTION public.set_directory_profile(
  _org uuid,
  _slug text,
  _display_name text,
  _bio text,
  _show_logo boolean,
  _coverage_zips text[],
  _coverage_cities text[],
  _services jsonb,
  _published boolean
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  _lines text[];
  _was_published boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), _org, 'owner'::public.app_role) THEN
    RAISE EXCEPTION 'Only an owner can change the directory profile' USING ERRCODE = '42501';
  END IF;
  IF _services IS NOT NULL AND jsonb_typeof(_services) <> 'array' THEN
    RAISE EXCEPTION 'services must be a list' USING ERRCODE = '22023';
  END IF;

  SELECT published INTO _was_published FROM public.directory_profiles WHERE organization_id = _org;

  INSERT INTO public.directory_profiles AS d
    (organization_id, slug, published, display_name, show_logo, bio,
     coverage_zips, coverage_cities, confirmed_by, confirmed_at, published_at, updated_at)
  VALUES
    (_org, lower(btrim(_slug)), false, btrim(_display_name), COALESCE(_show_logo, false),
     NULLIF(btrim(COALESCE(_bio, '')), ''),
     COALESCE((SELECT array_agg(DISTINCT z ORDER BY z) FROM unnest(_coverage_zips) z WHERE z ~ '^[0-9]{5}$'), '{}'),
     COALESCE((SELECT array_agg(DISTINCT btrim(c)) FROM unnest(_coverage_cities) c
                WHERE btrim(c) <> '' AND char_length(btrim(c)) <= 80), '{}'),
     auth.uid(), now(), NULL, now())
  ON CONFLICT (organization_id) DO UPDATE SET
     slug = EXCLUDED.slug,
     display_name = EXCLUDED.display_name,
     show_logo = EXCLUDED.show_logo,
     bio = EXCLUDED.bio,
     coverage_zips = EXCLUDED.coverage_zips,
     coverage_cities = EXCLUDED.coverage_cities,
     confirmed_by = EXCLUDED.confirmed_by,
     confirmed_at = EXCLUDED.confirmed_at,
     updated_at = now();

  DELETE FROM public.directory_profile_services WHERE organization_id = _org;
  INSERT INTO public.directory_profile_services
    (organization_id, service_id, label, service_line, price_from_cents, price_unit, position)
  SELECT _org, s.id, s.name, s.service_line,
         CASE WHEN e.item ? 'price_from_cents' AND jsonb_typeof(e.item->'price_from_cents') = 'number'
              THEN (e.item->>'price_from_cents')::numeric::integer END,
         s.price_unit, e.ord::integer
    FROM jsonb_array_elements(COALESCE(_services, '[]'::jsonb)) WITH ORDINALITY AS e(item, ord)
    JOIN public.services s
      ON s.id = CASE WHEN (e.item->>'service_id') ~* '^[0-9a-f-]{36}$' THEN (e.item->>'service_id')::uuid END
     AND s.organization_id = _org
  ON CONFLICT (organization_id, service_id) DO NOTHING;

  -- The lines a profile is found under are the lines of what it lists.
  SELECT COALESCE(array_agg(DISTINCT service_line ORDER BY service_line), '{}')
    INTO _lines
    FROM public.directory_profile_services WHERE organization_id = _org;

  UPDATE public.directory_profiles
     SET service_lines = _lines,
         published = COALESCE(_published, false),
         published_at = CASE
           WHEN COALESCE(_published, false) AND NOT COALESCE(_was_published, false) THEN now()
           WHEN COALESCE(_published, false) THEN published_at
           ELSE NULL END
   WHERE organization_id = _org;
END
$fn$;

REVOKE ALL ON FUNCTION public.set_directory_profile(uuid, text, text, text, boolean, text[], text[], jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_directory_profile(uuid, text, text, text, boolean, text[], text[], jsonb, boolean) TO authenticated, service_role;

-- ── 5. What this file establishes ──────────────────────────────────────────
DO $check$
DECLARE _fn text;
BEGIN
  IF has_table_privilege('anon', 'public.directory_profiles', 'SELECT')
     OR has_table_privilege('anon', 'public.directory_profile_services', 'SELECT') THEN
    RAISE EXCEPTION 'anon can read a directory table directly';
  END IF;
  FOREACH _fn IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
    IF has_table_privilege('anon', 'public.directory_profiles', _fn)
       OR has_table_privilege('authenticated', 'public.directory_profiles', _fn)
       OR has_table_privilege('anon', 'public.directory_profile_services', _fn)
       OR has_table_privilege('authenticated', 'public.directory_profile_services', _fn) THEN
      RAISE EXCEPTION 'a client role holds % on a directory table', _fn;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('anon', 'public.directory_search(text, text)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.directory_profiles_by_slug(text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'a visitor cannot read the directory';
  END IF;
  FOREACH _fn IN ARRAY ARRAY[
    'public.directory_public_rows(uuid[], text[])',
    'public.directory_org_for_quote(text)'
  ] LOOP
    IF has_function_privilege('anon', _fn, 'EXECUTE') OR has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% is callable by a client role', _fn;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.set_directory_profile(uuid, text, text, text, boolean, text[], text[], jsonb, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can write a directory profile';
  END IF;
  IF strpos((SELECT prosrc FROM pg_proc WHERE oid = 'public.set_directory_profile(uuid, text, text, text, boolean, text[], text[], jsonb, boolean)'::regprocedure),
            'public.has_role(auth.uid(), _org, ''owner''::public.app_role)') = 0 THEN
    RAISE EXCEPTION 'set_directory_profile does not ask for an owner';
  END IF;
  -- The public shape names no private column.
  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY['public.directory_search(text, text)'::regprocedure,
                               'public.directory_profiles_by_slug(text[])'::regprocedure]) f(oid)
      JOIN pg_proc p ON p.oid = f.oid
     WHERE p.proargnames && ARRAY['organization_id', 'confirmed_by', 'confirmed_at', 'client_id']::text[]
  ) THEN
    RAISE EXCEPTION 'a public directory function returns a private column';
  END IF;
  IF to_regclass('public.directory_reviews') IS NOT NULL THEN
    RAISE WARNING 'directory_reviews exists; reviews are phase 2 and were not created by this file';
  END IF;
END
$check$;
