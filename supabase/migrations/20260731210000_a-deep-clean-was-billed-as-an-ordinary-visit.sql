-- Two money defects on the postpaid/prepaid invoice-generation path.
--
-- 1. The seasonal deep clean was scheduled, shown, and never charged.
--    admin_generate_seasonal_deepcleans inserts an EXTRA visit per active
--    subscription in each configured month and stamps it with the org's
--    seasonal_deepclean_charge_cents (ships at $49.00). is_deepclean was read
--    (the visit list shows a "Deep clean" chip); deepclean_charge_cents was
--    read by nothing at all. The invoice line for that visit was built from
--    subscriptions.price_cents alone, so a $25.00/visit client whose March
--    deep clean was performed was invoiced $25.00 and the $49.00 the tenant
--    sells vanished — every deep clean, every client, every org that turns the
--    feature on. Settings > Deep-clean calls it a "surcharge" and says it is
--    "added to" the invoice, and help-content calls it "billed at a premium
--    over the regular visit", so the charge is ADDITIVE, not a replacement
--    price: the deep clean now bills price_cents + deepclean_charge_cents.
--    It is emitted as its own line — the same shape addon_charges lines use —
--    because a single line at an unexplained higher amount is a support call,
--    and because a separate line lets accounting exports see deep-clean
--    revenue on its own. The surcharge line carries visit_id = NULL: the
--    partial unique index invoice_line_items_visit_unique allows one row per
--    visit, and that row must stay the service line because the "not yet
--    billed" test everywhere is `LEFT JOIN invoice_line_items ON visit_id`.
--    Only a COMPLETED deep clean is surcharged: a billable skip already bills
--    skip_charge_cents for a visit that did not happen, and surcharging a
--    no-show deep clean would be a worse bug than the one being fixed.
--
-- 2. Found while fixing 1: the whole function has been raising
--    "column p.address_line1 does not exist" since 20260716220000 reintroduced
--    that column reference (properties.address_line1 was renamed to
--    properties.street long before, and 20260701213007 had already fixed it
--    once). Postpaid invoicing therefore generated NOTHING, and the failure
--    was invisible: run_billing_cycles wraps each client in a
--    "EXCEPTION WHEN OTHERS THEN RAISE WARNING" so the nightly run reports
--    success while every client silently produced zero invoices. Restored to
--    p.street, which is what the live line items from before the regression
--    ("Service on 2026-06-10 — 2205 S Lamar Blvd") were built from.

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
           s.price_cents, p.street
      FROM public.visits v
      JOIN public.subscriptions s ON s.id = v.subscription_id
      LEFT JOIN public.properties p ON p.id = v.property_id
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
        _desc := 'Service on ' || to_char(_v.scheduled_on, 'YYYY-MM-DD') || COALESCE(' - ' || _v.street, '');
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

  UPDATE public.invoices SET subtotal_cents = _total, total_cents = _total, updated_at = now()
   WHERE id = _invoice_id;

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
$function$;

-- Prepaid clients buy their upcoming visits in a block, and the deep clean is
-- one of those visits, so the same surcharge has to ride along here or the
-- top-up under-collects by exactly one deepclean_charge_cents per deep clean.
CREATE OR REPLACE FUNCTION public.generate_prepaid_invoice(_subscription_id uuid, _visit_count integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid; _client uuid; _cadence public.billing_cadence; _price integer;
  _invoice_id uuid; _v record; _total integer := 0;
  _min date; _max date; _n integer := 0;
BEGIN
  SELECT organization_id, client_id, billing_cadence, price_cents
    INTO _org, _client, _cadence, _price
    FROM public.subscriptions WHERE id = _subscription_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Subscription not found'; END IF;
  IF _cadence <> 'prepaid' THEN RAISE EXCEPTION 'Subscription is not prepaid'; END IF;
  IF NOT public.has_permission(auth.uid(), _org, 'manage_client_billing') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF _visit_count IS NULL OR _visit_count < 1 THEN RAISE EXCEPTION 'visit_count must be >= 1'; END IF;

  SELECT min(v.scheduled_on), max(v.scheduled_on), count(*)
    INTO _min, _max, _n
    FROM (
      SELECT v.id, v.scheduled_on
        FROM public.visits v
        LEFT JOIN public.invoice_line_items li ON li.visit_id = v.id
       WHERE v.subscription_id = _subscription_id
         AND v.status = 'scheduled'
         AND li.id IS NULL
       ORDER BY v.scheduled_on
       LIMIT _visit_count
    ) v;
  IF _n = 0 OR _min IS NULL THEN
    RAISE EXCEPTION 'No upcoming scheduled visits to prepay';
  END IF;

  INSERT INTO public.invoices(organization_id, client_id, status, kind, issued_at, period_start, period_end)
  VALUES (_org, _client, 'open', 'prepaid_topup', now(), _min, _max)
  RETURNING id INTO _invoice_id;

  _total := 0;
  FOR _v IN
    SELECT v.id, v.scheduled_on, v.is_deepclean, v.deepclean_charge_cents
      FROM public.visits v
      LEFT JOIN public.invoice_line_items li ON li.visit_id = v.id
     WHERE v.subscription_id = _subscription_id
       AND v.status = 'scheduled'
       AND li.id IS NULL
     ORDER BY v.scheduled_on
     LIMIT _visit_count
  LOOP
    INSERT INTO public.invoice_line_items(invoice_id, visit_id, subscription_id, description, amount_cents)
    VALUES (_invoice_id, _v.id, _subscription_id,
            CASE WHEN _v.is_deepclean THEN 'Prepaid deep clean on ' ELSE 'Prepaid service on ' END
              || to_char(_v.scheduled_on, 'YYYY-MM-DD'),
            COALESCE(_price, 0));
    _total := _total + COALESCE(_price, 0);

    IF _v.is_deepclean AND COALESCE(_v.deepclean_charge_cents, 0) > 0 THEN
      INSERT INTO public.invoice_line_items(invoice_id, visit_id, subscription_id, description, amount_cents)
      VALUES (_invoice_id, NULL, _subscription_id,
              'Seasonal deep-clean surcharge (' || to_char(_v.scheduled_on, 'YYYY-MM-DD') || ')',
              _v.deepclean_charge_cents);
      _total := _total + _v.deepclean_charge_cents;
    END IF;
  END LOOP;

  UPDATE public.invoices
     SET subtotal_cents = _total, total_cents = _total, updated_at = now()
   WHERE id = _invoice_id;

  RETURN _invoice_id;
END;
$function$;
