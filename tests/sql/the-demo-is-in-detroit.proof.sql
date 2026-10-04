-- A reseeded demo is in metro Detroit, proved in a real Postgres. Run by
-- tests/the-demo-is-in-detroit.test.ts with :route (20260930010000), :paid
-- (20261001010000) and :migration (20261004010000), applied in that order so
-- a stack that predates any of them still proves the body CI builds; each is
-- a no-op on a body it has already spliced.
--
-- It seeds a business and then asks the questions a map would: is every pin
-- in Detroit, is every pin inside the ZIP it claims, does every ZIP belong to
-- a zone, does the zone the seed wrote agree with the zone the app's matcher
-- (src/lib/zone-match.ts, mirrored below) would choose, and does the depot
-- sit where the work is. The pre-fix seed fails the first question on all ten
-- properties. ROLLED BACK at the end.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

-- Every seed proof replaces seed_demo_org inside its transaction and then
-- seeds; this is the same queue the-demo-was-paid-next-week.proof.sql joins.
SELECT pg_advisory_xact_lock(hashtext('houndstack.proof.seed_demo_org'));

\i :route
\i :paid
\i :migration

INSERT INTO auth.users (id, email) VALUES
  ('a0000000-0000-4000-8000-00000000d001', 'owner@detroit.proof.invalid');
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a000000-0000-4000-8000-0000000000d1', 'Detroit Proof', 'America/Detroit');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a0000000-0000-4000-8000-00000000d001', '0a000000-0000-4000-8000-0000000000d1', 'owner');
SET LOCAL app.allow_protected_org_write = '';
INSERT INTO public.staff (organization_id, user_id, display_name, role, active,
                          is_field_tech, is_field_tech_overridden)
VALUES ('0a000000-0000-4000-8000-0000000000d1', 'a0000000-0000-4000-8000-00000000d001',
        'Owner Operator', 'owner', true, true, true);

SELECT set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-00000000d001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT public.seed_demo_org('0a000000-0000-4000-8000-0000000000d1') IS NOT NULL AS seeded \gset
RESET ROLE;

