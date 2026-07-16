-- Bill next (prepaid) crashed with a period_end NOT NULL violation: the RPC
-- inserted the invoice first and only set the period after summing line
-- items. Compute the visit window up front, fail fast when there is nothing
-- to prepay, and insert the invoice fully formed.
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

  -- Window of the visits we are about to bill, BEFORE any insert.
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
    SELECT v.id, v.scheduled_on
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
            'Prepaid service on ' || to_char(_v.scheduled_on, 'YYYY-MM-DD'),
            COALESCE(_price, 0));
    _total := _total + COALESCE(_price, 0);
  END LOOP;

  UPDATE public.invoices
     SET subtotal_cents = _total, total_cents = _total, updated_at = now()
   WHERE id = _invoice_id;

  RETURN _invoice_id;
END; $function$;
