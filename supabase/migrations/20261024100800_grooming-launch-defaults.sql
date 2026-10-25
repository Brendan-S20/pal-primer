-- New businesses get a usable price grid. Never replace an owner's prices.
ALTER TABLE public.organizations ALTER COLUMN groom_buffer_min SET DEFAULT 30;

CREATE OR REPLACE FUNCTION public.tg_org_grooming_defaults()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE _service uuid; _name text; _full boolean;
BEGIN
  IF NOT ('mobile_grooming' = ANY (NEW.service_lines)) THEN RETURN NEW; END IF;
  -- Seed only when grooming is first enabled, not on later settings saves.
  IF TG_OP = 'UPDATE' AND 'mobile_grooming' = ANY (OLD.service_lines) THEN RETURN NEW; END IF;
  FOREACH _name IN ARRAY ARRAY['Full groom (90 min)', 'Bath and tidy (60 min)'] LOOP
    _full := _name = 'Full groom (90 min)';
    INSERT INTO public.services(organization_id, name, service_line, price_unit,
      base_price_cents, extra_pet_cents, default_duration_min, active)
    VALUES (NEW.id, _name, 'mobile_grooming', 'visit', CASE WHEN _full THEN 8000 ELSE 5000 END,
      0, CASE WHEN _full THEN 90 ELSE 60 END, true)
    ON CONFLICT DO NOTHING;
    SELECT id INTO _service FROM public.services
      WHERE organization_id = NEW.id AND name = _name AND service_line = 'mobile_grooming';
    IF _service IS NOT NULL THEN
      INSERT INTO public.service_size_rules(organization_id, service_id, size, duration_min, price_cents)
      SELECT NEW.id, _service, size,
        CASE WHEN _full THEN 90 ELSE 60 END + extra_min,
        CASE WHEN _full THEN 8000 ELSE 5000 END + extra_cents
      FROM (VALUES ('small',0,0),('medium',15,1500),('large',30,3000),('xlarge',60,5000))
        AS sizes(size, extra_min, extra_cents)
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_org_grooming_defaults() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER org_grooming_defaults AFTER INSERT OR UPDATE OF service_lines ON public.organizations
FOR EACH ROW EXECUTE FUNCTION public.tg_org_grooming_defaults();

ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS groom_setup_reviewed_at timestamptz;