-- pointInPolygon from src/lib/zone-match.ts, line for line: the ring is
-- GeoJSON [lng, lat] pairs.
CREATE FUNCTION pg_temp.point_in_ring(_lat float8, _lng float8, _ring jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $pip$
DECLARE
  _inside boolean := false;
  _n int := jsonb_array_length(_ring);
  _j int := _n - 1;
  _xi float8; _yi float8; _xj float8; _yj float8;
BEGIN
  FOR _i IN 0.._n - 1 LOOP
    _xi := (_ring -> _i ->> 0)::float8;  _yi := (_ring -> _i ->> 1)::float8;
    _xj := (_ring -> _j ->> 0)::float8;  _yj := (_ring -> _j ->> 1)::float8;
    IF ((_yi > _lat) <> (_yj > _lat))
       AND _lng < (_xj - _xi) * (_lat - _yi) / (_yj - _yi) + _xi THEN
      _inside := NOT _inside;
    END IF;
    _j := _i;
  END LOOP;
  RETURN _inside;
END
$pip$;

-- haversineMeters from the same file.
CREATE FUNCTION pg_temp.metres(_lat1 float8, _lng1 float8, _lat2 float8, _lng2 float8)
RETURNS float8 LANGUAGE sql IMMUTABLE AS $m$
  SELECT 2 * 6371000 * asin(sqrt(
    sin(radians(_lat2 - _lat1) / 2) ^ 2
    + cos(radians(_lat1)) * cos(radians(_lat2)) * sin(radians(_lng2 - _lng1) / 2) ^ 2))
$m$;

-- 1. Every pin, city, state and ZIP is metro Detroit.
DO $$
DECLARE _n int; _bad text;
BEGIN
  SELECT count(*) INTO _n FROM public.properties
   WHERE organization_id = '0a000000-0000-4000-8000-0000000000d1';
  IF _n <> 10 THEN
    RAISE EXCEPTION 'PROOF FAILED [seed]: expected 10 seeded properties, found %', _n;
  END IF;
  SELECT string_agg(format('%s, %s %s (%s, %s)', street, city, postal_code, latitude, longitude), '; ')
    INTO _bad
    FROM public.properties
   WHERE organization_id = '0a000000-0000-4000-8000-0000000000d1'
     AND NOT COALESCE(latitude BETWEEN 42.0 AND 42.9 AND longitude BETWEEN -83.6 AND -82.8
                      AND region = 'MI' AND postal_code ~ '^48[0-9]{3}$'
                      AND city !~* 'new york', false);
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [place]: not metro Detroit: %', _bad;
  END IF;
  RAISE NOTICE 'ok: % properties, every one in MI, a 48xxx ZIP and inside 42.0-42.9 N, 82.8-83.6 W', _n;
END $$;

-- 2. Every pin sits inside the Census area of the ZIP it claims: within the
--    ZCTA's equal-area radius of its centre (reference.zip_centroids, loaded
--    by 20261001120100 -- the same table a drawn zone's ZIPs are filled from).
DO $$
DECLARE _bad text; _n int;
BEGIN
  IF to_regclass('reference.zip_centroids') IS NULL
     OR NOT EXISTS (SELECT 1 FROM reference.zip_centroids WHERE zip = '48067') THEN
    RAISE EXCEPTION 'PROOF FAILED [zip]: reference.zip_centroids is missing or empty -- this stack predates 20261001120100; replay the migrations (the check could not run, and saying nothing would read as a pass)';
  END IF;
  SELECT count(*), string_agg(format('%s %s is %s m from the centre of a ZIP %s m across',
                                     p.street, p.postal_code,
                                     round(pg_temp.metres(p.latitude, p.longitude, z.lat, z.lng)),
                                     z.radius_m), '; ')
           FILTER (WHERE z.zip IS NULL
                      OR pg_temp.metres(p.latitude, p.longitude, z.lat, z.lng) > z.radius_m)
    INTO _n, _bad
    FROM public.properties p
    LEFT JOIN reference.zip_centroids z ON z.zip = p.postal_code
   WHERE p.organization_id = '0a000000-0000-4000-8000-0000000000d1';
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [zip]: %', _bad;
  END IF;
  RAISE NOTICE 'ok: all % pins are inside the ZIP they claim', _n;
END $$;

-- 3. The zones are Detroit's, and the drawn one is drawn honestly: its
--    centre is inside its polygon, its radius reaches every property it
--    holds, and its ZIP list is exactly the ZIP centres inside its polygon.
DO $$
DECLARE _bad text; _z record; _inside text[];
BEGIN
  IF (SELECT count(*) FROM public.zones
       WHERE organization_id = '0a000000-0000-4000-8000-0000000000d1') <> 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [zones]: expected two seeded zones';
  END IF;
  SELECT string_agg(name || ' ' || COALESCE(array_to_string(zip_codes, ','), '(none)'), '; ') INTO _bad
    FROM public.zones
   WHERE organization_id = '0a000000-0000-4000-8000-0000000000d1'
     AND (zip_codes IS NULL OR cardinality(zip_codes) = 0
          OR EXISTS (SELECT 1 FROM unnest(zip_codes) zz WHERE zz !~ '^48[0-9]{3}$'));
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [zones]: a zone names a ZIP outside metro Detroit: %', _bad;
  END IF;
  FOR _z IN SELECT * FROM public.zones
             WHERE organization_id = '0a000000-0000-4000-8000-0000000000d1'
               AND geo_match_mode = 'polygon' LOOP
    IF NOT pg_temp.point_in_ring(_z.center_latitude, _z.center_longitude,
                                 _z.boundary -> 'coordinates' -> 0) THEN
      RAISE EXCEPTION 'PROOF FAILED [zones]: % has its centre outside its own polygon', _z.name;
    END IF;
    IF EXISTS (SELECT 1 FROM public.properties p
                WHERE p.zone_id = _z.id
                  AND pg_temp.metres(p.latitude, p.longitude, _z.center_latitude, _z.center_longitude)
                      > _z.radius_meters) THEN
      RAISE EXCEPTION 'PROOF FAILED [zones]: % holds a property its radius does not reach', _z.name;
    END IF;
    SELECT array_agg(zip ORDER BY zip) INTO _inside
      FROM reference.zip_centroids
     WHERE lat BETWEEN 42.0 AND 43.0 AND lng BETWEEN -84.0 AND -82.5
       AND pg_temp.point_in_ring(lat, lng, _z.boundary -> 'coordinates' -> 0);
    IF _inside IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(_z.zip_codes) x) THEN
      RAISE EXCEPTION 'PROOF FAILED [zones]: % lists ZIPs % but its polygon holds the centres of %',
        _z.name, _z.zip_codes, _inside;
    END IF;
  END LOOP;
  RAISE NOTICE 'ok: both zones name only 48xxx ZIPs; the drawn one''s centre, radius and ZIP list agree with its polygon';
