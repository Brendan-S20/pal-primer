-- A dispatcher books a stay at the set price (#411, on #616's terms).
--
-- #616 gave the front desk one permission, 'booking', so a dispatcher could
-- book a groom, a visit and a one-off at the business's own price without
-- holding manage_pricing. Stays were left behind: createStay and confirmStay
-- asked for manage_pricing, and confirm_stay checked it itself, so the
-- person the issue names as the one who books a stay ("Dispatcher: books a
-- stay ... assigns one sitter") could neither book one nor confirm a client's
-- request from the portal. They could already change, re-assign and cancel
-- one: change_stay, cancel_stay and the sitter write all check can_write_org.
--
-- This restates confirm_stay with one line changed. The caller needs
-- manage_pricing, as before, OR 'booking' with nothing price-shaped in the
-- call:
--
--   _price_cents     NULL   the visit price is the service's own rule for the
--                           stay's pets (service_price_cents), worked out
--                           here, never by the caller
--   _deposit_cents   NULL   a deposit is a price decision
--   stays.deposit_cents NULL
--                           the stay row is written with the caller's own key
--                           (can_write_org), so a deposit put on the row
--                           before the confirm is refused here too, rather
--                           than invoiced
--
-- Everything else in the body is 20261031130000's verbatim: the lock, the
-- service and date checks, the overnight clash refusal, the plans written
-- through generate_visits_core, the staged care, the snapshot and
-- invoice_stay. The plans are still written only inside this SECURITY
-- DEFINER function; the subscriptions write policy is manage_pricing and is
-- not touched, so a dispatcher still cannot write a plan or a price with
-- their own key.
--
-- Replays into an empty database: it replaces one function that an earlier
-- file in this sequence defines and checks its own body. No row, no tenant,
-- no cron, no measured number.

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
  -- manage_pricing, or booking at the set price (20261109120000).
  IF NOT public.has_permission(auth.uid(), _st.organization_id, 'manage_pricing') THEN
    IF NOT public.has_permission(auth.uid(), _st.organization_id, 'booking') THEN RAISE EXCEPTION 'Not authorized'; END IF;
    IF _price_cents IS NOT NULL OR _deposit_cents IS NOT NULL OR _st.deposit_cents IS NOT NULL THEN
      RAISE EXCEPTION 'Only an owner or office manager can set a stay''s price or deposit.' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
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

COMMENT ON FUNCTION public.confirm_stay(uuid, integer, integer) IS
  'Confirms a requested stay: writes its plans through generate_visits_core, applies the client''s staged care, snapshots care and creates the stay invoice. manage_pricing, or booking with no price or deposit from the caller and none on the row (a dispatcher books at the set price). Migration 20261109120000.';

-- ── What this file establishes, checked from any starting state ───────────
DO $check$
DECLARE _src text;
BEGIN
  SELECT prosrc INTO _src FROM pg_proc WHERE oid = 'public.confirm_stay(uuid, integer, integer)'::regprocedure;
  IF _src NOT LIKE '%''booking''%'
     OR _src NOT LIKE '%_price_cents IS NOT NULL OR _deposit_cents IS NOT NULL OR _st.deposit_cents IS NOT NULL%' THEN
    RAISE EXCEPTION 'confirm_stay does not hold a booking caller to the set price.';
  END IF;
  IF _src NOT LIKE '%FOR UPDATE%' OR _src NOT LIKE '%_st.requested_care%'
     OR _src NOT LIKE '%public.generate_visits_core(_st.organization_id, _last, _sub)%'
     OR _src NOT LIKE '%public.invoice_stay(_st.id)%' THEN
    RAISE EXCEPTION 'confirm_stay lost part of its 20261031130000 body.';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.confirm_stay(uuid, integer, integer)'::regprocedure) THEN
    RAISE EXCEPTION 'confirm_stay is not SECURITY DEFINER.';
  END IF;
  IF has_function_privilege('anon', 'public.confirm_stay(uuid, integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'confirm_stay is executable by anon.';
  END IF;
END
$check$;
