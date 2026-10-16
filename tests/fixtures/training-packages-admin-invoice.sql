CREATE OR REPLACE FUNCTION public.admin_generate_invoice_for_client(_client_id uuid, _through date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid; _invoice_id uuid; _v record; _a record;
  _total integer := 0; _min_date date; _max_date date;
  _visit_count integer := 0; _addon_count integer := 0;
  _li_id uuid; _addon_min date; _addon_max date;
BEGIN
  SELECT organization_id INTO _org FROM public.clients WHERE id = _client_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Client not found'; END IF;

  SELECT COUNT(*), MIN(v.scheduled_on), MAX(v.scheduled_on)
    INTO _visit_count, _min_date, _max_date
    FROM public.visits v
    JOIN public.subscriptions s ON s.id = v.subscription_id
    LEFT JOIN public.invoice_line_items li ON li.visit_id = v.id
   WHERE v.client_id = _client_id
     AND v.scheduled_on <= _through
     AND li.id IS NULL
     AND s.billing_cadence = 'postpaid'
     AND (v.status = 'completed' OR (v.status = 'skipped' AND v.skip_billable = true));

  SELECT COUNT(*), MIN(occurred_on), MAX(occurred_on)
    INTO _addon_count, _addon_min, _addon_max
    FROM public.addon_charges
   WHERE client_id = _client_id
     AND status = 'pending'
     AND occurred_on <= _through;

  IF _visit_count = 0 AND _addon_count = 0 THEN
    RETURN NULL;
  END IF;

  IF _addon_count > 0 THEN
    _min_date := LEAST(COALESCE(_min_date, _addon_min), _addon_min);
    _max_date := GREATEST(COALESCE(_max_date, _addon_max), _addon_max);
  END IF;

  INSERT INTO public.invoices(organization_id, client_id, period_start, period_end, status, kind, issued_at)
  VALUES (_org, _client_id, _min_date, _max_date, 'open', 'postpaid', now())
  RETURNING id INTO _invoice_id;

  FOR _v IN
    SELECT v.id AS visit_id, v.subscription_id, v.scheduled_on, v.status,
           v.skip_charge_cents, v.skip_reason_code,
           v.is_deepclean, v.deepclean_charge_cents,
           COALESCE(v.price_cents, s.price_cents) AS price_cents, p.street, sv.name AS service_name
      FROM public.visits v
      JOIN public.subscriptions s ON s.id = v.subscription_id
      LEFT JOIN public.properties p ON p.id = v.property_id
      LEFT JOIN public.services sv ON sv.id = v.service_id
      LEFT JOIN public.invoice_line_items li ON li.visit_id = v.id
     WHERE v.client_id = _client_id
       AND v.scheduled_on <= _through
       AND li.id IS NULL
       AND s.billing_cadence = 'postpaid'
       AND (v.status = 'completed' OR (v.status = 'skipped' AND v.skip_billable = true))
     ORDER BY v.scheduled_on
  LOOP
    DECLARE _amt integer; _desc text;
    BEGIN
      IF _v.status = 'skipped' THEN
        _amt := COALESCE(_v.skip_charge_cents, 0);
        _desc := 'Skipped visit ' || to_char(_v.scheduled_on, 'YYYY-MM-DD') || ' (' || COALESCE(_v.skip_reason_code::text,'other') || ')';
      ELSIF _v.is_deepclean THEN
        _amt := COALESCE(_v.price_cents, 0);
        _desc := 'Deep clean on ' || to_char(_v.scheduled_on, 'YYYY-MM-DD') || COALESCE(' - ' || _v.street, '');
      ELSE
        _amt := COALESCE(_v.price_cents, 0);
        _desc := public.service_line_item_name(_v.service_name) || ' on ' || to_char(_v.scheduled_on, 'YYYY-MM-DD') || COALESCE(' - ' || _v.street, '');
      END IF;
      INSERT INTO public.invoice_line_items(invoice_id, visit_id, subscription_id, description, amount_cents)
      VALUES (_invoice_id, _v.visit_id, _v.subscription_id, _desc, _amt);
      _total := _total + _amt;

      -- The seasonal surcharge the tenant actually sells, priced off the visit
      -- row so a later settings change cannot retro-price a done deep clean.
      IF _v.status = 'completed'
         AND _v.is_deepclean
         AND COALESCE(_v.deepclean_charge_cents, 0) > 0 THEN
        INSERT INTO public.invoice_line_items(invoice_id, visit_id, subscription_id, description, amount_cents)
        VALUES (_invoice_id, NULL, _v.subscription_id,
                'Seasonal deep-clean surcharge (' || to_char(_v.scheduled_on, 'YYYY-MM-DD') || ')',
                _v.deepclean_charge_cents);
        _total := _total + _v.deepclean_charge_cents;
      END IF;
    END;
  END LOOP;

  FOR _a IN
    SELECT * FROM public.addon_charges
     WHERE client_id = _client_id AND status = 'pending' AND occurred_on <= _through
     ORDER BY occurred_on
  LOOP
    UPDATE public.addon_charges
       SET status = 'invoiced', updated_at = now()
     WHERE id = _a.id AND status = 'pending';
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    INSERT INTO public.invoice_line_items(invoice_id, subscription_id, description, amount_cents)
    VALUES (_invoice_id, NULL,
      _a.description || ' (' || to_char(_a.occurred_on,'YYYY-MM-DD') || ')' ||
      CASE WHEN _a.quantity > 1 THEN ' x ' || _a.quantity ELSE '' END,
      _a.amount_cents)
    RETURNING id INTO _li_id;

    UPDATE public.addon_charges
       SET invoice_line_item_id = _li_id, updated_at = now()
     WHERE id = _a.id;
    _total := _total + _a.amount_cents;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM public.invoice_line_items WHERE invoice_id = _invoice_id
  ) THEN
    DELETE FROM public.invoices WHERE id = _invoice_id;
    RETURN NULL;
  END IF;

  PERFORM public.set_invoice_totals(_invoice_id, _total);

  IF NOT EXISTS (
    SELECT 1 FROM public.subscriptions s
     WHERE s.client_id = _client_id
       AND s.billing_cadence = 'prepaid'
       AND s.status IN ('active', 'paused')
  ) THEN
    PERFORM public.apply_credit_to_invoice(_invoice_id);
  END IF;

  RETURN _invoice_id;
END;
$function$
;
