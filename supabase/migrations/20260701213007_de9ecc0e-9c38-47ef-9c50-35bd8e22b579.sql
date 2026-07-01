
CREATE OR REPLACE FUNCTION public.generate_invoice_for_client(_client_id uuid, _through date)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _org uuid; _invoice_id uuid; _v record;
  _total integer := 0; _min_date date; _max_date date; _count integer := 0;
BEGIN
  SELECT organization_id INTO _org FROM public.clients WHERE id = _client_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Client not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN RAISE EXCEPTION 'Not authorized'; END IF;

  SELECT COUNT(*), MIN(v.scheduled_on), MAX(v.scheduled_on)
    INTO _count, _min_date, _max_date
    FROM public.visits v
    JOIN public.subscriptions s ON s.id = v.subscription_id
    LEFT JOIN public.invoice_line_items li ON li.visit_id = v.id
   WHERE v.client_id = _client_id AND v.scheduled_on <= _through AND li.id IS NULL
     AND s.billing_cadence = 'postpaid'
     AND (v.status = 'completed' OR (v.status = 'skipped' AND v.skip_billable = true));

  IF _count = 0 THEN RAISE EXCEPTION 'No unbilled billable visits for this client through %', _through; END IF;

  INSERT INTO public.invoices(organization_id, client_id, period_start, period_end, status, kind, issued_at)
  VALUES (_org, _client_id, _min_date, _max_date, 'open', 'postpaid', now()) RETURNING id INTO _invoice_id;

  FOR _v IN
    SELECT v.id AS visit_id, v.subscription_id, v.scheduled_on, v.status,
           v.skip_charge_cents, v.skip_reason_code, s.price_cents, p.street AS street
      FROM public.visits v
      JOIN public.subscriptions s ON s.id = v.subscription_id
      LEFT JOIN public.properties p ON p.id = v.property_id
      LEFT JOIN public.invoice_line_items li ON li.visit_id = v.id
     WHERE v.client_id = _client_id AND v.scheduled_on <= _through AND li.id IS NULL
       AND s.billing_cadence = 'postpaid'
       AND (v.status = 'completed' OR (v.status = 'skipped' AND v.skip_billable = true))
     ORDER BY v.scheduled_on
  LOOP
    DECLARE _amt integer; _desc text;
    BEGIN
      IF _v.status = 'skipped' THEN
        _amt := COALESCE(_v.skip_charge_cents, 0);
        _desc := 'Skipped visit ' || to_char(_v.scheduled_on, 'YYYY-MM-DD') || ' (' || COALESCE(_v.skip_reason_code::text,'other') || ')';
      ELSE
        _amt := COALESCE(_v.price_cents, 0);
        _desc := 'Service on ' || to_char(_v.scheduled_on, 'YYYY-MM-DD') || COALESCE(' — ' || _v.street, '');
      END IF;
      INSERT INTO public.invoice_line_items(invoice_id, visit_id, subscription_id, description, amount_cents)
      VALUES (_invoice_id, _v.visit_id, _v.subscription_id, _desc, _amt);
      _total := _total + _amt;
    END;
  END LOOP;

  UPDATE public.invoices SET subtotal_cents = _total, total_cents = _total, updated_at = now() WHERE id = _invoice_id;
  RETURN _invoice_id;
END; $function$;

CREATE OR REPLACE FUNCTION public.admin_generate_invoices_for_org(_org_id uuid, _through date)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _c record; _n integer := 0; _cid uuid; _org uuid; _invoice_id uuid; _v record;
  _total integer := 0; _min_date date; _max_date date; _count integer := 0;
BEGIN
  FOR _c IN
    SELECT DISTINCT v.client_id FROM public.visits v
      JOIN public.subscriptions s ON s.id = v.subscription_id
      LEFT JOIN public.invoice_line_items li ON li.visit_id = v.id
     WHERE v.organization_id = _org_id AND v.scheduled_on <= _through AND li.id IS NULL
       AND s.billing_cadence = 'postpaid'
       AND (v.status = 'completed' OR (v.status = 'skipped' AND v.skip_billable = true))
  LOOP
    _cid := _c.client_id;
    SELECT organization_id INTO _org FROM public.clients WHERE id = _cid;
    SELECT COUNT(*), MIN(v.scheduled_on), MAX(v.scheduled_on) INTO _count, _min_date, _max_date
      FROM public.visits v JOIN public.subscriptions s ON s.id = v.subscription_id
      LEFT JOIN public.invoice_line_items li ON li.visit_id = v.id
     WHERE v.client_id = _cid AND v.scheduled_on <= _through AND li.id IS NULL
       AND s.billing_cadence='postpaid'
       AND (v.status='completed' OR (v.status='skipped' AND v.skip_billable=true));
    IF _count = 0 THEN CONTINUE; END IF;

    INSERT INTO public.invoices(organization_id, client_id, period_start, period_end, status, kind, issued_at)
    VALUES (_org, _cid, _min_date, _max_date, 'open', 'postpaid', now()) RETURNING id INTO _invoice_id;

    _total := 0;
    FOR _v IN
      SELECT v.id AS visit_id, v.subscription_id, v.scheduled_on, v.status,
             v.skip_charge_cents, v.skip_reason_code, s.price_cents, p.street AS street
        FROM public.visits v JOIN public.subscriptions s ON s.id = v.subscription_id
        LEFT JOIN public.properties p ON p.id = v.property_id
        LEFT JOIN public.invoice_line_items li ON li.visit_id = v.id
       WHERE v.client_id = _cid AND v.scheduled_on <= _through AND li.id IS NULL
         AND s.billing_cadence='postpaid'
         AND (v.status='completed' OR (v.status='skipped' AND v.skip_billable=true))
       ORDER BY v.scheduled_on
    LOOP
      DECLARE _amt integer; _desc text;
      BEGIN
        IF _v.status = 'skipped' THEN
          _amt := COALESCE(_v.skip_charge_cents, 0);
          _desc := 'Skipped visit ' || to_char(_v.scheduled_on,'YYYY-MM-DD') || ' (' || COALESCE(_v.skip_reason_code::text,'other') || ')';
        ELSE
          _amt := COALESCE(_v.price_cents, 0);
          _desc := 'Service on ' || to_char(_v.scheduled_on,'YYYY-MM-DD') || COALESCE(' — ' || _v.street, '');
        END IF;
        INSERT INTO public.invoice_line_items(invoice_id, visit_id, subscription_id, description, amount_cents)
        VALUES (_invoice_id, _v.visit_id, _v.subscription_id, _desc, _amt);
        _total := _total + _amt;
      END;
    END LOOP;
    UPDATE public.invoices SET subtotal_cents=_total, total_cents=_total, updated_at=now() WHERE id=_invoice_id;
    _n := _n + 1;
  END LOOP;
  RETURN _n;
END; $function$;