END $$;

-- 4. The seed's zone is the matcher's zone. matchZone, in SQL: polygon
--    containment, then exact ZIP, then postal prefix, then radius or drive
--    time; ties by priority, then type fit, then prefix length, then id.
DO $$
DECLARE _bad text; _n int;
BEGIN
  WITH m AS (
    SELECT p.id, p.street, p.zone_id, p.auto_zone_id,
           (SELECT z.id
              FROM public.zones z
              CROSS JOIN LATERAL (SELECT LEAST(
                CASE WHEN z.geo_match_mode = 'polygon' AND z.boundary -> 'coordinates' -> 0 IS NOT NULL
                       AND pg_temp.point_in_ring(p.latitude, p.longitude, z.boundary -> 'coordinates' -> 0)
                     THEN 0 END,
                CASE WHEN p.postal_code = ANY (COALESCE(z.zip_codes, '{}')) THEN 1
                     WHEN z.postal_prefix IS NOT NULL AND p.postal_code LIKE z.postal_prefix || '%' THEN 2 END,
                CASE WHEN z.geo_match_mode = 'radius' AND z.radius_meters IS NOT NULL
                       AND pg_temp.metres(p.latitude, p.longitude, z.center_latitude, z.center_longitude) <= z.radius_meters
                     THEN 3 END,
                CASE WHEN z.geo_match_mode = 'drive_time' AND z.drive_time_minutes IS NOT NULL
                       AND pg_temp.metres(p.latitude, p.longitude, z.center_latitude, z.center_longitude) <= z.drive_time_minutes * 800
                     THEN 3 END) AS level) lv
             WHERE z.organization_id = p.organization_id AND lv.level IS NOT NULL
             ORDER BY lv.level, COALESCE(z.priority, 0) DESC,
                      CASE WHEN COALESCE(p.account_type, c.account_type) IS NULL THEN 0
                           WHEN z.account_type IS NULL THEN 1
                           WHEN z.account_type = COALESCE(p.account_type, c.account_type) THEN 0
                           ELSE 2 END,
                      length(COALESCE(z.postal_prefix, '')) DESC, z.id::text
             LIMIT 1) AS matched
      FROM public.properties p
      JOIN public.clients c ON c.id = p.client_id
     WHERE p.organization_id = '0a000000-0000-4000-8000-0000000000d1'
  )
  SELECT count(*),
         string_agg(street, ', ') FILTER (WHERE matched IS NULL OR zone_id IS DISTINCT FROM matched
                                            OR auto_zone_id IS DISTINCT FROM matched)
    INTO _n, _bad FROM m;
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [match]: the seed and the matcher disagree about: %', _bad;
  END IF;
  RAISE NOTICE 'ok: all % properties are in the zone the matcher would choose, and auto_zone_id says so', _n;
END $$;

-- 5. The depot is where the work is, and the leads ask about Detroit ZIPs.
DO $$
DECLARE _far int; _leads int;
BEGIN
  SELECT count(*) INTO _far FROM public.staff s
   WHERE s.organization_id = '0a000000-0000-4000-8000-0000000000d1' AND s.active
     AND NOT COALESCE(
           s.start_latitude BETWEEN 42.0 AND 42.9 AND s.start_longitude BETWEEN -83.6 AND -82.8
       AND s.end_latitude BETWEEN 42.0 AND 42.9 AND s.end_longitude BETWEEN -83.6 AND -82.8
       AND s.start_address ~ ', MI 48[0-9]{3}$' AND s.end_address ~ ', MI 48[0-9]{3}$'
       AND (SELECT max(pg_temp.metres(s.start_latitude, s.start_longitude, p.latitude, p.longitude))
              FROM public.properties p WHERE p.organization_id = s.organization_id) < 25000,
       false);
  IF _far > 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [depot]: % active staff start or end away from the seeded route', _far;
  END IF;
  SELECT count(*) FILTER (WHERE location !~ '^48[0-9]{3}$') INTO _leads
    FROM public.leads WHERE organization_id = '0a000000-0000-4000-8000-0000000000d1';
  IF _leads > 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [leads]: % seeded leads ask about a ZIP outside metro Detroit', _leads;
  END IF;
  RAISE NOTICE 'ok: the depot is in Royal Oak within 25 km of every stop, and every lead asks about a 48xxx ZIP';
END $$;

ROLLBACK;
\echo ALL DEMO-IN-DETROIT PROOFS PASSED
