-- A directory search needs no service role (#630; the standalone
-- mypets.services app).
--
-- PROPOSED MIGRATION. File only: not applied to any live database by the
-- change that adds it.
--
-- WHY. Until this file, searchDirectory (src/lib/directory.functions.ts) read
-- directory_search with the publishable key and then, for every profile it
-- found, used the SERVICE ROLE twice: directory_org_for_quote to turn the
-- slug into an organization id, and leadServiceAreas to read that business's
-- zones and drop it when they now say "outside" for the ZIP. A second app
-- (mypets.services, its own repo and Vercel project) is going to search the
-- same directory and must never hold a service-role key. So the zone check
-- moves into the database, behind the same anon RPC every visitor already
-- calls, and the service role leaves the search path entirely.
--
-- WHAT THIS ADDS.
--   * directory_zone_verdict(org, zip): 'inside' | 'outside' | 'unknown', a
--     port of leadServiceArea (src/lib/lead-service-area.ts) for a bare ZIP,
--     reading the same zones and the same reference.zip_centroids the
--     server reads through zip_centroids_in_box. Internal: it takes an org
--     id, so it is service_role only, like directory_public_rows and
--     directory_org_for_quote. Anything it cannot read reads 'unknown'.
--   * directory_search, replaced in place (same signature, same grants, same
--     shape): a profile whose business's CURRENT zones say "outside" for the
--     ZIP is dropped. "unknown" (no zones, an unusable shape, a lookup that
--     failed) stays listed, exactly as searchDirectory did: the owner
--     confirmed the ZIP, and a false "outside" costs more than a missing one.
--   * directory_public_listings: a read-only view of every PUBLISHED profile
--     of a business that is not deleted, in exactly the public shape
--     directory_search and directory_profiles_by_slug return. GRANT SELECT to
--     anon on the VIEW only; the base tables stay REVOKE ALL from anon.
--
-- WHAT IT DOES NOT CHANGE. directory_public_rows and directory_org_for_quote
-- stay service_role only (they take or return org ids). The quote still goes
-- through /api/public/leads on the HoundStack server, behind its honeypot,
-- time check and rate limit; nothing here lets a browser write.
--
-- THE PUBLIC SHAPE, and nothing else:
--   slug, display_name, logo_url, bio, service_lines, coverage_zips,
--   coverage_cities, services (label, service_line, price_from_cents,
--   price_unit), published_at.
-- No organization id, no confirmed_by, no email, phone or address, no client
-- or dog, no Stripe, nothing unpublished. coverage_zips is the owner-confirmed
-- coverage list, not a street address.
--
-- Replays into an empty database: functions, a view, grants, then assertions
-- about what this file creates. No rows are read or written.

