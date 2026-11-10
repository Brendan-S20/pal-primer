-- #793 inventory: drawn zones that list no ZIPs, and the ZIPs filling them
-- would add. WRITES NOTHING.
--
-- #778 fills a NEW setup area's ZIPs. Areas saved before it still have
-- zip_codes = '{}', and public_quote -- the signup page and the lead form --
-- matches a visitor by ZIP alone, so it quotes nobody inside them (e.g. 48226
-- inside a 10-mile circle on Detroit).
--
-- Run read only:
--   psql "$DB_URL" -f scripts/backfill/793-zones-with-a-shape-and-no-zips.sql
--   psql "$DB_URL" -v org_prefix=342d4d1e -f scripts/backfill/793-zones-with-a-shape-and-no-zips.sql
--
-- Three lists:
--   1. Every zone with a drawn shape, an empty ZIP list and no postal prefix:
--      the zones public_quote cannot reach. Read this first.
--   2. For the radius and drive-time zones among them, the proposed ZIP list
--      and the UPDATE that would write it, AS TEXT. Nothing here runs it.
--   3. Polygon zones among them: not proposed here (the ray cast lives in
--      src/lib/zone-match.ts). The owner fills these from Zones with "Fill
--      ZIPs for all", which runs the same planner as the TS code.
--
-- ── THE RULE, MIRRORED FROM src/lib/zone-zip-backfill.ts ────────────────
--
--   * inside = the ZIP's Census center (reference.zip_centroids) is within
--     the circle: haversine, R = 6371000 m, as zone-match.ts; a drive time is
--     minutes * 800 m (DRIVE_M_PER_MIN). Edge ZIPs are never added.
--   * a ZIP another zone of the same business already lists, or whose prefix
--     covers it, is skipped: public_quote ranks an exact ZIP above a prefix,
--     so adding it would steal it from the zone quoting it today.
--   * a ZIP inside two empty zones goes to the one matchZone picks: a polygon
--     first, then priority DESC, then id.
--   * at most 1000 ZIPs a zone (MAX_AUTO_ZIPS), nearest the center first.
--   * each proposed UPDATE is guarded on zip_codes still being '{}'.
--
-- ── BEFORE ANYTHING IN LIST 2 IS RUN AGAINST PRODUCTION ─────────────────
--
-- A production backfill needs Brendan's explicit approval, per #793. Run this
-- file, send him the output, and run only the rows he approves, by hand. Do
-- not run anything against Detroit Doo Disposal's org without that approval
-- naming it. After a write, re-run zone detection for that org from Zones
-- (or redetectZonesForOrg) so existing properties agree with the new lists.

\if :{?org_prefix}
\else
  \set org_prefix ''
\endif

BEGIN READ ONLY;

-- The same base set in all three lists, repeated rather than kept in a temp
-- view: a READ ONLY transaction refuses every CREATE, temporary or not.

\echo '== 1. Drawn zones with no ZIPs and no prefix (public_quote cannot reach them) =='
WITH _793_empty AS (
SELECT z.id, z.organization_id, z.name, z.priority, z.enabled, z.geo_match_mode,
       z.center_latitude::float8 AS clat, z.center_longitude::float8 AS clng,
       CASE z.geo_match_mode
         WHEN 'radius' THEN z.radius_meters::float8
         WHEN 'drive_time' THEN z.drive_time_minutes::float8 * 800
       END AS reach_m
  FROM public.zones z
 WHERE coalesce(cardinality(z.zip_codes), 0) = 0
   AND nullif(btrim(coalesce(z.postal_prefix, '')), '') IS NULL
   AND z.organization_id::text LIKE :'org_prefix' || '%'
   AND (
     (z.geo_match_mode = 'radius' AND z.center_latitude IS NOT NULL
        AND z.center_longitude IS NOT NULL AND coalesce(z.radius_meters, 0) > 0)
     OR (z.geo_match_mode = 'drive_time' AND z.center_latitude IS NOT NULL
        AND z.center_longitude IS NOT NULL AND coalesce(z.drive_time_minutes, 0) > 0)
     OR (z.geo_match_mode = 'polygon'
        AND jsonb_array_length(coalesce(z.boundary -> 'coordinates' -> 0, '[]'::jsonb)) >= 3)
   )
)
SELECT o.name AS business, o.public_signup_enabled AS signup_on,
       e.name AS zone, e.id AS zone_id, e.geo_match_mode AS shape,
       round(e.reach_m) AS reach_m, e.enabled
  FROM _793_empty e
  JOIN public.organizations o ON o.id = e.organization_id
 ORDER BY o.name, e.name;

