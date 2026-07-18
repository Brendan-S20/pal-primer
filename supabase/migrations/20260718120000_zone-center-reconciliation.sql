-- Zone center reconciliation (QA round 3, deferred item).
--
-- The deliberate follow-up pass the phase-2 migration deferred: any zone whose
-- radius/drive-time coverage lacks a usable center gets one derived from the
-- best-known source — the zone's own pin, else the centroid of the org's
-- geocoded properties inside the zone's ZIPs/prefix. Unlike the phase-2
-- ZIP-only backfill this PRESERVES a configured extent (radius or drive-time)
-- and only fills the missing center; the 1-mile default applies only when no
-- extent exists at all. Zones with no derivable center stay untouched and
-- remain in the Zones page "no map coverage yet" manual-review queue (I5).
--
-- Verified against live data before shipping: currently zero zones qualify,
-- so this is a no-op today — it exists so imported or API-created zones that
-- regress into this state are repaired on the next reconciliation, with
-- property assignments re-ranked to match (B3 consistency).

WITH candidates AS (
  SELECT z.id,
         COALESCE(z.center_latitude,  z.latitude,  sub.avg_lat) AS lat,
         COALESCE(z.center_longitude, z.longitude, sub.avg_lng) AS lng
  FROM public.zones z
  LEFT JOIN LATERAL (
    SELECT avg(p.latitude) AS avg_lat, avg(p.longitude) AS avg_lng
    FROM public.properties p
    WHERE p.organization_id = z.organization_id
      AND p.archived_at IS NULL
      AND p.latitude IS NOT NULL AND p.longitude IS NOT NULL
      AND (btrim(p.postal_code) = ANY (COALESCE(z.zip_codes, '{}'))
           OR (z.postal_prefix IS NOT NULL AND btrim(p.postal_code) LIKE z.postal_prefix || '%'))
  ) sub ON true
  WHERE z.boundary IS NULL
    AND (z.center_latitude IS NULL OR z.center_longitude IS NULL)
)
UPDATE public.zones z
   SET center_latitude  = c.lat,
       center_longitude = c.lng,
       -- Keep a configured extent; default to radius + 1 mile only when the
       -- zone has neither a radius nor a drive-time.
       geo_match_mode = CASE
         WHEN z.drive_time_minutes IS NOT NULL THEN 'drive_time'
         ELSE 'radius'
       END,
       radius_meters = CASE
         WHEN z.drive_time_minutes IS NOT NULL THEN z.radius_meters
         ELSE COALESCE(z.radius_meters, 1609)
       END
  FROM candidates c
 WHERE z.id = c.id AND c.lat IS NOT NULL AND c.lng IS NOT NULL;

-- Re-rank property assignments so any newly-covered zone takes effect under
-- the B3 ranking (same idempotent SQL mirror as the phase-2 migration: exact
-- ZIP before prefix, then priority, type-appropriateness, longest prefix;
-- polygon-assigned properties skipped; manual overrides preserved).
WITH ranked AS (
  SELECT DISTINCT ON (p.id) p.id AS property_id, z.id AS new_zone_id
  FROM public.properties p
  JOIN public.clients c ON c.id = p.client_id
  JOIN public.zones z ON z.organization_id = p.organization_id
  LEFT JOIN public.zones cur ON cur.id = p.auto_zone_id
  WHERE p.archived_at IS NULL
    AND (btrim(p.postal_code) = ANY (COALESCE(z.zip_codes, '{}'))
         OR (z.postal_prefix IS NOT NULL AND btrim(p.postal_code) LIKE z.postal_prefix || '%'))
    AND (cur.id IS NULL OR cur.geo_match_mode <> 'polygon')
  ORDER BY p.id,
    (btrim(p.postal_code) = ANY (COALESCE(z.zip_codes, '{}'))) DESC,
    z.priority DESC,
    (CASE WHEN z.account_type IS NULL THEN 1
          WHEN z.account_type = COALESCE(p.account_type, c.account_type) THEN 0
          ELSE 2 END),
    length(COALESCE(z.postal_prefix, '')) DESC,
    z.id
)
UPDATE public.properties p
   SET auto_zone_id = r.new_zone_id,
       zone_id = CASE WHEN p.zone_override_reason IS NULL THEN r.new_zone_id ELSE p.zone_id END
  FROM ranked r
 WHERE p.id = r.property_id
   AND (p.auto_zone_id IS DISTINCT FROM r.new_zone_id
        OR (p.zone_override_reason IS NULL AND p.zone_id IS DISTINCT FROM r.new_zone_id));
