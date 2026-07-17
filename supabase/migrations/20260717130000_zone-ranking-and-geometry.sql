-- QA round 3 (B3 / C5 / G5): zone ranking correctness + zone hygiene.
--
-- B3: the app matcher previously ranked radius/drive-time containment ABOVE
-- exact-ZIP and prefix matches, so one zone's oversized radius swallowed
-- other zones' home ZIPs (412 Congress, 78701 detected into "Central
-- Austin" instead of "Downtown Commercial"). New ranking, mirrored in
-- src/lib/zone-match.ts:
--   polygon containment > exact ZIP > postal prefix > radius/drive-time,
--   then priority (higher wins) within a level, then type-appropriateness
--   (zone typed for the property's account type > untyped > mismatched),
--   then longest prefix, then id (deterministic).

-- ── 1. Zone names must be real names ────────────────────────────────────────
-- "12" was accepted as a zone name (C5/I11). Repair offending rows (visible,
-- reversible rename — not a silent guess), then constrain. Idempotent: the
-- UPDATE matches nothing once every name passes the check.
UPDATE public.zones
   SET name = 'Zone ' || btrim(name)
 WHERE NOT (name ~ '[A-Za-z]' AND length(btrim(name)) >= 2);

ALTER TABLE public.zones DROP CONSTRAINT IF EXISTS zones_name_meaningful;
ALTER TABLE public.zones ADD CONSTRAINT zones_name_meaningful
  CHECK (name ~ '[A-Za-z]' AND length(btrim(name)) >= 2);

-- ── 2. ZIP-only zones get default map coverage (ZIP centroid + 1 mile) ─────
-- C5: ZIP-only coverage is no longer allowed; creation now requires drawn
-- coverage and existing ZIP-only zones are migrated to a 1-mile radius
-- around the best-known center: the zone's own pin when set, otherwise the
-- centroid of the org's geocoded properties inside the zone's ZIPs/prefix.
-- ZIP matching still applies on top (and outranks the radius), so this adds
-- point-based coverage without changing any ZIP-based assignment.
-- Zones with no derivable center are left untouched: they surface on the
-- Zones page under "no map coverage yet" as the manual-review queue (I5 —
-- ambiguous records are never silently guessed).
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
    AND (z.center_latitude IS NULL OR z.center_longitude IS NULL
         OR (z.radius_meters IS NULL AND z.drive_time_minutes IS NULL))
)
UPDATE public.zones z
   SET geo_match_mode  = 'radius',
       center_latitude  = c.lat,
       center_longitude = c.lng,
       radius_meters    = 1609
  FROM candidates c
 WHERE z.id = c.id AND c.lat IS NOT NULL AND c.lng IS NOT NULL;

-- ── 3. public_quote mirrors the new ranking ────────────────────────────────
-- ZIP levels only by design (signups have no point or boundary yet): exact
-- ZIP beats prefix, then priority, then type-appropriateness (public signup
-- quotes are residential, so residential > untyped > commercial), then
-- longest prefix, then id for determinism.
CREATE OR REPLACE FUNCTION public.public_quote(
  _slug text, _postal_code text, _dog_count integer, _frequency text
)
RETURNS TABLE (
  organization_id uuid, zone_id uuid, zone_name text,
  base_price_cents integer, per_dog_addl_cents integer,
  recurring_price_cents integer, initial_cleanup_cents integer, currency text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org public.organizations;
  _zone public.zones;
  _mult numeric;
  _base_visit_cents integer;
  _recurring integer;
BEGIN
  SELECT * INTO _org FROM public.organizations WHERE slug = _slug AND public_signup_enabled = true;
  IF NOT FOUND THEN RETURN; END IF;

  -- Table alias everywhere: the RETURNS TABLE out-params (organization_id,
  -- zone_id, ...) shadow bare column names inside plpgsql.
  SELECT z.* INTO _zone FROM public.zones z
    WHERE z.organization_id = _org.id
      AND (_postal_code = ANY(z.zip_codes)
           OR (z.postal_prefix IS NOT NULL AND _postal_code LIKE z.postal_prefix || '%'))
    ORDER BY (CASE WHEN _postal_code = ANY(z.zip_codes) THEN 0 ELSE 1 END),
             z.priority DESC,
             (CASE WHEN z.account_type = 'residential' THEN 0
                   WHEN z.account_type IS NULL THEN 1
                   ELSE 2 END),
             length(coalesce(z.postal_prefix,'')) DESC,
             z.id
    LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  _mult := COALESCE((_org.frequency_multipliers ->> _frequency)::numeric, 1.0);
  _base_visit_cents := _zone.base_price_cents + GREATEST(_dog_count - 1, 0) * _zone.per_dog_addl_cents;
  _recurring := round(_base_visit_cents * _mult)::integer;

  organization_id := _org.id;
  zone_id := _zone.id;
  zone_name := _zone.name;
  base_price_cents := _base_visit_cents;
  per_dog_addl_cents := _zone.per_dog_addl_cents;
  recurring_price_cents := _recurring;
  initial_cleanup_cents := _zone.initial_cleanup_cents;
  currency := _org.currency;
  RETURN NEXT;
END;
$$;
GRANT EXECUTE ON FUNCTION public.public_quote(text, text, integer, text) TO anon, authenticated;

-- ── 4. Repair properties assigned by the old ranking (I5) ──────────────────
-- SQL mirror of the ZIP levels of the new matcher: any property with an
-- exact-ZIP or prefix match belongs to the best such zone, because those
-- levels now outrank radius/drive-time. Properties whose current zone uses a
-- polygon are skipped (polygon containment still outranks ZIP and SQL can't
-- test containment here — the app-side redetect re-verifies those on the
-- next zone save or property edit). Manual overrides keep their chosen
-- zone_id; only the detected auto_zone_id is refreshed for them. Idempotent.
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
