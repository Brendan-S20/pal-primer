-- QA round 8 (zone correctness): overlap priority.
--
-- When two zones match an address at the same specificity level (e.g. two
-- polygons both contain the point, or two zones list the same ZIP), the
-- matcher previously picked whichever happened to sort first. `priority`
-- is the explicit tie-breaker: higher priority wins WITHIN a specificity
-- level. Specificity still comes first (polygon > radius/drive-time >
-- exact ZIP > postal prefix, longest prefix last) — priority never lets a
-- prefix match beat an exact ZIP match. Mirrored in src/lib/zone-match.ts.
alter table public.zones
  add column if not exists priority integer not null default 0;

-- Keep the public signup quote's zone selection consistent with the app
-- matcher: exact ZIP beats prefix, then priority (higher wins), then
-- longest prefix. (public_quote is ZIP-only by design — signups have no
-- point or boundary yet, so geo modes and area pricing don't apply here;
-- area-priced zones intentionally fall back to base price until a
-- boundary is sketched.)
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

  SELECT * INTO _zone FROM public.zones
    WHERE organization_id = _org.id
      AND (_postal_code = ANY(zip_codes)
           OR (postal_prefix IS NOT NULL AND _postal_code LIKE postal_prefix || '%'))
    ORDER BY (CASE WHEN _postal_code = ANY(zip_codes) THEN 0 ELSE 1 END),
             priority DESC,
             length(coalesce(postal_prefix,'')) DESC
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
