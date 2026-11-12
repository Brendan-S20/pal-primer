-- Execute after the migration. Transactional: leaves no businesses or tables.
\set ON_ERROR_STOP on
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;
BEGIN;
\i :migration
SET LOCAL app.allow_protected_org_write = '1';
-- A FK reference stands for a client plan, a visit, or another service consumer.
-- The trigger discovers it from pg_constraint, just like the production FKs.
CREATE TABLE public.service_reference_proof (service_id uuid REFERENCES public.services(id));
DO $proof$
DECLARE
  _org uuid;
  _starter uuid;
  _case text;
  _count integer;
  _other uuid := gen_random_uuid();
  _other_starter uuid;
  _saved jsonb;
BEGIN
  INSERT INTO public.organizations (id, name, service_lines)
  VALUES (_other, 'Default service proof other business', '{pet_waste}');
  SELECT id INTO STRICT _other_starter FROM public.services WHERE organization_id = _other;
  FOREACH _case IN ARRAY ARRAY['untouched', 'one_time_first', 'renamed', 'renamed_back', 'price',
      'duration', 'extra_pet', 'booking', 'inactive', 'noop_edit', 'reference', 'other_line', 'other_org', 'failed_insert']
  LOOP
    _org := gen_random_uuid();
    INSERT INTO public.organizations (id, name, service_lines)
    VALUES (_org, 'Default service proof ' || _case, '{pet_waste}');
    SELECT id INTO STRICT _starter FROM public.services
      WHERE organization_id = _org AND name = 'Pet waste removal';
    CASE _case
      WHEN 'renamed' THEN UPDATE public.services SET name = 'My saved cleanup' WHERE id = _starter;
      WHEN 'renamed_back' THEN
        UPDATE public.services SET name = 'Custom cleanup' WHERE id = _starter;
        UPDATE public.services SET name = 'Pet waste removal' WHERE id = _starter;
      WHEN 'price' THEN UPDATE public.services SET base_price_cents = 2500 WHERE id = _starter;
      WHEN 'duration' THEN UPDATE public.services SET default_duration_min = 20 WHERE id = _starter;
      WHEN 'extra_pet' THEN UPDATE public.services SET extra_pet_cents = 500 WHERE id = _starter;
      WHEN 'booking' THEN UPDATE public.services SET public_booking_mode = 'one_time' WHERE id = _starter;
      WHEN 'inactive' THEN UPDATE public.services SET active = false WHERE id = _starter;
      WHEN 'noop_edit' THEN UPDATE public.services SET name = name WHERE id = _starter;
      WHEN 'reference' THEN INSERT INTO service_reference_proof VALUES (_starter);
      ELSE NULL;
    END CASE;
    SELECT to_jsonb(s) INTO _saved FROM public.services s WHERE id = _starter;
    IF _case = 'failed_insert' THEN
      BEGIN
        INSERT INTO public.services (organization_id, name, service_line, price_unit, base_price_cents)
        VALUES (_org, 'Weekly scoop', 'pet_waste', 'visit', -1);
        RAISE EXCEPTION 'invalid insert unexpectedly succeeded';
      EXCEPTION WHEN check_violation THEN NULL;
      END;
    ELSE
      INSERT INTO public.services (organization_id, name, service_line, price_unit, default_duration_min)
      VALUES (_org, CASE WHEN _case = 'one_time_first' THEN 'One-time cleanup' ELSE 'Weekly scoop' END, CASE WHEN _case = 'other_line' THEN 'dog_walking' ELSE 'pet_waste' END,
              'visit', 30);
    END IF;
    IF _case IN ('untouched', 'one_time_first', 'other_org') THEN
      IF EXISTS (SELECT 1 FROM public.services WHERE id = _starter) THEN
        RAISE EXCEPTION 'pristine starter was left beside Weekly scoop: %', _case;
      END IF;
      INSERT INTO public.services (organization_id, name, service_line)
      VALUES (_org, CASE WHEN _case = 'one_time_first' THEN 'Weekly scoop' ELSE 'One-time cleanup' END, 'pet_waste');
      SELECT count(*) INTO _count FROM public.services WHERE organization_id = _org;
      IF _count <> 2 THEN RAISE EXCEPTION 'owner services not preserved: %', _count; END IF;
      -- The existing DB default resolver must reuse the owner's service.
      PERFORM public.ensure_default_services(_org);
      IF EXISTS (SELECT 1 FROM public.services WHERE organization_id = _org AND name = 'Pet waste removal') THEN
        RAISE EXCEPTION 'default was reseeded';
      END IF;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM public.services WHERE id = _starter) THEN
        RAISE EXCEPTION 'saved or referenced starter removed: %', _case;
      END IF;
      IF (SELECT to_jsonb(s) FROM public.services s WHERE id = _starter) IS DISTINCT FROM _saved THEN
        RAISE EXCEPTION 'saved starter changed: %', _case;
      END IF;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.services WHERE id = _other_starter) THEN
    RAISE EXCEPTION 'another business lost its starter';
  END IF;
  -- A manually added lookalike is not a starter.
  DELETE FROM public.services WHERE organization_id = _other;
  INSERT INTO public.services (organization_id, name, service_line, created_at, updated_at)
  VALUES (_other, 'Pet waste removal', 'pet_waste', now() + interval '1 second', now() + interval '1 second')
  RETURNING id INTO _other_starter;
  INSERT INTO public.services (organization_id, name, service_line)
  VALUES (_other, 'Weekly scoop', 'pet_waste');
  IF NOT EXISTS (SELECT 1 FROM public.services WHERE id = _other_starter) THEN
    RAISE EXCEPTION 'manually added lookalike removed';
  END IF;
END;
$proof$;
ROLLBACK;
