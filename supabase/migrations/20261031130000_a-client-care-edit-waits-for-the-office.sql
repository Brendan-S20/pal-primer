-- A client's care edit from the portal waits for the office (#611, R2-03).
--
-- portal_request_stay used to upsert public.pet_care_instructions when the
-- client sent a stay request. That row is the live sitter card, so a dose
-- changed for a December stay changed tonight's card, with nothing to say a
-- client had changed it. Now:
--
--   1. portal_request_stay stages the edit on the request (stays.requested_care)
--      and never writes pet_care_instructions. Only fields that differ from
--      the card are staged; a request with no changes stages nothing.
--   2. confirm_stay applies the staged fields in the same transaction that
--      confirms the stay, for pets still on it, and stamps the care row with
--      client_updated_at and client_updated_stay_id. updated_by is the office
--      person who confirmed, as the row trigger already records.
--   3. A stay that is canceled or never confirmed never applies its staged
--      edit, so the card is untouched.
--   4. An office edit to the care row later clears the client marker.
--
-- Who approves a client edit and when it takes effect are D11. Until then it
-- takes effect at the confirm.

ALTER TABLE public.stays
  ADD COLUMN IF NOT EXISTS requested_care jsonb;
DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.stays'::regclass AND conname = 'stays_requested_care_is_array') THEN
    ALTER TABLE public.stays ADD CONSTRAINT stays_requested_care_is_array
      CHECK (requested_care IS NULL OR jsonb_typeof(requested_care) = 'array');
  END IF;
END
$constraints$;
COMMENT ON COLUMN public.stays.requested_care IS
  'Care changes a client sent with a portal stay request: an array of {pet_id, feeding?, meds?, other_care?}, holding only the fields that differed from the pet''s care when sent. Applied to pet_care_instructions by confirm_stay, never before. Migration 20261031130000 (#611).';

ALTER TABLE public.pet_care_instructions
  ADD COLUMN IF NOT EXISTS client_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS client_updated_stay_id uuid REFERENCES public.stays(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS pet_care_instructions_client_stay_idx
  ON public.pet_care_instructions(client_updated_stay_id) WHERE client_updated_stay_id IS NOT NULL;
COMMENT ON COLUMN public.pet_care_instructions.client_updated_at IS
  'When a client''s portal care edit was applied to this row: the moment the office confirmed the stay it came with. Cleared when the office edits the care. Migration 20261031130000 (#611).';
COMMENT ON COLUMN public.pet_care_instructions.client_updated_stay_id IS
  'The stay request whose care edit was applied. Migration 20261031130000 (#611).';

-- Restated from 20261024080000. The client marker goes when the office
-- changes the care itself, so the card never credits the client with an
-- office edit.
CREATE OR REPLACE FUNCTION public.tg_pet_care_instructions_pet()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _org uuid;
BEGIN
  SELECT d.organization_id INTO _org FROM public.dogs d WHERE d.id = NEW.pet_id;
  IF _org IS NULL THEN
    RAISE EXCEPTION 'That pet was not found.' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.organization_id IS DISTINCT FROM _org THEN
    RAISE EXCEPTION 'That pet belongs to another business.' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW.client_updated_at, NEW.client_updated_stay_id) IS NOT DISTINCT FROM (OLD.client_updated_at, OLD.client_updated_stay_id)
     AND (NEW.feeding, NEW.meds, NEW.other_care) IS DISTINCT FROM (OLD.feeding, OLD.meds, OLD.other_care) THEN
    NEW.client_updated_at := NULL;
    NEW.client_updated_stay_id := NULL;
  END IF;
  NEW.updated_at := now();
  NEW.updated_by := COALESCE(auth.uid(), NEW.updated_by);
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.tg_pet_care_instructions_pet() FROM PUBLIC, anon, authenticated;

