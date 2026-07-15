-- QA follow-up 1.1: properties created before the zone columns existed (or
-- via the wizard/imports, which never ran detection) have NULL zone ids even
-- when a ZIP-covered zone exists. Backfill zip/prefix matches in SQL with
-- normalized postal codes; exact ZIP beats longest prefix, mirroring the
-- app matcher. Point-based zones (radius/polygon/drive_time) are re-detected
-- by the app on the next property edit.
WITH matches AS (
  SELECT DISTINCT ON (p.id) p.id AS property_id, z.id AS matched_zone_id
  FROM public.properties p
  JOIN public.zones z ON z.organization_id = p.organization_id
  WHERE p.auto_zone_id IS NULL
    AND (
      btrim(p.postal_code) = ANY (COALESCE(z.zip_codes, '{}'))
      OR (z.postal_prefix IS NOT NULL AND btrim(p.postal_code) LIKE z.postal_prefix || '%')
    )
  ORDER BY p.id,
    (btrim(p.postal_code) = ANY (COALESCE(z.zip_codes, '{}'))) DESC,
    length(COALESCE(z.postal_prefix, '')) DESC
)
UPDATE public.properties p
   SET auto_zone_id = m.matched_zone_id,
       zone_id = COALESCE(p.zone_id, m.matched_zone_id)
  FROM matches m
 WHERE p.id = m.property_id;

-- Pre-refactor rows never recorded how their address was entered.
UPDATE public.properties SET address_source = 'manual' WHERE address_source IS NULL;
