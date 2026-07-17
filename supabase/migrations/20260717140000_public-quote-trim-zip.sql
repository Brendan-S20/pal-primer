-- QA round 3 phase 2 review fix: normalize the ZIP inside public_quote so the
-- RPC is the single source of truth for ZIP matching (I3). The TS matcher
-- trims (zone-match.ts) and the assignment repair used btrim, but the live
-- RPC compared _postal_code raw, so a padded ZIP from an untrimmed caller
-- (e.g. the AI receptionist) silently returned "no service." Trimming here
-- fixes every caller at once regardless of client-side normalization.
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
  _zip text := btrim(coalesce(_postal_code, ''));
BEGIN
  SELECT * INTO _org FROM public.organizations WHERE slug = _slug AND public_signup_enabled = true;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT z.* INTO _zone FROM public.zones z
    WHERE z.organization_id = _org.id
      AND (_zip = ANY(z.zip_codes)
           OR (z.postal_prefix IS NOT NULL AND _zip LIKE z.postal_prefix || '%'))
    ORDER BY (CASE WHEN _zip = ANY(z.zip_codes) THEN 0 ELSE 1 END),
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