\echo '== 2. Proposed ZIP lists for the radius and drive-time zones (text only) =='
WITH _793_empty AS (
SELECT z.id, z.organization_id, z.name, z.priority, z.enabled, z.geo_match_mode,
       z.center_latitude::float8 AS clat, z.center_longitude::float8 AS clng,
       CASE z.geo_match_mode
         WHEN 'radius' THEN z.radius_meters::float8
         WHEN 'drive_time' THEN z.drive_time_minutes::float8 * 800
       END AS reach_m
  FROM public.zones z
 WHERE coalesce(cardinality(z.zip_codes), 0) = 0
   AND nullif(btrim(coalesce(z.postal_prefix, '')), '') IS NULL
   AND z.organization_id::text LIKE :'org_prefix' || '%'
   AND (
     (z.geo_match_mode = 'radius' AND z.center_latitude IS NOT NULL
        AND z.center_longitude IS NOT NULL AND coalesce(z.radius_meters, 0) > 0)
     OR (z.geo_match_mode = 'drive_time' AND z.center_latitude IS NOT NULL
        AND z.center_longitude IS NOT NULL AND coalesce(z.drive_time_minutes, 0) > 0)
     OR (z.geo_match_mode = 'polygon'
        AND jsonb_array_length(coalesce(z.boundary -> 'coordinates' -> 0, '[]'::jsonb)) >= 3)
   )
),
inside AS (
  SELECT e.*, c.zip,
         2 * 6371000 * asin(sqrt(
           sin(radians(c.lat - e.clat) / 2) ^ 2
           + cos(radians(e.clat)) * cos(radians(c.lat)) * sin(radians(c.lng - e.clng) / 2) ^ 2
         )) AS d
    FROM _793_empty e
    JOIN reference.zip_centroids c
      -- A box first, so the haversine runs on hundreds of rows, not 33,791.
      ON c.lat BETWEEN e.clat - e.reach_m / 111000.0 AND e.clat + e.reach_m / 111000.0
     AND c.lng BETWEEN e.clng - e.reach_m / (111000.0 * greatest(cos(radians(e.clat)), 0.01))
                   AND e.clng + e.reach_m / (111000.0 * greatest(cos(radians(e.clat)), 0.01))
   WHERE e.geo_match_mode IN ('radius', 'drive_time')
),
inside_only AS (
  SELECT * FROM inside WHERE d <= reach_m
),
unclaimed AS (
  SELECT i.* FROM inside_only i
   WHERE NOT EXISTS (
     SELECT 1 FROM public.zones o
      WHERE o.organization_id = i.organization_id AND o.id <> i.id
        AND (i.zip = ANY(o.zip_codes)
             OR (nullif(btrim(coalesce(o.postal_prefix, '')), '') IS NOT NULL
                 AND i.zip LIKE o.postal_prefix || '%')))
),
won AS (
  -- Among empty circles holding the same center: priority, then id. (An empty
  -- POLYGON holding it would win in matchZone; list 3 flags those zones, and
  -- the owner's fill on Zones decides them with the real ray cast.)
  SELECT DISTINCT ON (u.organization_id, u.zip) u.*
    FROM unclaimed u
   ORDER BY u.organization_id, u.zip, coalesce(u.priority, 0) DESC, u.id::text
),
ranked AS (
  SELECT w.*, row_number() OVER (PARTITION BY w.id ORDER BY w.d, w.zip) AS n FROM won w
)
SELECT o.name AS business, r.name AS zone, r.id AS zone_id,
       count(*) AS zips,
       bool_or(r.zip = '48226') AS has_48226,
       string_agg(r.zip, ',' ORDER BY r.d, r.zip) AS zip_list,
       format('UPDATE public.zones SET zip_codes = %L::text[] WHERE id = %L AND zip_codes = ''{}'';',
              '{' || string_agg(r.zip, ',' ORDER BY r.d, r.zip) || '}', r.id) AS proposed_sql
  FROM ranked r
  JOIN public.organizations o ON o.id = r.organization_id
 WHERE r.n <= 1000
 GROUP BY o.name, r.name, r.id
 ORDER BY o.name, r.name;

\echo '== 3. Polygon zones with no ZIPs: owner fills from Zones (Fill ZIPs for all) =='
WITH _793_empty AS (
SELECT z.id, z.organization_id, z.name, z.priority, z.enabled, z.geo_match_mode,
       z.center_latitude::float8 AS clat, z.center_longitude::float8 AS clng,
       CASE z.geo_match_mode
         WHEN 'radius' THEN z.radius_meters::float8
         WHEN 'drive_time' THEN z.drive_time_minutes::float8 * 800
       END AS reach_m
  FROM public.zones z
 WHERE coalesce(cardinality(z.zip_codes), 0) = 0
   AND nullif(btrim(coalesce(z.postal_prefix, '')), '') IS NULL
   AND z.organization_id::text LIKE :'org_prefix' || '%'
   AND (
     (z.geo_match_mode = 'radius' AND z.center_latitude IS NOT NULL
        AND z.center_longitude IS NOT NULL AND coalesce(z.radius_meters, 0) > 0)
     OR (z.geo_match_mode = 'drive_time' AND z.center_latitude IS NOT NULL
        AND z.center_longitude IS NOT NULL AND coalesce(z.drive_time_minutes, 0) > 0)
     OR (z.geo_match_mode = 'polygon'
        AND jsonb_array_length(coalesce(z.boundary -> 'coordinates' -> 0, '[]'::jsonb)) >= 3)
   )
)
SELECT o.name AS business, e.name AS zone, e.id AS zone_id
  FROM _793_empty e
  JOIN public.organizations o ON o.id = e.organization_id
 WHERE e.geo_match_mode = 'polygon'
 ORDER BY o.name, e.name;

ROLLBACK;