-- Restated from 20261024080300. The only change is care: it is checked here
-- and staged on the request instead of written to the card.
CREATE OR REPLACE FUNCTION public.portal_request_stay(_org_id uuid, _client_id uuid, _request_key uuid, _input jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _id uuid;
  _pets uuid[];
  _care jsonb;
  _pet uuid;
  _live public.pet_care_instructions%ROWTYPE;
  _feeding text;
  _meds jsonb;
  _other text;
  _entry jsonb;
  _staged jsonb := '{}'::jsonb;
  _requested jsonb;
BEGIN
  IF _request_key IS NULL THEN RAISE EXCEPTION 'A request key is required.'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('stay-request'), hashtext(_client_id::text || _request_key::text));
  SELECT id INTO _id FROM public.stays
   WHERE client_id = _client_id AND organization_id = _org_id AND portal_request_key = _request_key;
  IF FOUND THEN RETURN _id; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = _org_id AND 'pet_sitting' = ANY(o.service_lines))
     OR NOT EXISTS (SELECT 1 FROM public.clients c WHERE c.id = _client_id AND c.organization_id = _org_id
                     AND c.active AND c.account_type = 'residential') THEN
    RAISE EXCEPTION 'Stay requests are not available for this account.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.services s WHERE s.id = (_input->>'serviceId')::uuid
                  AND s.organization_id = _org_id AND s.active AND s.service_line = 'pet_sitting') THEN
    RAISE EXCEPTION 'Choose a pet sitting service.';
  END IF;
  SELECT array_agg(DISTINCT p::uuid) INTO _pets FROM jsonb_array_elements_text(_input->'petIds') p;
  IF COALESCE(cardinality(_pets), 0) NOT BETWEEN 1 AND 30 THEN RAISE EXCEPTION 'Choose at least one pet.'; END IF;
  IF (_input->>'startsOn')::date < (SELECT (now() AT TIME ZONE COALESCE(o.timezone, 'America/Chicago'))::date FROM public.organizations o WHERE o.id = _org_id)
     OR (_input->>'endsOn')::date - (_input->>'startsOn')::date > 90 THEN
    RAISE EXCEPTION 'Choose future dates, up to 90 days apart.';
  END IF;
  -- Staged, not applied. Checked now against the card's own rules so the
  -- office confirm cannot fail on them later. A later entry for the same pet
  -- replaces an earlier one, as the old upsert did.
  FOR _care IN SELECT value FROM jsonb_array_elements(COALESCE(_input->'care', '[]'::jsonb)) LOOP
    _pet := (_care->>'petId')::uuid;
    IF _pet IS NULL OR NOT (_pet = ANY(_pets)) THEN RAISE EXCEPTION 'Care must be for a pet on this stay.'; END IF;
    _feeding := NULLIF(btrim(_care->>'feeding'), '');
    _meds := COALESCE(_care->'meds', '[]'::jsonb);
    _other := NULLIF(btrim(_care->>'otherCare'), '');
    IF char_length(_feeding) > 500 OR char_length(_other) > 1000
       OR jsonb_typeof(_meds) <> 'array' OR NOT public.pet_meds_are_valid(_meds) THEN
      RAISE EXCEPTION 'Check the care instructions and try again.';
    END IF;
    _live := NULL;
    SELECT * INTO _live FROM public.pet_care_instructions WHERE pet_id = _pet AND organization_id = _org_id;
    _entry := jsonb_build_object('pet_id', _pet);
    IF _feeding IS DISTINCT FROM _live.feeding THEN _entry := _entry || jsonb_build_object('feeding', _feeding); END IF;
    IF _meds IS DISTINCT FROM COALESCE(_live.meds, '[]'::jsonb) THEN _entry := _entry || jsonb_build_object('meds', _meds); END IF;
    IF _other IS DISTINCT FROM _live.other_care THEN _entry := _entry || jsonb_build_object('other_care', _other); END IF;
    _staged := _staged - _pet::text;
    IF _entry <> jsonb_build_object('pet_id', _pet) THEN
      _staged := _staged || jsonb_build_object(_pet::text, _entry);
    END IF;
  END LOOP;
  SELECT jsonb_agg(value ORDER BY key) INTO _requested FROM jsonb_each(_staged);
  INSERT INTO public.stays(organization_id, client_id, property_id, service_id, starts_on, ends_on,
    drop_in_windows, overnight_arrival_earliest, overnight_arrival_latest, pet_ids, status, notes, portal_request_key,
    requested_care)
  SELECT _org_id, _client_id, (_input->>'propertyId')::uuid, s.id, (_input->>'startsOn')::date, (_input->>'endsOn')::date,
    CASE WHEN s.price_unit <> 'night' THEN _input->'windows' END,
    CASE WHEN s.price_unit = 'night' THEN (_input->>'arrivalEarliest')::time END,
    CASE WHEN s.price_unit = 'night' THEN (_input->>'arrivalLatest')::time END,
    _pets, 'requested', NULLIF(btrim(_input->>'notes'), ''), _request_key, _requested
  FROM public.services s WHERE s.id = (_input->>'serviceId')::uuid
  RETURNING id INTO _id;
  RETURN _id;
