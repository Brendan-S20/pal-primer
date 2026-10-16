-- Training is a service line. Default services for a line are seeded by the
-- app when an owner turns the line on (setServiceLines), never backfilled here,
-- so existing businesses see no new rows.

CREATE OR REPLACE FUNCTION public.service_lines_are_valid(_lines text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN _lines IS NULL THEN false
    WHEN cardinality(_lines) = 0 THEN false
    WHEN array_ndims(_lines) <> 1 THEN false
    ELSE NOT EXISTS (
           SELECT 1 FROM unnest(_lines) AS l(line)
            WHERE line IS NULL
               OR line NOT IN ('pet_waste', 'dog_walking', 'pet_sitting', 'mobile_grooming', 'training', 'other')
         )
     AND (SELECT count(DISTINCT line) FROM unnest(_lines) AS l(line)) = cardinality(_lines)
  END;
$function$;

REVOKE ALL ON FUNCTION public.service_lines_are_valid(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.service_lines_are_valid(text[]) TO authenticated, service_role;

ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_service_lines_valid;
ALTER TABLE public.organizations ADD CONSTRAINT organizations_service_lines_valid
  CHECK (public.service_lines_are_valid(service_lines));

COMMENT ON COLUMN public.organizations.service_lines IS
  'Owner-set: which route-based pet services this business runs (pet_waste, dog_walking, pet_sitting, mobile_grooming, training, other). Read for rendering only: without pet_waste, the waste log, dump sites, stations/DNA, yard outline, area pricing, first cleanup, deep clean and re-clean screens are hidden from THIS ORG''S STAFF. Never gates a write and never deletes data.';

ALTER TABLE public.services DROP CONSTRAINT IF EXISTS services_service_line_check;
ALTER TABLE public.services ADD CONSTRAINT services_service_line_check
  CHECK (service_line IN ('pet_waste', 'dog_walking', 'pet_sitting', 'mobile_grooming', 'training', 'other'));

CREATE OR REPLACE FUNCTION public.public_services(_slug text)
RETURNS TABLE(
  id uuid,
  name text,
  service_line text,
  price_unit text,
  base_price_cents integer,
  extra_pet_cents integer,
  default_duration_min integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _org public.organizations;
BEGIN
  SELECT * INTO _org FROM public.organizations o
    WHERE (o.portal_slug = _slug OR o.slug = _slug)
      AND o.public_signup_enabled = true
      AND o.deleted_at IS NULL
    ORDER BY (o.portal_slug = _slug) DESC NULLS LAST
    LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY
    SELECT s.id, s.name, s.service_line, s.price_unit,
           s.base_price_cents, s.extra_pet_cents, s.default_duration_min::integer
      FROM public.services s
     WHERE s.organization_id = _org.id
       AND s.active
       AND (s.service_line = 'pet_waste' OR s.base_price_cents IS NOT NULL)
     ORDER BY array_position(ARRAY['pet_waste','dog_walking','pet_sitting','mobile_grooming','training','other'], s.service_line),
              lower(s.name),
              s.id;
END;
$$;

REVOKE ALL ON FUNCTION public.public_services(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_services(text) TO anon, authenticated, service_role;

DO $post$
BEGIN
  IF NOT public.service_lines_are_valid('{training}')
     OR NOT public.service_lines_are_valid('{pet_waste,dog_walking,pet_sitting,mobile_grooming,training}') THEN
    RAISE EXCEPTION 'service_lines_are_valid refuses training';
  END IF;

  IF public.service_lines_are_valid('{training,training}')
     OR public.service_lines_are_valid('{boarding}') THEN
    RAISE EXCEPTION 'service_lines_are_valid accepts an invalid training set';
  END IF;

END
$post$;
