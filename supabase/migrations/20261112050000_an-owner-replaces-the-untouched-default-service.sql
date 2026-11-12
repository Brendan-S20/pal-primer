-- #883: Add service used to leave the pristine starter beside Weekly scoop.
-- Only a never-edited, unused starter is removed, in the insert transaction.
-- No backfill: saved customer catalogs are never swept or renamed.
CREATE OR REPLACE FUNCTION public.tg_services_replace_untouched_default()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _starter uuid;
  _ref record;
  _used boolean;
BEGIN
  IF NEW.service_line <> 'pet_waste' OR NEW.name = 'Pet waste removal' OR NOT NEW.active THEN
    RETURN NULL;
  END IF;

  -- The org and its starter were created in the same transaction. An edited
  -- row (even renamed back), a manually added lookalike, or a priced starter
  -- is the owner's data. FOR UPDATE also serializes competing inserts and
  -- blocks new FK references while we check whether this row is unused.
  SELECT s.id INTO _starter
    FROM public.services s
    JOIN public.organizations o ON o.id = s.organization_id
   WHERE s.organization_id = NEW.organization_id
     AND s.id <> NEW.id
     AND s.name = 'Pet waste removal' AND s.service_line = 'pet_waste'
     AND s.created_at = o.created_at AND s.updated_at = s.created_at
     AND s.price_unit = 'visit' AND s.base_price_cents IS NULL
     AND s.extra_pet_cents = 0 AND s.default_duration_min IS NULL
     AND s.max_dogs IS NULL AND s.holiday_surcharge_pct = 0
     AND s.public_booking_mode = 'recurring' AND s.public_package_id IS NULL
     AND s.active
   FOR UPDATE OF s;
  IF _starter IS NULL THEN RETURN NULL; END IF;

  -- Check every services FK, including plans (the client reference), visits,
  -- leads, signups and Directory listings. Definer rights are needed so RLS
  -- cannot hide a reference from this check. Identifiers come from pg_catalog.
  FOR _ref IN
    SELECT c.conrelid::regclass AS relation, a.attname AS column_name
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_attribute id_col
        ON id_col.attrelid = c.confrelid AND id_col.attname = 'id'
      JOIN pg_catalog.pg_attribute a
        ON a.attrelid = c.conrelid
       AND a.attnum = c.conkey[array_position(c.confkey, id_col.attnum)]
     WHERE c.contype = 'f' AND c.confrelid = 'public.services'::regclass
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I = $1)',
                   _ref.relation, _ref.column_name) INTO _used USING _starter;
    IF _used THEN RETURN NULL; END IF;
  END LOOP;

  DELETE FROM public.services WHERE id = _starter;
  RETURN NULL;
END;
$function$;

-- Not an API. AFTER INSERT runs only after the ordinary INSERT policy has
-- authorized the new row; a failed insert rolls the entire operation back.
REVOKE ALL ON FUNCTION public.tg_services_replace_untouched_default() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS services_replace_untouched_default ON public.services;
CREATE TRIGGER services_replace_untouched_default
  AFTER INSERT ON public.services
  FOR EACH ROW EXECUTE FUNCTION public.tg_services_replace_untouched_default();

-- now() is constant within a transaction. An edit and a rename-back within
-- the same transaction must still disqualify the starter permanently.
CREATE OR REPLACE FUNCTION public.tg_services_record_edit_time()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.tg_services_record_edit_time() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS services_touch_updated_at ON public.services;
CREATE TRIGGER services_touch_updated_at
  BEFORE UPDATE ON public.services
  FOR EACH ROW EXECUTE FUNCTION public.tg_services_record_edit_time();