END;
$function$;
REVOKE ALL ON FUNCTION public.portal_request_stay(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_request_stay(uuid, uuid, uuid, jsonb) TO service_role;

-- Restated from 20261024080300. The only change is the staged care, applied
-- before the care snapshot so the booking records what the sitter will read.
CREATE OR REPLACE FUNCTION public.confirm_stay(_stay_id uuid, _price_cents integer DEFAULT NULL, _deposit_cents integer DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _st public.stays%ROWTYPE;
  _svc public.services%ROWTYPE;
  _price integer;
  _last date;
  _window jsonb;
  _sub uuid;
  _invoice uuid;
  _today date;
  _care jsonb;
  _pet uuid;
  _live public.pet_care_instructions%ROWTYPE;
  _feeding text;
  _meds jsonb;
  _other text;
BEGIN
  SELECT * INTO _st FROM public.stays WHERE id = _stay_id FOR UPDATE;
  IF _st.id IS NULL THEN RAISE EXCEPTION 'Stay not found.'; END IF;
  IF NOT public.has_permission(auth.uid(), _st.organization_id, 'manage_pricing') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF _st.status = 'confirmed' AND _st.invoice_id IS NOT NULL THEN RETURN _st.invoice_id; END IF;
  IF _st.status <> 'requested' THEN RAISE EXCEPTION 'Only a requested stay can be confirmed.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = _st.organization_id AND 'pet_sitting' = ANY(o.service_lines)) THEN
    RAISE EXCEPTION 'This business does not offer pet sitting.';
  END IF;
  SELECT * INTO _svc FROM public.services WHERE id = _st.service_id AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'That service is no longer offered.'; END IF;
  IF _svc.organization_id <> _st.organization_id OR _svc.service_line <> 'pet_sitting'
     OR _st.kind <> (CASE WHEN _svc.price_unit = 'night' THEN 'overnight' ELSE 'drop_in' END) THEN
    RAISE EXCEPTION 'This service has changed. Request the stay again with its current pricing.';
  END IF;
  SELECT (now() AT TIME ZONE COALESCE(o.timezone, 'America/Chicago'))::date INTO _today FROM public.organizations o WHERE o.id = _st.organization_id;
  IF _st.starts_on < _today OR _st.ends_on - _st.starts_on > 90 OR cardinality(_st.pet_ids) < 1 THEN
    RAISE EXCEPTION 'Choose future dates, up to 90 days apart, and at least one pet.';
  END IF;
  IF _deposit_cents IS NOT NULL THEN
    IF _deposit_cents NOT BETWEEN 0 AND 10000000 THEN RAISE EXCEPTION 'Enter a valid deposit.'; END IF;
    UPDATE public.stays SET deposit_cents = _deposit_cents WHERE id = _st.id;
  END IF;
  IF cardinality(_st.pet_ids) <> (SELECT count(DISTINCT p) FROM unnest(_st.pet_ids) p) THEN
    RAISE EXCEPTION 'A pet is listed twice.';
  END IF;
  _price := COALESCE(_price_cents, public.service_price_cents(_svc.price_unit, _svc.base_price_cents,
    _svc.extra_pet_cents, _svc.default_duration_min, cardinality(_st.pet_ids), NULL, 1, 1));
  IF _price IS NULL OR _price NOT BETWEEN 0 AND 10000000 THEN RAISE EXCEPTION 'Set a price for this service before confirming.'; END IF;
  _last := CASE WHEN _st.kind = 'overnight' THEN _st.ends_on - 1 ELSE _st.ends_on END;
  IF _st.kind = 'overnight' AND _st.assigned_staff_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.visits v JOIN public.subscriptions s ON s.id = v.subscription_id JOIN public.stays st ON st.id = s.stay_id
    WHERE v.assigned_staff_id = _st.assigned_staff_id AND st.id <> _st.id AND st.kind = 'overnight'
      AND v.scheduled_on BETWEEN _st.starts_on AND _last AND v.status NOT IN ('canceled', 'skipped', 'missed')
  ) THEN RAISE EXCEPTION 'This sitter already has an overnight stay on one of these nights.'; END IF;
  FOR _window IN SELECT value FROM jsonb_array_elements(CASE WHEN _st.kind = 'overnight' THEN
    jsonb_build_array(jsonb_build_object('earliest', _st.overnight_arrival_earliest, 'latest', _st.overnight_arrival_latest)) ELSE _st.drop_in_windows END)
  LOOP
    INSERT INTO public.subscriptions(organization_id, client_id, property_id, account_type, service_id, stay_id,
      dog_count, frequency, weekdays, price_cents, billing_cadence, status, started_on, ends_on, earliest_time, latest_time, priced_at)
    VALUES (_st.organization_id, _st.client_id, _st.property_id, 'residential', _st.service_id, _st.id,
      cardinality(_st.pet_ids), 'weekly', ARRAY[0,1,2,3,4,5,6], _price, 'postpaid', 'active', _st.starts_on, _last,
      (_window->>'earliest')::time, (_window->>'latest')::time, now()) RETURNING id INTO _sub;
    PERFORM public.generate_visits_core(_st.organization_id, _last, _sub);
  END LOOP;
  -- This also catches the generator leaving a colliding night unassigned.
  IF _st.kind = 'overnight' AND _st.assigned_staff_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.visits v JOIN public.subscriptions s ON s.id = v.subscription_id
    WHERE s.stay_id = _st.id AND v.assigned_staff_id IS DISTINCT FROM _st.assigned_staff_id
  ) THEN RAISE EXCEPTION 'This sitter already has an overnight stay on one of these nights.'; END IF;
  -- The client's staged care (#611): only the fields they changed, only for
  -- pets still on the stay, and only where it still differs from the card.
  -- Effective now, at the confirm. updated_by is the person confirming.
  FOR _care IN SELECT value FROM jsonb_array_elements(COALESCE(_st.requested_care, '[]'::jsonb)) LOOP
    _pet := (_care->>'pet_id')::uuid;
    CONTINUE WHEN _pet IS NULL OR NOT (_pet = ANY(_st.pet_ids));
    _live := NULL;
    SELECT * INTO _live FROM public.pet_care_instructions WHERE pet_id = _pet FOR UPDATE;
    _feeding := CASE WHEN _care ? 'feeding' THEN _care->>'feeding' ELSE _live.feeding END;
    _meds := CASE WHEN _care ? 'meds' THEN COALESCE(_care->'meds', '[]'::jsonb) ELSE COALESCE(_live.meds, '[]'::jsonb) END;
    _other := CASE WHEN _care ? 'other_care' THEN _care->>'other_care' ELSE _live.other_care END;
    CONTINUE WHEN (_feeding, _meds, _other) IS NOT DISTINCT FROM (_live.feeding, COALESCE(_live.meds, '[]'::jsonb), _live.other_care);
    INSERT INTO public.pet_care_instructions(pet_id, organization_id, feeding, meds, other_care, client_updated_at, client_updated_stay_id)
    VALUES (_pet, _st.organization_id, _feeding, _meds, _other, now(), _st.id)
    ON CONFLICT (pet_id) DO UPDATE SET feeding = EXCLUDED.feeding, meds = EXCLUDED.meds, other_care = EXCLUDED.other_care,
      client_updated_at = EXCLUDED.client_updated_at, client_updated_stay_id = EXCLUDED.client_updated_stay_id;
  END LOOP;
  UPDATE public.stays SET care_snapshot = COALESCE((
    SELECT jsonb_agg(jsonb_build_object('pet_id', d.id, 'name', d.name, 'species', d.species, 'species_note', d.species_note,
      'feeding', c.feeding, 'meds', COALESCE(c.meds, '[]'::jsonb), 'other_care', c.other_care) ORDER BY d.id)
    FROM public.dogs d LEFT JOIN public.pet_care_instructions c ON c.pet_id = d.id WHERE d.id = ANY(_st.pet_ids)
  ), '[]'::jsonb) WHERE id = _st.id;
  _invoice := public.invoice_stay(_st.id);
  UPDATE public.stays SET status = 'confirmed' WHERE id = _st.id;
  RETURN _invoice;
