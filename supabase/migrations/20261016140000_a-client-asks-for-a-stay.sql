-- Clients request stays; the office confirms the booking and bills it once.
-- Deposits use the quote deposit pattern: an untaxed prepaid top-up invoice.
-- Its payment becomes account credit through the existing payment triggers.
-- Blackout dates are the business's holiday calendar for sitting surcharges.

ALTER TABLE public.stays
  ADD COLUMN IF NOT EXISTS invoice_id uuid REFERENCES public.invoices(id),
  ADD COLUMN IF NOT EXISTS deposit_invoice_id uuid REFERENCES public.invoices(id),
  ADD COLUMN IF NOT EXISTS portal_request_key uuid;
CREATE UNIQUE INDEX IF NOT EXISTS stays_invoice_idx ON public.stays(invoice_id) WHERE invoice_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stays_deposit_invoice_idx ON public.stays(deposit_invoice_id) WHERE deposit_invoice_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stays_request_key_idx ON public.stays(client_id, portal_request_key) WHERE portal_request_key IS NOT NULL;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS notify_email_stay_confirmed boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_email_stay_ending boolean NOT NULL DEFAULT true;
ALTER TABLE public.services ADD COLUMN IF NOT EXISTS holiday_surcharge_pct integer NOT NULL DEFAULT 0;
DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.services'::regclass AND conname = 'services_sitting_holiday_check') THEN
    ALTER TABLE public.services ADD CONSTRAINT services_sitting_holiday_check
      CHECK (holiday_surcharge_pct BETWEEN 0 AND 500 AND (service_line = 'pet_sitting' OR holiday_surcharge_pct = 0));
  END IF;
END
$constraints$;

-- A portal write takes its tenant and client from the verified session.
-- API roles cannot call this function directly. Care changes and the request
-- commit together, and a retried submission returns the same booking.
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
  INSERT INTO public.stays(organization_id, client_id, property_id, service_id, starts_on, ends_on,
    drop_in_windows, overnight_arrival_earliest, overnight_arrival_latest, pet_ids, status, notes, portal_request_key)
  SELECT _org_id, _client_id, (_input->>'propertyId')::uuid, s.id, (_input->>'startsOn')::date, (_input->>'endsOn')::date,
    CASE WHEN s.price_unit <> 'night' THEN _input->'windows' END,
    CASE WHEN s.price_unit = 'night' THEN (_input->>'arrivalEarliest')::time END,
    CASE WHEN s.price_unit = 'night' THEN (_input->>'arrivalLatest')::time END,
    _pets, 'requested', NULLIF(btrim(_input->>'notes'), ''), _request_key
  FROM public.services s WHERE s.id = (_input->>'serviceId')::uuid
  RETURNING id INTO _id;
  -- stays_validate has checked that every selected pet belongs to this home.
  FOR _care IN SELECT value FROM jsonb_array_elements(COALESCE(_input->'care', '[]'::jsonb)) LOOP
    _pet := (_care->>'petId')::uuid;
    IF _pet IS NULL OR NOT (_pet = ANY(_pets)) THEN RAISE EXCEPTION 'Care must be for a pet on this stay.'; END IF;
    INSERT INTO public.pet_care_instructions(pet_id, organization_id, feeding, meds, other_care)
    VALUES (_pet, _org_id, NULLIF(btrim(_care->>'feeding'), ''), COALESCE(_care->'meds', '[]'::jsonb), NULLIF(btrim(_care->>'otherCare'), ''))
    ON CONFLICT (pet_id) DO UPDATE SET feeding = EXCLUDED.feeding, meds = EXCLUDED.meds, other_care = EXCLUDED.other_care;
  END LOOP;
  RETURN _id;