-- ── 1. The zone verdict, in the database ───────────────────────────────────
-- A port of leadServiceArea(zip, zones, drawn) with drawn built the way
-- lead-service-area.server.ts builds it, for ONE ZIP:
--
--   1. no ZIP, or no zone that is on               -> unknown
--   2. a zone that is on lists the ZIP, or a postal
--      prefix that starts it                        -> inside
--   3. for each zone with a usable drawn shape (polygon of 3+ points; radius
--      or drive time with a centre), the ZIP's Census centre is classified
--      as zone-zip-fill.ts's classifyZipCentroids does: inside the shape
--      (ray cast / haversine, drive time = minutes * 800 m) -> inside;
--      within its own radius (capped at 8 km) of the edge -> unsure; a
--      search box over 10 degrees, or one holding 5,000+ centres -> unsure
--      unless the ZIP was among the 5,000 nearest and inside;
--   4. any unsure                                   -> unknown, else outside.
--
-- The TypeScript stays: /leads and the quote thank-you still use it, signed
-- in or on the server. This is the visitor's copy, and the proof beside this
-- file checks the two agree on the cases that decide a listing.
CREATE OR REPLACE FUNCTION public.directory_zone_verdict(_org uuid, _zip text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 COST 1000
 SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  -- zone-zip-fill.ts: EDGE_MAX_M, MAX_CANDIDATES; zone-match.ts: DRIVE_M_PER_MIN.
  c_edge_max   constant double precision := 8000;
  c_cap        constant integer := 5000;
  -- Cost bound for a visitor's call (directory_search is anon). A business
  -- with more drawn zones than this reads "unknown" rather than paying for
  -- every one: the safe direction, since "unknown" stays listed.
  c_max_shapes constant integer := 8;
  _shapes integer := 0;
  c_drive_m    constant double precision := 800;
  c_r          constant double precision := 6371000;
  c_m_per_lat  constant double precision := 6371000 * pi() / 180;
  z record;
  _any boolean := false;
  _unsure boolean := false;
  _c record;
  _mode text;
  _raw jsonb;
  _ring double precision[][];
  _n integer;
  _i integer;
  _j integer;
  _lat double precision;
  _lng double precision;
  _reach double precision;
  _south double precision;
  _north double precision;
  _west double precision;
  _east double precision;
  _pad double precision;
  _plat double precision;
  _cos double precision;
  _s double precision;
  _dlat double precision;
  _dlng double precision;
  _clat double precision;
  _clng double precision;
  _k double precision;
  _total integer;
  _rank integer;
  _inside boolean;
  _d double precision;
  _outside_by double precision;
  _kx double precision;
  _ax double precision;
  _ay double precision;
  _bx double precision;
  _by double precision;
  _dx double precision;
  _dy double precision;
  _len2 double precision;
  _t double precision;
BEGIN
  IF _org IS NULL OR _zip IS NULL OR _zip !~ '^[0-9]{5}$' THEN
    RETURN 'unknown';
  END IF;

  -- 2. By ZIP list and postal prefix (matchZone's ZIP levels).
  FOR z IN
    SELECT zn.zip_codes, zn.postal_prefix
      FROM public.zones zn
     WHERE zn.organization_id = _org AND COALESCE(zn.enabled, true)
  LOOP
    _any := true;
    IF _zip = ANY (COALESCE(z.zip_codes, '{}'::text[])) THEN
      RETURN 'inside';
    END IF;
    IF COALESCE(z.postal_prefix, '') <> '' AND starts_with(_zip, z.postal_prefix) THEN
      RETURN 'inside';
    END IF;
  END LOOP;
  IF NOT _any THEN
    RETURN 'unknown';
  END IF;

  SELECT c.lat, c.lng, c.radius_m INTO _c FROM reference.zip_centroids c WHERE c.zip = _zip;

  -- 3. By drawn shape, through the ZIP's centre.
  FOR z IN
    SELECT zn.id, zn.geo_match_mode, zn.boundary, zn.center_latitude, zn.center_longitude,
           zn.radius_meters, zn.drive_time_minutes
      FROM public.zones zn
     WHERE zn.organization_id = _org AND COALESCE(zn.enabled, true)
     ORDER BY zn.id
  LOOP
    BEGIN
      _mode := COALESCE(z.geo_match_mode, 'zip');
      _ring := NULL;
      _reach := 0;
      -- zoneFromShape: a shape the matcher can use, or none (ZIP-only zone).
      IF _mode = 'polygon' THEN
        _raw := z.boundary -> 'coordinates' -> 0;
        IF _raw IS NULL OR jsonb_typeof(_raw) <> 'array' OR jsonb_array_length(_raw) < 3 THEN
          CONTINUE;
        END IF;
        SELECT array_agg(ARRAY[(p.v ->> 0)::double precision, (p.v ->> 1)::double precision] ORDER BY p.o)
          INTO _ring
          FROM jsonb_array_elements(_raw) WITH ORDINALITY AS p(v, o);
        _n := array_length(_ring, 1);
        IF _ring[1][1] IS DISTINCT FROM _ring[_n][1] OR _ring[1][2] IS DISTINCT FROM _ring[_n][2] THEN
          _ring := _ring || ARRAY[ARRAY[_ring[1][1], _ring[1][2]]];
          _n := _n + 1;
        END IF;
        IF _n < 4 THEN CONTINUE; END IF;
        SELECT min(_ring[i][2]), max(_ring[i][2]), min(_ring[i][1]), max(_ring[i][1])
          INTO _south, _north, _west, _east
          FROM generate_series(1, _n) i;
        _pad := c_edge_max * 1.01;
      ELSIF z.center_latitude IS NULL OR z.center_longitude IS NULL THEN
        CONTINUE;
      ELSIF _mode = 'radius' AND COALESCE(z.radius_meters, 0) <> 0 THEN
        _reach := z.radius_meters;
      ELSIF _mode = 'drive_time' AND COALESCE(z.drive_time_minutes, 0) <> 0 THEN
        _reach := z.drive_time_minutes * c_drive_m;
      ELSE
        CONTINUE;
      END IF;
      _shapes := _shapes + 1;
      IF _shapes > c_max_shapes THEN
        _unsure := true;
        EXIT;
      END IF;
      IF _ring IS NULL THEN
        _lat := z.center_latitude;
        _lng := z.center_longitude;
        _south := _lat; _north := _lat; _west := _lng; _east := _lng;
        _pad := (_reach + c_edge_max) * 1.01;
      END IF;

      -- searchBox: the extent plus the widest edge margin, 1% to spare.
      _plat := greatest(abs(_south), abs(_north)) + _pad / c_m_per_lat;
      _cos := greatest(0.01, cos(radians(abs(_plat))));
      _s := sin(least(_pad / c_r, pi() / 2)) / _cos;
      _dlng := CASE WHEN _s >= 1 THEN 180 ELSE degrees(asin(_s)) END;
      _dlat := _pad / c_m_per_lat;
      _south := greatest(-90, _south - _dlat);
      _north := least(90, _north + _dlat);
      _west := greatest(-180, _west - _dlng);
      _east := least(180, _east + _dlng);
      IF _north - _south > 10 OR _east - _west > 10 THEN
        _unsure := true;
        CONTINUE;
      END IF;

      -- What zip_centroids_in_box would have returned: the 5,000 centres in
      -- the box nearest its middle. Capped means some were never seen.
      _clat := (_south + _north) / 2;
      _clng := (_west + _east) / 2;
      _k := cos(radians(_clat));
      SELECT count(*) INTO _total FROM (
        SELECT 1 FROM reference.zip_centroids c
         WHERE c.lat BETWEEN _south AND _north AND c.lng BETWEEN _west AND _east
         LIMIT c_cap) t;

      _inside := false;
      _outside_by := NULL;
      IF _c.lat IS NOT NULL
         AND _c.lat BETWEEN _south AND _north AND _c.lng BETWEEN _west AND _east THEN
        -- Only a full box can have left this ZIP unseen, so the rank is
        -- counted only then, and never past the cap.
        _rank := 0;
        IF _total >= c_cap THEN
          SELECT count(*) INTO _rank FROM (
            SELECT 1 FROM reference.zip_centroids c
             WHERE c.lat BETWEEN _south AND _north AND c.lng BETWEEN _west AND _east
               AND ((c.lat - _clat) ^ 2 + ((c.lng - _clng) * _k) ^ 2,  c.zip)
                 < ((_c.lat - _clat) ^ 2 + ((_c.lng - _clng) * _k) ^ 2, _zip)
             LIMIT c_cap) t;
        END IF;
        IF _rank < c_cap THEN
          IF _ring IS NOT NULL THEN
            -- pointInPolygon: the matcher's ray cast over [lng, lat] pairs.
            _j := _n;
            FOR _i IN 1.._n LOOP
              IF (_ring[_i][2] > _c.lat) <> (_ring[_j][2] > _c.lat) THEN
                IF _c.lng < (_ring[_j][1] - _ring[_i][1]) * (_c.lat - _ring[_i][2])
                            / (_ring[_j][2] - _ring[_i][2]) + _ring[_i][1] THEN
                  _inside := NOT _inside;
                END IF;
              END IF;
              _j := _i;
            END LOOP;
            IF NOT _inside THEN
              -- distanceToRingMeters, on a local flat projection.
              _kx := c_m_per_lat * cos(radians(_c.lat));
              _outside_by := 'Infinity';
              FOR _i IN 1.._n - 1 LOOP
                _ax := (_ring[_i][1] - _c.lng) * _kx;
                _ay := (_ring[_i][2] - _c.lat) * c_m_per_lat;
                _bx := (_ring[_i + 1][1] - _c.lng) * _kx;
                _by := (_ring[_i + 1][2] - _c.lat) * c_m_per_lat;
                _dx := _bx - _ax;
                _dy := _by - _ay;
                _len2 := _dx * _dx + _dy * _dy;
                _t := CASE WHEN _len2 = 0 THEN 0
                           ELSE greatest(0, least(1, -(_ax * _dx + _ay * _dy) / _len2)) END;
                _outside_by := least(_outside_by, sqrt((_ax + _t * _dx) ^ 2 + (_ay + _t * _dy) ^ 2));
              END LOOP;
            END IF;
          ELSE
            -- haversineMeters from the centre.
            _d := 2 * c_r * asin(sqrt(
                    sin(radians(_c.lat - _lat) / 2) ^ 2
                    + cos(radians(_lat)) * cos(radians(_c.lat)) * sin(radians(_c.lng - _lng) / 2) ^ 2));
            IF _d <= _reach THEN
              _inside := true;
            ELSE
              _outside_by := _d - _reach;
            END IF;
          END IF;
          IF _inside THEN
            RETURN 'inside';
          END IF;
          IF _outside_by <= least(_c.radius_m, c_edge_max) THEN
            _unsure := true;  -- an edge ZIP: part of it is probably inside
          END IF;
        END IF;
      END IF;
      IF _total >= c_cap THEN
        _unsure := true;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- A shape that cannot be read is unsure, never "outside".
      _unsure := true;
    END;
  END LOOP;

  RETURN CASE WHEN _unsure THEN 'unknown' ELSE 'outside' END;
EXCEPTION WHEN OTHERS THEN
  RETURN 'unknown';
END
$fn$;

COMMENT ON FUNCTION public.directory_zone_verdict(uuid, text) IS
  'Whether a business''s CURRENT zones serve a ZIP: inside, outside or unknown. A port of leadServiceArea (src/lib/lead-service-area.ts) for a bare ZIP, so directory_search can drop "outside" without the service role. Internal: takes an org id, service_role only.';

-- Internal: it takes an organization id, so a visitor never calls it.
REVOKE ALL ON FUNCTION public.directory_zone_verdict(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.directory_zone_verdict(uuid, text) TO service_role;

-- ── 2. The search drops "outside", in the database ────────────────────────
-- Same signature, same shape, same grants as 20261110120000. What changes:
-- a business whose zones now say "outside" for this ZIP is not listed.
--
-- WHAT ONE CALL CAN COST. This is anon-callable, and a verdict is real work
-- (box counts over reference.zip_centroids for each drawn zone), so the work
-- per call is bounded, not just the rows returned:
--   * a malformed ZIP or line returns nothing before anything is read;
--   * candidates come from the cheap filters only (published, live business,
--     ZIP confirmed, line listed; the GIN index on coverage_zips), at most
--     c_max_verdicts of them, in display order;
--   * verdicts stop as soon as c_max_results businesses are kept;
--   * each verdict checks at most 8 drawn zones and counts at most 5,000
--     centres per zone (directory_zone_verdict).
-- So one call is at most 60 verdicts, never one per published profile. With
-- more than 60 businesses confirming one ZIP for one line, the ones past the
-- 60th (alphabetically) are not considered; that is a directory far larger
-- than this one, and the place to page it is then, not now.
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
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
#variable_conflict use_column
DECLARE
  c_max_results  constant integer := 50;
  c_max_verdicts constant integer := 60;
  _ids uuid[] := '{}';
  _cand record;
BEGIN
  IF _zip IS NULL OR _zip !~ '^[0-9]{5}$'
     OR (_service_line IS NOT NULL AND _service_line !~ '^[a-z_]{1,40}$') THEN
    RETURN;
  END IF;

  FOR _cand IN
    SELECT p.organization_id
      FROM public.directory_profiles p
      JOIN public.organizations o ON o.id = p.organization_id
     WHERE p.published
       AND o.deleted_at IS NULL
       AND _zip = ANY (p.coverage_zips)
       AND (_service_line IS NULL OR _service_line = ANY (p.service_lines))
     ORDER BY p.display_name, p.slug
     LIMIT c_max_verdicts
  LOOP
    IF public.directory_zone_verdict(_cand.organization_id, _zip) <> 'outside' THEN
      _ids := _ids || _cand.organization_id;
      EXIT WHEN cardinality(_ids) >= c_max_results;
    END IF;
  END LOOP;

  RETURN QUERY
    SELECT r.*
      FROM public.directory_public_rows(_ids, NULL) r
     ORDER BY r.display_name, r.slug
     LIMIT c_max_results;
END
$fn$;

REVOKE ALL ON FUNCTION public.directory_search(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.directory_search(text, text) TO anon, authenticated, service_role;

-- ── 3. The public listings, as a read-only view ───────────────────────────
-- For a second app that lists or pages through the directory (a profile page,
-- a sitemap of published slugs). Column for column what directory_search and
-- directory_profiles_by_slug return. A view runs its table reads as its
-- owner, so anon needs SELECT on the view and on nothing under it; it does
-- NOT call directory_public_rows, because a function inside a view is
-- checked against the caller, and that function stays service_role only.
-- security_barrier: no caller-supplied predicate is evaluated before the
-- published / not-deleted filter.
DROP VIEW IF EXISTS public.directory_public_listings;
CREATE VIEW public.directory_public_listings
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
         p.published_at
    FROM public.directory_profiles p
    JOIN public.organizations o ON o.id = p.organization_id
   WHERE p.published
     AND o.deleted_at IS NULL;

COMMENT ON VIEW public.directory_public_listings IS
  'Every PUBLISHED directory profile of a live business, in the public shape only (slug, display_name, logo_url, bio, service_lines, coverage_zips, coverage_cities, services[label, service_line, price_from_cents, price_unit], published_at). Read-only; anon may SELECT this view and not the tables under it (#630, mypets.services).';

REVOKE ALL ON public.directory_public_listings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.directory_public_listings TO anon, authenticated;
GRANT SELECT ON public.directory_public_listings TO service_role;

-- ── 4. What this file establishes ──────────────────────────────────────────
DO $check$
DECLARE _priv text; _cols text[];
BEGIN
  -- The tables under the view stay shut to a visitor.
  FOREACH _priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF has_table_privilege('anon', 'public.directory_profiles', _priv)
       OR has_table_privilege('anon', 'public.directory_profile_services', _priv) THEN
      RAISE EXCEPTION 'anon holds % on a directory table', _priv;
    END IF;
  END LOOP;
  IF to_regclass('public.directory_reviews') IS NOT NULL
     AND has_table_privilege('anon', 'public.directory_reviews', 'SELECT') THEN
    RAISE EXCEPTION 'anon can read directory_reviews directly';
  END IF;

  -- The view: SELECT for anon, and nothing that writes.
  IF NOT has_table_privilege('anon', 'public.directory_public_listings', 'SELECT') THEN
    RAISE EXCEPTION 'a visitor cannot read directory_public_listings';
  END IF;
  FOREACH _priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
    IF has_table_privilege('anon', 'public.directory_public_listings', _priv)
       OR has_table_privilege('authenticated', 'public.directory_public_listings', _priv) THEN
      RAISE EXCEPTION 'a client role holds % on directory_public_listings', _priv;
    END IF;
  END LOOP;

  -- Exactly the public columns, in the public order.
  SELECT array_agg(a.attname::text ORDER BY a.attnum) INTO _cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.directory_public_listings'::regclass
     AND a.attnum > 0 AND NOT a.attisdropped;
  IF _cols IS DISTINCT FROM ARRAY['slug', 'display_name', 'logo_url', 'bio', 'service_lines',
                                  'coverage_zips', 'coverage_cities', 'services', 'published_at'] THEN
    RAISE EXCEPTION 'directory_public_listings has columns %', _cols;
  END IF;

  -- The search stays a visitor's; the verdict and the org lookups do not.
  IF NOT has_function_privilege('anon', 'public.directory_search(text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a visitor cannot search the directory';
  END IF;
  IF has_function_privilege('anon', 'public.directory_zone_verdict(uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.directory_zone_verdict(uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.directory_public_rows(uuid[], text[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.directory_org_for_quote(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a function that takes or returns an org id is callable by a client role';
  END IF;
  IF strpos((SELECT prosrc FROM pg_proc WHERE oid = 'public.directory_search(text, text)'::regprocedure),
            'public.directory_zone_verdict(_cand.organization_id, _zip) <> ''outside''') = 0 THEN
    RAISE EXCEPTION 'directory_search does not drop a business whose zones say outside';
  END IF;
  IF strpos((SELECT prosrc FROM pg_proc WHERE oid = 'public.directory_search(text, text)'::regprocedure),
            'LIMIT c_max_verdicts') = 0 THEN
    RAISE EXCEPTION 'directory_search runs a verdict for every candidate rather than a bounded number';
  END IF;

  -- An empty database has no zones: the verdict is "unknown", never "outside".
  IF public.directory_zone_verdict(NULL, '48201') <> 'unknown'
     OR public.directory_zone_verdict('00000000-0000-0000-0000-000000000000', '48201') <> 'unknown'
     OR public.directory_zone_verdict('00000000-0000-0000-0000-000000000000', '"48201"') <> 'unknown' THEN
    RAISE EXCEPTION 'directory_zone_verdict says something other than unknown with no zones';
  END IF;
END
$check$;