END;
$function$;
REVOKE ALL ON FUNCTION public.confirm_stay(uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_stay(uuid, integer, integer) TO authenticated;

DO $check$
DECLARE _name text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'stays' AND column_name = 'requested_care')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.stays'::regclass AND conname = 'stays_requested_care_is_array') THEN
    RAISE EXCEPTION 'stays.requested_care or its check is missing';
  END IF;
  FOREACH _name IN ARRAY ARRAY['client_updated_at', 'client_updated_stay_id'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'pet_care_instructions' AND column_name = _name) THEN
      RAISE EXCEPTION 'pet_care_instructions.% is missing', _name;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.confirm_stay(uuid, integer, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.portal_request_stay(uuid, uuid, uuid, jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.portal_request_stay(uuid, uuid, uuid, jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tg_pet_care_instructions_pet()', 'EXECUTE') THEN
    RAISE EXCEPTION 'A stay or care function has unsafe grants.';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.portal_request_stay(uuid, uuid, uuid, jsonb)'::regprocedure) LIKE '%INSERT INTO public.pet_care_instructions%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.portal_request_stay(uuid, uuid, uuid, jsonb)'::regprocedure) NOT LIKE '%requested_care%' THEN
    RAISE EXCEPTION 'portal_request_stay still writes the live care card.';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.confirm_stay(uuid, integer, integer)'::regprocedure) NOT LIKE '%FOR UPDATE%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.confirm_stay(uuid, integer, integer)'::regprocedure) NOT LIKE '%_st.requested_care%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.tg_pet_care_instructions_pet()'::regprocedure) NOT LIKE '%client_updated_at := NULL%' THEN
    RAISE EXCEPTION 'confirm_stay does not apply staged care, or the care trigger keeps a stale client marker.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.pet_care_instructions'::regclass
                  AND tgname = 'pet_care_instructions_pet' AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'trigger pet_care_instructions_pet is missing or disabled';
  END IF;
END
$check$;
