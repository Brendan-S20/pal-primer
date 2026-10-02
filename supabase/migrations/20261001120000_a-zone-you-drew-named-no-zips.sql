-- A zone you drew named no ZIPs.
--
-- Owner, 2026-10-01: "when working the zones and selecting only a radius,
-- drive time, or polygon; it does not auto insert all the zip codes that are
-- within that. We need that to happen, due to many things relying on the zip
-- codes."
--
-- What relies on them: the public signup page and the lead form price a
-- visitor through public_quote, which matches on ZIP ONLY (`_zip =
-- ANY(z.zip_codes)`), because a visitor typing into a form has a ZIP and no
-- point. A zone drawn as a circle with an empty ZIP list therefore quotes
-- nobody who arrives that way, and nothing on screen says so.
--
-- This file adds the lookup that fills the list: every US ZIP whose center
-- falls inside a drawn shape. The geometry itself (radius, drive time,
-- polygon) is decided in TypeScript by src/lib/zone-match.ts -- the same code
-- that assigns properties to zones -- so the fill and the matcher cannot
-- disagree. The database's only job is the candidate list: ZIP centers inside
-- a bounding box. See src/lib/zone-zip-fill.ts.
--
-- ── WHY A TABLE, AND WHY NOT IN `public` ─────────────────────────────────
--
-- The data is the Census Gazetteer ZCTA file (public domain, 33,791 rows),
-- loaded by the NEXT migration. Bundling it instead was weighed and refused:
-- ~950 KB that the Cloudflare worker would parse on every cold start, or the
-- browser would download, for a lookup an owner runs a few times a year.
--
-- It lives in `reference`, which PostgREST does not expose (config.toml
-- exposes public and graphql_public). So it is not an API surface at all: no
-- anon or authenticated grant, no USAGE on the schema, and the RLS policies
-- and the 2FA ratchet on `public` tables have nothing to apply to. The only
-- way in is the one function below, which is gated on membership.
--
-- Replays into an empty database: nothing here reads a row it did not write.

CREATE SCHEMA IF NOT EXISTS reference;
REVOKE ALL ON SCHEMA reference FROM PUBLIC;
REVOKE ALL ON SCHEMA reference FROM anon, authenticated;
GRANT USAGE ON SCHEMA reference TO service_role;

CREATE TABLE IF NOT EXISTS reference.zip_centroids (
  -- 5-digit ZCTA, which is what a property's postal_code and a zone's
  -- zip_codes hold. ZCTAs approximate USPS ZIPs; PO-box-only ZIPs have none.
  zip      text PRIMARY KEY CHECK (zip ~ '^[0-9]{5}$'),
  -- The Census "internal point" (INTPTLAT / INTPTLONG): inside the ZCTA even
  -- when the shape is a crescent, which a true centroid is not.
  lat      double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng      double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  -- sqrt(ALAND / pi): the radius of a circle with the ZIP's land area. Used to
  -- decide which ZIPs only PARTLY overlap a shape -- see zone-zip-fill.ts.
  radius_m integer NOT NULL CHECK (radius_m >= 0)
);

COMMENT ON TABLE reference.zip_centroids IS
  'US Census Gazetteer ZCTA internal points (public domain). Read only through public.zip_centroids_in_box.';

CREATE INDEX IF NOT EXISTS zip_centroids_lat_lng_idx ON reference.zip_centroids (lat, lng);

ALTER TABLE reference.zip_centroids ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON reference.zip_centroids FROM PUBLIC;
REVOKE ALL ON reference.zip_centroids FROM anon, authenticated;
GRANT SELECT ON reference.zip_centroids TO service_role;

-- ── The one way in ────────────────────────────────────────────────────────
--
-- ZIP centers inside a box, nearest the middle first, for a member of the org.
-- The box is the drawn shape's extent plus the widest "partly overlaps"
-- margin; zone-zip-fill.ts builds it and does the real geometry on what comes
-- back.
--
-- Gated on membership rather than a permission: it reveals nothing about any
-- tenant (the data is a public-domain file), and the gate exists only so the
-- publishable key cannot page through it. Refuses a caller with no user at
-- all, including the service role -- nothing server-side needs it.
--
-- Bounded twice: the box may not span more than 10 degrees either way (a
-- shape that size is not a service area), and at most 10,000 rows come back.

CREATE OR REPLACE FUNCTION public.zip_centroids_in_box(
  _org_id uuid,
  _south double precision,
  _west double precision,
  _north double precision,
  _east double precision,
  _limit integer DEFAULT 5000
)
RETURNS TABLE (zip text, lat double precision, lng double precision, radius_m integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  _clat double precision;
  _clng double precision;
  _k double precision;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_org_member(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'not a member of this organization' USING ERRCODE = '42501';
  END IF;
  IF _south IS NULL OR _west IS NULL OR _north IS NULL OR _east IS NULL
     OR _south > _north OR _west > _east
     OR _south < -90 OR _north > 90 OR _west < -180 OR _east > 180 THEN
    RAISE EXCEPTION 'that is not a box on the map' USING ERRCODE = '22023';
  END IF;
  IF _north - _south > 10 OR _east - _west > 10 THEN
    RAISE EXCEPTION 'that area is too large to list ZIPs for' USING ERRCODE = '22023';
  END IF;

  _clat := (_south + _north) / 2;
  _clng := (_west + _east) / 2;
  _k := cos(radians(_clat));

  RETURN QUERY
    SELECT c.zip, c.lat, c.lng, c.radius_m
      FROM reference.zip_centroids c
     WHERE c.lat BETWEEN _south AND _north
       AND c.lng BETWEEN _west AND _east
     ORDER BY (c.lat - _clat) ^ 2 + ((c.lng - _clng) * _k) ^ 2, c.zip
     LIMIT LEAST(GREATEST(COALESCE(_limit, 5000), 1), 10000);
END
$function$;

REVOKE ALL ON FUNCTION public.zip_centroids_in_box(uuid, double precision, double precision, double precision, double precision, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.zip_centroids_in_box(uuid, double precision, double precision, double precision, double precision, integer) TO authenticated, service_role;

-- What this file establishes, checked on any starting state.
DO $check$
BEGIN
  IF has_schema_privilege('anon', 'reference', 'USAGE')
     OR has_schema_privilege('authenticated', 'reference', 'USAGE') THEN
    RAISE EXCEPTION 'reference schema is reachable by an API role';
  END IF;
  IF has_function_privilege('anon',
       'public.zip_centroids_in_box(uuid, double precision, double precision, double precision, double precision, integer)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'zip_centroids_in_box is executable by anon';
  END IF;
  IF NOT has_function_privilege('authenticated',
       'public.zip_centroids_in_box(uuid, double precision, double precision, double precision, double precision, integer)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'zip_centroids_in_box is not executable by authenticated, which is who calls it';
  END IF;
END
$check$;
