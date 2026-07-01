
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS portal_token uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS clients_portal_token_key ON public.clients(portal_token);

DO $$ BEGIN
  ALTER TYPE public.skip_reason_code ADD VALUE IF NOT EXISTS 'customer_requested';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.portal_get_client(_token uuid)
RETURNS TABLE(client_id uuid, organization_id uuid, display_name text,
              account_type text, credit_balance_cents integer, org_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.organization_id, c.display_name, c.account_type::text,
         c.credit_balance_cents, o.name
    FROM public.clients c JOIN public.organizations o ON o.id = c.organization_id
   WHERE c.portal_token = _token AND c.active = true
$$;

CREATE OR REPLACE FUNCTION public.portal_list_upcoming_visits(_token uuid)
RETURNS TABLE(visit_id uuid, scheduled_on date, status public.visit_status,
              street text, city text, postal_code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT v.id, v.scheduled_on, v.status, p.street, p.city, p.postal_code
    FROM public.clients c
    JOIN public.visits v ON v.client_id = c.id
    LEFT JOIN public.properties p ON p.id = v.property_id
   WHERE c.portal_token = _token
     AND v.scheduled_on >= CURRENT_DATE
     AND v.status IN ('scheduled','in_progress')
   ORDER BY v.scheduled_on, v.sequence NULLS LAST
$$;

CREATE OR REPLACE FUNCTION public.portal_list_invoices(_token uuid)
RETURNS TABLE(invoice_id uuid, status public.invoice_status, kind text,
              total_cents integer, issued_at timestamptz,
              period_start date, period_end date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT i.id, i.status, i.kind::text, i.total_cents, i.issued_at,
         i.period_start, i.period_end
    FROM public.clients c JOIN public.invoices i ON i.client_id = c.id
   WHERE c.portal_token = _token
   ORDER BY i.issued_at DESC NULLS LAST, i.created_at DESC
$$;

CREATE OR REPLACE FUNCTION public.portal_list_prepaid_subscriptions(_token uuid)
RETURNS TABLE(subscription_id uuid, price_cents integer, frequency public.service_frequency, property_label text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, s.price_cents, s.frequency, p.label
    FROM public.clients c
    JOIN public.subscriptions s ON s.client_id = c.id
    LEFT JOIN public.properties p ON p.id = s.property_id
   WHERE c.portal_token = _token AND s.status = 'active' AND s.billing_cadence = 'prepaid'
   ORDER BY p.label NULLS LAST
$$;

CREATE OR REPLACE FUNCTION public.portal_request_skip(_token uuid, _visit_id uuid, _reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _cid uuid; _org uuid; _price integer; _pct integer; _charge integer;
BEGIN
  SELECT c.id, c.organization_id INTO _cid, _org
    FROM public.clients c WHERE c.portal_token = _token AND c.active = true;
  IF _cid IS NULL THEN RAISE EXCEPTION 'Invalid portal token'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.visits v
     WHERE v.id = _visit_id AND v.client_id = _cid
       AND v.status IN ('scheduled','in_progress')) THEN
    RAISE EXCEPTION 'Visit not eligible to skip';
  END IF;
  SELECT s.price_cents INTO _price FROM public.visits v
    JOIN public.subscriptions s ON s.id = v.subscription_id WHERE v.id = _visit_id;
  SELECT billable_pct INTO _pct FROM public.skip_billing_rules
   WHERE organization_id = _org AND reason_code = 'customer_requested';
  IF _pct IS NULL THEN _pct := 0; END IF;
  _charge := ROUND(COALESCE(_price,0) * _pct / 100.0)::int;
  UPDATE public.visits SET status='skipped',
    skip_reason = COALESCE(NULLIF(trim(_reason),''), 'Customer requested via portal'),
    skip_reason_code='customer_requested', skip_billable=(_charge>0),
    skip_charge_cents=_charge, updated_at=now() WHERE id=_visit_id;
END; $$;

CREATE OR REPLACE FUNCTION public.portal_start_prepaid_topup(_token uuid, _subscription_id uuid, _visit_count integer)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _cid uuid; _org uuid; _cadence public.billing_cadence; _price integer;
  _invoice_id uuid; _v record; _total integer := 0; _n integer := 0; _min date; _max date;
BEGIN
  SELECT c.id, c.organization_id INTO _cid, _org
    FROM public.clients c WHERE c.portal_token = _token AND c.active = true;
  IF _cid IS NULL THEN RAISE EXCEPTION 'Invalid portal token'; END IF;
  SELECT billing_cadence, price_cents INTO _cadence, _price
    FROM public.subscriptions WHERE id=_subscription_id AND client_id=_cid;
  IF _cadence IS NULL THEN RAISE EXCEPTION 'Subscription not found'; END IF;
  IF _cadence <> 'prepaid' THEN RAISE EXCEPTION 'Subscription is not prepaid'; END IF;
  IF _visit_count IS NULL OR _visit_count < 1 THEN RAISE EXCEPTION 'visit_count must be >= 1'; END IF;
  INSERT INTO public.invoices(organization_id, client_id, status, kind, issued_at)
    VALUES (_org, _cid, 'open', 'prepaid_topup', now()) RETURNING id INTO _invoice_id;
  FOR _v IN
    SELECT v.id, v.scheduled_on FROM public.visits v
      LEFT JOIN public.invoice_line_items li ON li.visit_id=v.id
     WHERE v.subscription_id=_subscription_id AND v.status='scheduled' AND li.id IS NULL
     ORDER BY v.scheduled_on LIMIT _visit_count
  LOOP
    INSERT INTO public.invoice_line_items(invoice_id, visit_id, subscription_id, description, amount_cents)
    VALUES (_invoice_id, _v.id, _subscription_id,
      'Prepaid service on '||to_char(_v.scheduled_on,'YYYY-MM-DD'), COALESCE(_price,0));
    _total := _total + COALESCE(_price,0); _n := _n + 1;
    _min := LEAST(COALESCE(_min,_v.scheduled_on), _v.scheduled_on);
    _max := GREATEST(COALESCE(_max,_v.scheduled_on), _v.scheduled_on);
  END LOOP;
  IF _n = 0 THEN DELETE FROM public.invoices WHERE id=_invoice_id;
    RAISE EXCEPTION 'No upcoming scheduled visits to prepay'; END IF;
  UPDATE public.invoices SET subtotal_cents=_total, total_cents=_total,
    period_start=_min, period_end=_max, updated_at=now() WHERE id=_invoice_id;
  RETURN _invoice_id;
END; $$;

GRANT EXECUTE ON FUNCTION public.portal_get_client(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_list_upcoming_visits(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_list_invoices(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_list_prepaid_subscriptions(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_request_skip(uuid, uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_start_prepaid_topup(uuid, uuid, integer) TO anon, authenticated;
