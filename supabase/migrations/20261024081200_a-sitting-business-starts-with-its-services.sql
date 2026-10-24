-- Prepare setup for pet service businesses; this does not open the bookable gate.
CREATE OR REPLACE FUNCTION public.tg_organizations_default_services()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.ensure_default_services(NEW.id);
  IF 'pet_sitting' = ANY(NEW.service_lines) THEN
    INSERT INTO public.services
      (organization_id, name, service_line, price_unit, base_price_cents, default_duration_min, active)
    VALUES
      (NEW.id, 'Drop-in', 'pet_sitting', 'visit', 2500, 30, true),
      (NEW.id, 'Overnight stay', 'pet_sitting', 'night', 7500, NULL, true),
      (NEW.id, 'House sit', 'pet_sitting', 'night', 10000, NULL, true)
    ON CONFLICT (organization_id, lower(name)) DO NOTHING;
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.tg_organizations_default_services() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS organizations_default_services ON public.organizations;
CREATE TRIGGER organizations_default_services
AFTER INSERT OR UPDATE OF service_lines ON public.organizations
FOR EACH ROW EXECUTE FUNCTION public.tg_organizations_default_services();
-- Existing sitting businesses also receive missing starter services, without
-- replacing their prices or reactivating services they switched off.
INSERT INTO public.services
  (organization_id, name, service_line, price_unit, base_price_cents, default_duration_min, active)
SELECT o.id, s.name, 'pet_sitting', s.unit, s.price, s.minutes, true
FROM public.organizations o
CROSS JOIN (VALUES ('Drop-in', 'visit', 2500, 30),
                   ('Overnight stay', 'night', 7500, NULL::integer),
                   ('House sit', 'night', 10000, NULL::integer)) s(name, unit, price, minutes)
WHERE 'pet_sitting' = ANY(o.service_lines)
ON CONFLICT (organization_id, lower(name)) DO NOTHING;