END;
$function$;
REVOKE ALL ON FUNCTION public.portal_request_stay(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_request_stay(uuid, uuid, uuid, jsonb) TO service_role;

-- Internal billing helper. One line per visit links the stay to the normal
-- "already invoiced" mechanism and to revenue by service. No billing-cycle
-- function changes, including for businesses that only remove pet waste.
CREATE OR REPLACE FUNCTION public.invoice_stay(_stay_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _st public.stays%ROWTYPE;
  _svc public.services%ROWTYPE;
  _inv uuid;
  _dep uuid;
  _total integer;
  _today date;
BEGIN
  SELECT * INTO _st FROM public.stays WHERE id = _stay_id FOR UPDATE;
  IF _st.id IS NULL THEN RAISE EXCEPTION 'Stay not found.'; END IF;
  IF _st.invoice_id IS NOT NULL THEN RETURN _st.invoice_id; END IF;
  IF _st.status NOT IN ('requested', 'confirmed') THEN RAISE EXCEPTION 'This stay cannot be invoiced.'; END IF;
  SELECT * INTO _svc FROM public.services WHERE id = _st.service_id;
  IF NOT EXISTS (SELECT 1 FROM public.visits v JOIN public.subscriptions s ON s.id = v.subscription_id WHERE s.stay_id = _st.id) THEN
    RAISE EXCEPTION 'Generate the stay visits before invoicing.';
  END IF;
  INSERT INTO public.invoices(organization_id, client_id, status, kind, issued_at, due_on, period_start, period_end, notes)
  VALUES (_st.organization_id, _st.client_id, 'open', 'postpaid', now(), _st.starts_on, _st.starts_on, _st.ends_on, 'Stay: ' || _svc.name)
  RETURNING id INTO _inv;
  INSERT INTO public.invoice_line_items(invoice_id, visit_id, subscription_id, description, amount_cents)
  SELECT _inv, v.id, s.id, _svc.name || ' on ' || v.scheduled_on::text ||
    CASE WHEN _svc.holiday_surcharge_pct > 0 AND EXISTS (
      SELECT 1 FROM public.blackout_dates b WHERE b.organization_id = _st.organization_id AND b.blackout_on = v.scheduled_on
    ) THEN ' (holiday rate)' ELSE '' END,
    round(COALESCE(v.price_cents, s.price_cents) * (1 + CASE WHEN EXISTS (
      SELECT 1 FROM public.blackout_dates b WHERE b.organization_id = _st.organization_id AND b.blackout_on = v.scheduled_on
    ) THEN _svc.holiday_surcharge_pct ELSE 0 END / 100.0))::integer
  FROM public.visits v JOIN public.subscriptions s ON s.id = v.subscription_id
  WHERE s.stay_id = _st.id ORDER BY v.scheduled_on, s.earliest_time;
  SELECT sum(amount_cents)::integer INTO _total FROM public.invoice_line_items WHERE invoice_id = _inv;
  PERFORM public.set_invoice_totals(_inv, _total);
  IF COALESCE(_st.deposit_cents, 0) > 0 THEN
    IF _st.deposit_cents > _total THEN RAISE EXCEPTION 'The deposit cannot exceed the stay price.'; END IF;
    SELECT (now() AT TIME ZONE COALESCE(o.timezone, 'America/Chicago'))::date INTO _today FROM public.organizations o WHERE o.id = _st.organization_id;
    INSERT INTO public.invoices(organization_id, client_id, status, kind, issued_at, due_on, period_start, period_end, notes)
    VALUES (_st.organization_id, _st.client_id, 'open', 'prepaid_topup', now(), _today, _today, _today,
      'Deposit for ' || _svc.name || '. Paid, it is credited to your account and comes off your stay invoice.') RETURNING id INTO _dep;
    INSERT INTO public.invoice_line_items(invoice_id, description, amount_cents)
    VALUES (_dep, 'Stay deposit: ' || _svc.name, _st.deposit_cents);
    UPDATE public.invoices SET subtotal_cents = _st.deposit_cents, total_cents = _st.deposit_cents,
      tax_rate_bps = 0, tax_cents = 0, tax_label = NULL WHERE id = _dep;
  END IF;
  UPDATE public.stays SET invoice_id = _inv, deposit_invoice_id = _dep WHERE id = _st.id;
  RETURN _inv;
END;
$function$;
REVOKE ALL ON FUNCTION public.invoice_stay(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_stay(uuid) TO service_role;

-- Same sibling-plan model as walk times and S1. The normal generator makes
-- the visits. All writes are in this transaction, including the invoice.
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
     OR _st.kind <> CASE WHEN _svc.price_unit = 'night' THEN 'overnight' ELSE 'drop_in' END THEN
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

-- Keep invoice identity and booked care intact through ordinary API writes.
CREATE OR REPLACE FUNCTION public.tg_stays_invoice_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.status <> 'requested' OR NEW.invoice_id IS NOT NULL OR NEW.deposit_invoice_id IS NOT NULL THEN
        RAISE EXCEPTION 'Confirm the stay through its booking action.';
      END IF;
    ELSE
      IF (NEW.invoice_id, NEW.deposit_invoice_id) IS DISTINCT FROM (OLD.invoice_id, OLD.deposit_invoice_id)
         OR (OLD.status = 'requested' AND NEW.status = 'confirmed') THEN
        RAISE EXCEPTION 'Confirm the stay through its booking action.';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.invoice_id IS NOT NULL AND
    (NEW.pet_ids, NEW.deposit_cents, NEW.care_snapshot, NEW.service_id) IS DISTINCT FROM
    (OLD.pet_ids, OLD.deposit_cents, OLD.care_snapshot, OLD.service_id) THEN
    RAISE EXCEPTION 'Cancel and rebook to change the pets, care or deposit on a billed stay.';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.tg_stays_invoice_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS stays_invoice_guard ON public.stays;
CREATE TRIGGER stays_invoice_guard BEFORE INSERT OR UPDATE ON public.stays FOR EACH ROW EXECUTE FUNCTION public.tg_stays_invoice_guard();

-- Preserve the existing void path, including returning applied credit.
-- Its permission check still applies to a stay that has an unpaid invoice.
CREATE OR REPLACE FUNCTION public.tg_stays_follow()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _today date;
  _inv uuid;
BEGIN
  SELECT (now() AT TIME ZONE COALESCE(o.timezone, 'America/Chicago'))::date INTO _today FROM public.organizations o WHERE o.id = NEW.organization_id;
  _today := COALESCE(_today, CURRENT_DATE);
  IF NEW.status = 'canceled' AND OLD.status <> 'canceled' THEN
    FOR _inv IN SELECT id FROM public.invoices WHERE id IN (NEW.invoice_id, NEW.deposit_invoice_id) AND status NOT IN ('paid', 'void') LOOP
      PERFORM public.void_invoice(_inv);
    END LOOP;
    UPDATE public.visits v SET status = 'canceled'
    WHERE v.subscription_id IN (SELECT s.id FROM public.subscriptions s WHERE s.stay_id = NEW.id)
      AND v.status = 'scheduled' AND v.scheduled_on >= _today;
    UPDATE public.subscriptions s SET status = 'canceled', end_reason = COALESCE(s.end_reason, 'Stay canceled'), ended_by = COALESCE(auth.uid(), s.ended_by)
    WHERE s.stay_id = NEW.id AND s.status <> 'canceled';
    RETURN NULL;
  END IF;
  IF NEW.assigned_staff_id IS DISTINCT FROM OLD.assigned_staff_id AND NEW.status <> 'canceled' THEN
    UPDATE public.visits v SET assigned_staff_id = NEW.assigned_staff_id, sequence = NULL
    WHERE v.subscription_id IN (SELECT s.id FROM public.subscriptions s WHERE s.stay_id = NEW.id)
      AND v.status = 'scheduled' AND v.scheduled_on >= _today;
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.tg_stays_follow() FROM PUBLIC, anon, authenticated;

DO $check$
DECLARE _name text;
BEGIN
  FOREACH _name IN ARRAY ARRAY['invoice_id', 'deposit_invoice_id', 'portal_request_key'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'stays' AND column_name = _name) THEN
      RAISE EXCEPTION 'stays.% is missing', _name;
    END IF;
  END LOOP;
  FOREACH _name IN ARRAY ARRAY['notify_email_stay_confirmed', 'notify_email_stay_ending'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = _name AND column_default = 'true' AND is_nullable = 'NO') THEN
      RAISE EXCEPTION 'organizations.% must default to true', _name;
    END IF;
  END LOOP;
  IF to_regclass('public.stays_request_key_idx') IS NULL OR to_regclass('public.stays_invoice_idx') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.services'::regclass AND conname = 'services_sitting_holiday_check') THEN
    RAISE EXCEPTION 'Stay indexes or the holiday constraint are missing.';
  END IF;
  IF has_function_privilege('anon', 'public.confirm_stay(uuid, integer, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.invoice_stay(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.portal_request_stay(uuid, uuid, uuid, jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.portal_request_stay(uuid, uuid, uuid, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A stay function has unsafe grants.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.stays'::regclass AND tgname = 'stays_invoice_guard' AND tgenabled <> 'D')
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.invoice_stay(uuid)'::regprocedure) NOT LIKE '%visit_id, subscription_id%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.confirm_stay(uuid, integer, integer)'::regprocedure) NOT LIKE '%FOR UPDATE%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.tg_stays_follow()'::regprocedure) NOT LIKE '%public.void_invoice(_inv)%' THEN
    RAISE EXCEPTION 'Stay confirmation, billing or cancellation is incomplete.';
  END IF;
END
$check$;
