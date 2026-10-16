-- A confirmed stay can change, and canceling one keeps the nights worked
-- (#411 review, blocker 1).
--
-- A delayed flight home is the most common change a sitter gets. Until this
-- file a stay's dates were fixed (tg_stays_validate) and its pets were fixed
-- once billed (tg_stays_invoice_guard), so the office had to cancel and
-- rebook. Canceling voided the whole unpaid invoice, nights already worked
-- included, and a paid invoice kept the canceled nights with no credit.
--
-- ── WHAT CHANGES ─────────────────────────────────────────────────────────
--
-- change_stay(_stay_id, _ends_on, _starts_on, _pet_ids) is the one path. The
-- office (can_write_org) moves the end date either way, moves the start date
-- while the stay has not started, and adds or removes pets. It sets a
-- transaction-local setting, houndstack.stay_change, to the stay's id, and
-- the two guards let the dates and pets through only when it is set to that
-- stay. A request through the API cannot set it: PostgREST runs one
-- transaction per request and exposes no function that calls set_config, so
-- a direct UPDATE of a stay's dates or pets is refused as before.
--
-- Visits follow the new dates. Scheduled visits from today on that fall
-- outside them are canceled. Days the stay gained get visits from the
-- generator, or the canceled visit on that day comes back. Completed visits
-- are never touched. A stay cannot end before a visit already started or
-- done, or before yesterday.
--
-- A pet change moves the plan price by the service's own difference between
-- the old and new pet count, so a price the office typed at booking keeps its
-- offset. Visits already worked are priced first (visits.price_cents), so
-- the new price only reaches nights still to come.
--
-- ── BILLING: restate_stay_billing ────────────────────────────────────────
--
-- Run after a change and after a cancel. Invoice lines are never negative
-- (invoice_line_items.amount_cents >= 0), so a credit is account credit
-- through post_credit_entry, the same ledger every other credit uses.
--
--   Stay invoice still open or draft: its lines are rewritten. Canceled
--   nights come off, nights to come take the current price, new nights are
--   added. With no lines left it is voided (the old cancel behavior, credit
--   applied returned by void_invoice). Credit applied beyond the new total is
--   returned the same way void_invoice returns it.
--
--   Stay invoice paid (or uncollectible): it is left alone. New nights go on
--   a new open invoice, one line per visit. Any other difference is a line
--   on that invoice (more pets) or account credit, tax included (fewer nights
--   or pets). stays.credited_cents keeps the running credit before tax, so a
--   second change is measured from what the client was actually billed.
--
-- Not changed here: the deposit rule (review item 5) and the holiday list
-- (item 6). A canceled stay's unpaid deposit is still voided.
--
-- Replays into an empty database: one column, functions and triggers. No row
-- is needed and no number is asserted.

-- ── 1. What the client has been credited ─────────────────────────────────

ALTER TABLE public.stays ADD COLUMN IF NOT EXISTS credited_cents integer NOT NULL DEFAULT 0;
DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.stays'::regclass AND conname = 'stays_credited_check') THEN
    ALTER TABLE public.stays ADD CONSTRAINT stays_credited_check CHECK (credited_cents >= 0);
  END IF;
END
$constraints$;

COMMENT ON COLUMN public.stays.credited_cents IS
  'Account credit given for nights or pets removed after the stay invoice was paid, before tax. Written by restate_stay_billing only. Migration 20261017000000.';

-- ── 2. One stay visit as the invoice bills it ────────────────────────────

-- The same description and amount invoice_stay writes: the visit's frozen
-- price or its plan's, plus the holiday percentage on a blackout date.
CREATE OR REPLACE FUNCTION public.stay_visit_bill(_visit_id uuid)
RETURNS TABLE (description text, amount_cents integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT sv.name || ' on ' || v.scheduled_on::text ||
           CASE WHEN sv.holiday_surcharge_pct > 0 AND h.holiday THEN ' (holiday rate)' ELSE '' END,
         round(COALESCE(v.price_cents, s.price_cents)
               * (1 + CASE WHEN h.holiday THEN sv.holiday_surcharge_pct ELSE 0 END / 100.0))::integer
    FROM public.visits v
    JOIN public.subscriptions s ON s.id = v.subscription_id
    JOIN public.stays st ON st.id = s.stay_id
    JOIN public.services sv ON sv.id = st.service_id
    CROSS JOIN LATERAL (
      SELECT EXISTS (SELECT 1 FROM public.blackout_dates b
                      WHERE b.organization_id = v.organization_id AND b.blackout_on = v.scheduled_on) AS holiday
    ) h
   WHERE v.id = _visit_id;
$function$;

REVOKE ALL ON FUNCTION public.stay_visit_bill(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stay_visit_bill(uuid) TO service_role;

-- ── 3. The invoice follows the visits ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.restate_stay_billing(_stay_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _st public.stays%ROWTYPE;
  _inv public.invoices%ROWTYPE;
  _svc_name text;
  _today date;
  _total integer;
  _billed integer;
  _wanted integer;
  _added integer;
  _rest integer;
  _credit integer;
  _new uuid;
  _sub uuid;
BEGIN
  SELECT * INTO _st FROM public.stays WHERE id = _stay_id;
  IF _st.id IS NULL OR _st.invoice_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO _inv FROM public.invoices WHERE id = _st.invoice_id FOR UPDATE;
  IF _inv.id IS NULL OR _inv.status = 'void' THEN RETURN NULL; END IF;
  SELECT name INTO _svc_name FROM public.services WHERE id = _st.service_id;
  SELECT (now() AT TIME ZONE COALESCE(o.timezone, 'America/Chicago'))::date INTO _today
    FROM public.organizations o WHERE o.id = _st.organization_id;
  _today := COALESCE(_today, CURRENT_DATE);

  IF _inv.status IN ('draft', 'open') THEN
    DELETE FROM public.invoice_line_items li
     USING public.visits v
     WHERE li.invoice_id = _inv.id AND li.visit_id = v.id AND v.status = 'canceled';
    UPDATE public.invoice_line_items li
       SET description = b.description, amount_cents = b.amount_cents
      FROM public.visits v
      CROSS JOIN LATERAL public.stay_visit_bill(v.id) b
     WHERE li.invoice_id = _inv.id AND li.visit_id = v.id
       AND v.status = 'scheduled' AND v.scheduled_on >= _today
       AND (li.description, li.amount_cents) IS DISTINCT FROM (b.description, b.amount_cents);
    INSERT INTO public.invoice_line_items(invoice_id, visit_id, subscription_id, description, amount_cents)
    SELECT _inv.id, v.id, s.id, b.description, b.amount_cents
      FROM public.visits v
      JOIN public.subscriptions s ON s.id = v.subscription_id
      CROSS JOIN LATERAL public.stay_visit_bill(v.id) b
     WHERE s.stay_id = _st.id AND v.status <> 'canceled'
       AND NOT EXISTS (SELECT 1 FROM public.invoice_line_items li WHERE li.visit_id = v.id)
     ORDER BY v.scheduled_on, s.earliest_time;

    IF NOT EXISTS (SELECT 1 FROM public.invoice_line_items WHERE invoice_id = _inv.id) THEN
      PERFORM public.void_invoice(_inv.id);
      RETURN NULL;
    END IF;
    SELECT sum(amount_cents)::integer INTO _total FROM public.invoice_line_items WHERE invoice_id = _inv.id;
    PERFORM public.set_invoice_totals(_inv.id, _total);
    SELECT total_cents INTO _total FROM public.invoices WHERE id = _inv.id;
    -- Credit applied beyond the new total goes back, as void_invoice does it.
    IF COALESCE(_inv.credit_applied_cents, 0) > _total THEN
      PERFORM pg_advisory_xact_lock(hashtext('credit-apply:' || _inv.id::text));
      PERFORM public.post_credit_entry(
        _inv.organization_id, _inv.client_id, _inv.credit_applied_cents - _total, 'invoice_application',
        _inv.id, NULL, 'Returned from changed stay invoice #' || left(_inv.id::text, 8));
      UPDATE public.invoices
         SET credit_applied_cents = _total,
             status = 'paid', paid_at = COALESCE(paid_at, now()), updated_at = now()
       WHERE id = _inv.id;
    END IF;
    RETURN NULL;
  END IF;

  -- Paid: the invoice stays as it is. Measure what the client was billed for
  -- this stay against what its visits are worth now.
  SELECT COALESCE(sum(li.amount_cents), 0)::integer INTO _billed
    FROM public.invoice_line_items li
    JOIN public.invoices i ON i.id = li.invoice_id
   WHERE li.subscription_id IN (SELECT s.id FROM public.subscriptions s WHERE s.stay_id = _st.id)
     AND i.status <> 'void';
  _billed := _billed - _st.credited_cents;
  SELECT COALESCE(sum(b.amount_cents), 0)::integer INTO _wanted
    FROM public.visits v
    JOIN public.subscriptions s ON s.id = v.subscription_id
    CROSS JOIN LATERAL public.stay_visit_bill(v.id) b
   WHERE s.stay_id = _st.id AND v.status <> 'canceled';
  SELECT COALESCE(sum(b.amount_cents), 0)::integer INTO _added
    FROM public.visits v
    JOIN public.subscriptions s ON s.id = v.subscription_id
    CROSS JOIN LATERAL public.stay_visit_bill(v.id) b
   WHERE s.stay_id = _st.id AND v.status <> 'canceled'
     AND NOT EXISTS (SELECT 1 FROM public.invoice_line_items li WHERE li.visit_id = v.id);
  _rest := _wanted - _billed - _added;

  IF _added > 0 OR _rest > 0 THEN
    INSERT INTO public.invoices(organization_id, client_id, status, kind, issued_at, due_on, period_start, period_end, notes)
    VALUES (_st.organization_id, _st.client_id, 'open', 'postpaid', now(), _today, _st.starts_on, _st.ends_on,
            'Stay change: ' || COALESCE(_svc_name, 'pet sitting'))
    RETURNING id INTO _new;
    INSERT INTO public.invoice_line_items(invoice_id, visit_id, subscription_id, description, amount_cents)
    SELECT _new, v.id, s.id, b.description, b.amount_cents
      FROM public.visits v
      JOIN public.subscriptions s ON s.id = v.subscription_id
      CROSS JOIN LATERAL public.stay_visit_bill(v.id) b
     WHERE s.stay_id = _st.id AND v.status <> 'canceled'
       AND NOT EXISTS (SELECT 1 FROM public.invoice_line_items li WHERE li.visit_id = v.id)
     ORDER BY v.scheduled_on, s.earliest_time;
    IF _rest > 0 THEN
      SELECT id INTO _sub FROM public.subscriptions WHERE stay_id = _st.id ORDER BY earliest_time NULLS LAST, id LIMIT 1;
      INSERT INTO public.invoice_line_items(invoice_id, subscription_id, description, amount_cents)
      VALUES (_new, _sub, 'Pets added to the stay', _rest);
    END IF;
    SELECT sum(amount_cents)::integer INTO _total FROM public.invoice_line_items WHERE invoice_id = _new;
    PERFORM public.set_invoice_totals(_new, _total);
  END IF;

  IF _rest < 0 THEN
    _credit := -_rest + public.sales_tax_cents(-_rest, COALESCE(_inv.tax_rate_bps, 0));
    PERFORM public.post_credit_entry(
      _st.organization_id, _st.client_id, _credit, 'adjustment', _inv.id, NULL,
      'Stay change: nights or pets removed from invoice #' || left(_inv.id::text, 8));
    UPDATE public.stays SET credited_cents = credited_cents - _rest WHERE id = _st.id;
  END IF;
  RETURN _new;
END;
$function$;

REVOKE ALL ON FUNCTION public.restate_stay_billing(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restate_stay_billing(uuid) TO service_role;

COMMENT ON FUNCTION public.restate_stay_billing(uuid) IS
  'Brings a stay''s billing in line with its visits after a change or a cancel. Unpaid stay invoice: lines rewritten (voided when none remain). Paid: new nights and extra pets on a new invoice, removed ones as account credit. Returns the new invoice, or NULL. Migration 20261017000000.';

-- ── 4. The guards let change_stay through, and only it ───────────────────

CREATE OR REPLACE FUNCTION public.tg_stays_validate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _line text;
  _unit text;
  _svc_org uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.clients c
                  WHERE c.id = NEW.client_id AND c.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'That client was not found.' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.properties p
                  WHERE p.id = NEW.property_id AND p.client_id = NEW.client_id
                    AND p.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'That property does not belong to this client.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT s.service_line, s.price_unit, s.organization_id INTO _line, _unit, _svc_org
    FROM public.services s WHERE s.id = NEW.service_id;
  IF _svc_org IS DISTINCT FROM NEW.organization_id OR _line IS DISTINCT FROM 'pet_sitting' THEN
    RAISE EXCEPTION 'Choose a pet sitting service.' USING ERRCODE = 'check_violation';
  END IF;
  NEW.kind := CASE WHEN _unit = 'night' THEN 'overnight' ELSE 'drop_in' END;

  IF NEW.kind = 'overnight' THEN
    NEW.overnight_arrival_earliest := COALESCE(NEW.overnight_arrival_earliest, '19:00'::time);
    NEW.overnight_arrival_latest := COALESCE(NEW.overnight_arrival_latest, '21:00'::time);
    IF NEW.ends_on <= NEW.starts_on THEN
      RAISE EXCEPTION 'An overnight stay checks out at least one day after it checks in.'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.drop_in_windows IS NULL OR NOT public.stay_windows_are_valid(NEW.drop_in_windows) THEN
    RAISE EXCEPTION 'Set one to four drop-in times, each with an earliest and latest arrival.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.assigned_staff_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.staff s
     WHERE s.id = NEW.assigned_staff_id AND s.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Choose a sitter from this business.' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(NEW.pet_ids) AS p(id)
     WHERE NOT EXISTS (SELECT 1 FROM public.dogs d
                        WHERE d.id = p.id AND d.property_id = NEW.property_id
                          AND d.organization_id = NEW.organization_id)
  ) THEN
    RAISE EXCEPTION 'Every pet on a stay has to live at its property.' USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'canceled' AND NEW.status <> 'canceled' THEN
      RAISE EXCEPTION 'A canceled stay cannot be reopened. Book a new one.' USING ERRCODE = 'check_violation';
    END IF;
    -- Its plans already carry these; changing them here would leave the
    -- visits saying something else. change_stay moves the dates and the
    -- plans together, so the dates may move inside it.
    IF (NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.client_id IS DISTINCT FROM OLD.client_id
        OR NEW.property_id IS DISTINCT FROM OLD.property_id
        OR NEW.service_id IS DISTINCT FROM OLD.service_id
        OR NEW.drop_in_windows IS DISTINCT FROM OLD.drop_in_windows
        OR NEW.overnight_arrival_earliest IS DISTINCT FROM OLD.overnight_arrival_earliest
        OR NEW.overnight_arrival_latest IS DISTINCT FROM OLD.overnight_arrival_latest
        OR ((NEW.starts_on IS DISTINCT FROM OLD.starts_on OR NEW.ends_on IS DISTINCT FROM OLD.ends_on)
            AND current_setting('houndstack.stay_change', true) IS DISTINCT FROM OLD.id::text))
       AND EXISTS (SELECT 1 FROM public.subscriptions s WHERE s.stay_id = OLD.id) THEN
      RAISE EXCEPTION 'Change a stay''s dates or pets with Change dates or pets. To change its times or service, cancel it and book a new one.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_stays_validate() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.tg_stays_invoice_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.status <> 'requested' OR NEW.invoice_id IS NOT NULL OR NEW.deposit_invoice_id IS NOT NULL
         OR NEW.credited_cents <> 0 THEN
        RAISE EXCEPTION 'Confirm the stay through its booking action.';
      END IF;
    ELSE
      IF (NEW.invoice_id, NEW.deposit_invoice_id, NEW.credited_cents)
           IS DISTINCT FROM (OLD.invoice_id, OLD.deposit_invoice_id, OLD.credited_cents)
         OR (OLD.status = 'requested' AND NEW.status = 'confirmed') THEN
        RAISE EXCEPTION 'Confirm the stay through its booking action.';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.invoice_id IS NOT NULL AND (
       (NEW.deposit_cents, NEW.service_id) IS DISTINCT FROM (OLD.deposit_cents, OLD.service_id)
       OR ((NEW.pet_ids, NEW.care_snapshot) IS DISTINCT FROM (OLD.pet_ids, OLD.care_snapshot)
           AND current_setting('houndstack.stay_change', true) IS DISTINCT FROM OLD.id::text)) THEN
    RAISE EXCEPTION 'Change the pets with Change dates or pets. To change the care or deposit on a billed stay, cancel and rebook.';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_stays_invoice_guard() FROM PUBLIC, anon, authenticated;

-- ── 5. Canceling keeps the nights worked ─────────────────────────────────

CREATE OR REPLACE FUNCTION public.tg_stays_follow()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _today date;
BEGIN
  SELECT (now() AT TIME ZONE COALESCE(o.timezone, 'America/Chicago'))::date INTO _today FROM public.organizations o WHERE o.id = NEW.organization_id;
  _today := COALESCE(_today, CURRENT_DATE);
  IF NEW.status = 'canceled' AND OLD.status <> 'canceled' THEN
    UPDATE public.visits v SET status = 'canceled'
    WHERE v.subscription_id IN (SELECT s.id FROM public.subscriptions s WHERE s.stay_id = NEW.id)
      AND v.status = 'scheduled' AND v.scheduled_on >= _today;
    UPDATE public.subscriptions s SET status = 'canceled', end_reason = COALESCE(s.end_reason, 'Stay canceled'), ended_by = COALESCE(auth.uid(), s.ended_by)
    WHERE s.stay_id = NEW.id AND s.status <> 'canceled';
    IF EXISTS (SELECT 1 FROM public.invoices WHERE id = NEW.deposit_invoice_id AND status NOT IN ('paid', 'void')) THEN
      PERFORM public.void_invoice(NEW.deposit_invoice_id);
    END IF;
    -- Only the canceled nights come off, or are credited once paid. With
    -- nothing worked the unpaid invoice is voided, as before.
    PERFORM public.restate_stay_billing(NEW.id);
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

-- ── 6. The office changes a stay ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.change_stay(
  _stay_id uuid,
  _ends_on date,
  _starts_on date DEFAULT NULL,
  _pet_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _st public.stays%ROWTYPE;
  _svc public.services%ROWTYPE;
  _today date;
  _start date;
  _end date;
  _pets uuid[];
  _last date;
  _old_last date;
  _worked_last date;
  _old_price integer;
  _price integer;
  _old_rule integer;
  _new_rule integer;
  _sub uuid;
  _n integer;
  _added integer := 0;
  _canceled integer := 0;
  _new_invoice uuid;
BEGIN
  SELECT * INTO _st FROM public.stays WHERE id = _stay_id FOR UPDATE;
  IF _st.id IS NULL THEN RAISE EXCEPTION 'Stay not found.'; END IF;
  IF NOT public.can_write_org(auth.uid(), _st.organization_id) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF _st.status <> 'confirmed' OR _st.invoice_id IS NULL THEN
    RAISE EXCEPTION 'Only a confirmed stay can be changed.';
  END IF;
  SELECT * INTO _svc FROM public.services WHERE id = _st.service_id;
  SELECT (now() AT TIME ZONE COALESCE(o.timezone, 'America/Chicago'))::date INTO _today
    FROM public.organizations o WHERE o.id = _st.organization_id;
  _today := COALESCE(_today, CURRENT_DATE);

  _start := COALESCE(_starts_on, _st.starts_on);
  _end := COALESCE(_ends_on, _st.ends_on);
  _pets := _st.pet_ids;
  IF _pet_ids IS NOT NULL THEN
    _pets := ARRAY(SELECT DISTINCT p FROM unnest(_pet_ids) AS p WHERE p IS NOT NULL);
    -- The same pets in another order are no change.
    IF _pets @> _st.pet_ids AND _pets <@ _st.pet_ids THEN _pets := _st.pet_ids; END IF;
  END IF;
  IF cardinality(_pets) NOT BETWEEN 1 AND 30 THEN RAISE EXCEPTION 'Choose at least one pet.'; END IF;

  IF _start IS DISTINCT FROM _st.starts_on THEN
    IF _st.starts_on < _today OR EXISTS (
      SELECT 1 FROM public.visits v JOIN public.subscriptions s ON s.id = v.subscription_id
       WHERE s.stay_id = _st.id AND v.status IN ('in_progress', 'completed', 'skipped', 'missed')
    ) THEN
      RAISE EXCEPTION 'This stay has started. Only its end date can move.';
    END IF;
    IF _start < _today THEN RAISE EXCEPTION 'Choose a first day from today on.'; END IF;
  END IF;
  IF _st.kind = 'overnight' AND _end <= _start THEN
    RAISE EXCEPTION 'Check-out has to be at least one day after check-in.';
  END IF;
  IF _end < _start THEN RAISE EXCEPTION 'The last day can''t be before the first day.'; END IF;
  IF _end - _start > 90 THEN RAISE EXCEPTION 'A stay is up to 90 days.'; END IF;

  _last := CASE WHEN _st.kind = 'overnight' THEN _end - 1 ELSE _end END;
  _old_last := CASE WHEN _st.kind = 'overnight' THEN _st.ends_on - 1 ELSE _st.ends_on END;
  SELECT max(v.scheduled_on) INTO _worked_last
    FROM public.visits v JOIN public.subscriptions s ON s.id = v.subscription_id
   WHERE s.stay_id = _st.id AND v.status IN ('in_progress', 'completed');
  IF _worked_last IS NOT NULL AND _last < _worked_last THEN
    RAISE EXCEPTION 'The sitter has already been there on %. End the stay on that day or later.',
      to_char(_worked_last, 'FMMonth FMDD');
  END IF;
  IF _last < _today - 1 THEN
    RAISE EXCEPTION 'A stay can end yesterday at the earliest.';
  END IF;

  IF _start = _st.starts_on AND _end = _st.ends_on AND _pets = _st.pet_ids THEN
    RETURN jsonb_build_object('visits_added', 0, 'visits_canceled', 0, 'invoice_id', NULL);
  END IF;

  SELECT s.price_cents INTO _old_price FROM public.subscriptions s
   WHERE s.stay_id = _st.id ORDER BY s.earliest_time NULLS LAST, s.id LIMIT 1;
  _price := _old_price;
  IF cardinality(_pets) <> cardinality(_st.pet_ids) THEN
    _old_rule := public.service_price_cents(_svc.price_unit, _svc.base_price_cents, _svc.extra_pet_cents,
      _svc.default_duration_min, cardinality(_st.pet_ids), NULL, 1, 1);
    _new_rule := public.service_price_cents(_svc.price_unit, _svc.base_price_cents, _svc.extra_pet_cents,
      _svc.default_duration_min, cardinality(_pets), NULL, 1, 1);
    IF _old_rule IS NULL OR _new_rule IS NULL OR _old_price IS NULL THEN
      RAISE EXCEPTION 'Set a price for this service before changing the pets.';
    END IF;
    _price := GREATEST(_old_price + _new_rule - _old_rule, 0);
  END IF;

  -- Work already under way or done keeps the price it had.
  IF _price IS DISTINCT FROM _old_price THEN
    UPDATE public.visits v SET price_cents = s.price_cents
      FROM public.subscriptions s
     WHERE s.id = v.subscription_id AND s.stay_id = _st.id
       AND v.price_cents IS NULL
       AND v.status NOT IN ('canceled', 'completed')
       AND NOT (v.status = 'scheduled' AND v.scheduled_on >= _today);
  END IF;

  -- Nights the stay lost.
  UPDATE public.visits v SET status = 'canceled'
    FROM public.subscriptions s
   WHERE s.id = v.subscription_id AND s.stay_id = _st.id
     AND v.status = 'scheduled' AND v.scheduled_on >= _today
     AND (v.scheduled_on < _start OR v.scheduled_on > _last);
  GET DIAGNOSTICS _canceled = ROW_COUNT;

  PERFORM set_config('houndstack.stay_change', _st.id::text, true);
  UPDATE public.stays
     SET starts_on = _start,
         ends_on = _end,
         pet_ids = _pets,
         care_snapshot = CASE WHEN _pets = _st.pet_ids THEN care_snapshot ELSE
           COALESCE((SELECT jsonb_agg(e) FROM jsonb_array_elements(COALESCE(_st.care_snapshot, '[]'::jsonb)) e
                      WHERE (e->>'pet_id')::uuid = ANY(_pets)), '[]'::jsonb)
           || COALESCE((SELECT jsonb_agg(jsonb_build_object('pet_id', d.id, 'name', d.name, 'species', d.species,
                          'species_note', d.species_note, 'feeding', c.feeding, 'meds', COALESCE(c.meds, '[]'::jsonb),
                          'other_care', c.other_care) ORDER BY d.id)
                          FROM public.dogs d LEFT JOIN public.pet_care_instructions c ON c.pet_id = d.id
                         WHERE d.id = ANY(_pets) AND NOT d.id = ANY(_st.pet_ids)), '[]'::jsonb)
         END
   WHERE id = _st.id;
  PERFORM set_config('houndstack.stay_change', '', true);

  UPDATE public.subscriptions
     SET started_on = _start,
         ends_on = _last,
         dog_count = cardinality(_pets),
         price_cents = _price,
         priced_at = CASE WHEN _price IS DISTINCT FROM _old_price THEN now() ELSE priced_at END
   WHERE stay_id = _st.id;

  -- Days the stay gained: a visit canceled there comes back, the rest are new.
  UPDATE public.visits v
     SET status = 'scheduled', assigned_staff_id = _st.assigned_staff_id, sequence = NULL
    FROM public.subscriptions s
   WHERE s.id = v.subscription_id AND s.stay_id = _st.id
     AND v.status = 'canceled'
     AND v.scheduled_on BETWEEN GREATEST(_start, _today) AND _last
     AND (v.scheduled_on < _st.starts_on OR v.scheduled_on > _old_last);
  GET DIAGNOSTICS _n = ROW_COUNT;
  _added := _added + _n;
  FOR _sub IN SELECT id FROM public.subscriptions WHERE stay_id = _st.id LOOP
    _added := _added + COALESCE(public.generate_visits_core(_st.organization_id, _last, _sub), 0);
  END LOOP;

  -- The generator leaves a night unassigned when the sitter is already
  -- booked that night; a new night has to be free for them.
  IF _st.kind = 'overnight' AND _st.assigned_staff_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.visits v JOIN public.subscriptions s ON s.id = v.subscription_id
     WHERE s.stay_id = _st.id AND v.status = 'scheduled'
       AND (v.scheduled_on < _st.starts_on OR v.scheduled_on > _old_last)
       AND v.assigned_staff_id IS DISTINCT FROM _st.assigned_staff_id
  ) THEN
    RAISE EXCEPTION 'This sitter already has an overnight stay on one of these nights.';
  END IF;

  _new_invoice := public.restate_stay_billing(_st.id);
  RETURN jsonb_build_object('visits_added', _added, 'visits_canceled', _canceled, 'invoice_id', _new_invoice);
END;
$function$;

REVOKE ALL ON FUNCTION public.change_stay(uuid, date, date, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.change_stay(uuid, date, date, uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.change_stay(uuid, date, date, uuid[]) IS
  'The office changes a confirmed stay: end date either way, start date before it starts, pets added or removed. Visits and billing follow; completed visits are never touched. can_write_org. Migration 20261017000000.';

-- ── What this file establishes, checked from any starting state ───────────
DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'stays' AND column_name = 'credited_cents'
                    AND is_nullable = 'NO') THEN
    RAISE EXCEPTION 'stays.credited_cents is missing';
  END IF;
  IF to_regprocedure('public.change_stay(uuid, date, date, uuid[])') IS NULL
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.change_stay(uuid, date, date, uuid[])'::regprocedure) THEN
    RAISE EXCEPTION 'change_stay is missing or does not run as its owner';
  END IF;
  IF has_function_privilege('anon', 'public.change_stay(uuid, date, date, uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.change_stay(uuid, date, date, uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.restate_stay_billing(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.stay_visit_bill(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tg_stays_validate()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tg_stays_invoice_guard()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tg_stays_follow()', 'EXECUTE') THEN
    RAISE EXCEPTION 'a stay change function has the wrong grants';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.change_stay(uuid, date, date, uuid[])'::regprocedure)
       NOT LIKE '%can_write_org%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.tg_stays_validate()'::regprocedure)
       NOT LIKE '%houndstack.stay_change%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.tg_stays_invoice_guard()'::regprocedure)
       NOT LIKE '%houndstack.stay_change%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.tg_stays_follow()'::regprocedure)
       NOT LIKE '%restate_stay_billing%' THEN
    RAISE EXCEPTION 'the stay change path or its guards are incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.stays'::regclass AND tgname = 'stays_validate' AND tgenabled <> 'D')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.stays'::regclass AND tgname = 'stays_invoice_guard' AND tgenabled <> 'D')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.stays'::regclass AND tgname = 'stays_follow' AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'a stay trigger is missing or disabled';
  END IF;
END
$check$;
