
CREATE TYPE public.addon_kind AS ENUM ('one_time', 'recurring');
CREATE TYPE public.addon_frequency AS ENUM ('weekly','biweekly','monthly','quarterly','yearly');
CREATE TYPE public.addon_charge_status AS ENUM ('pending','invoiced','paid_from_credit','voided');

CREATE TABLE public.addon_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  description text,
  kind public.addon_kind NOT NULL DEFAULT 'one_time',
  unit_price_cents integer NOT NULL DEFAULT 0 CHECK (unit_price_cents >= 0),
  default_frequency public.addon_frequency,
  taxable boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);
CREATE INDEX ON public.addon_services(organization_id, active);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.addon_services TO authenticated;
GRANT ALL ON public.addon_services TO service_role;
ALTER TABLE public.addon_services ENABLE ROW LEVEL SECURITY;
CREATE POLICY "addon_services readable by org" ON public.addon_services
  FOR SELECT TO authenticated USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "addon_services writable by managers" ON public.addon_services
  FOR ALL TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id))
  WITH CHECK (public.can_write_org(auth.uid(), organization_id));

CREATE TABLE public.addon_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  addon_service_id uuid NOT NULL REFERENCES public.addon_services(id) ON DELETE RESTRICT,
  frequency public.addon_frequency NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  started_on date NOT NULL DEFAULT CURRENT_DATE,
  next_charge_on date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','canceled')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON public.addon_subscriptions(organization_id, client_id);
CREATE INDEX ON public.addon_subscriptions(organization_id, status, next_charge_on);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.addon_subscriptions TO authenticated;
GRANT ALL ON public.addon_subscriptions TO service_role;
ALTER TABLE public.addon_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "addon_subs readable by org" ON public.addon_subscriptions
  FOR SELECT TO authenticated USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "addon_subs writable by managers" ON public.addon_subscriptions
  FOR ALL TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id))
  WITH CHECK (public.can_write_org(auth.uid(), organization_id));

CREATE TABLE public.addon_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  addon_service_id uuid REFERENCES public.addon_services(id) ON DELETE SET NULL,
  addon_subscription_id uuid REFERENCES public.addon_subscriptions(id) ON DELETE SET NULL,
  visit_id uuid REFERENCES public.visits(id) ON DELETE SET NULL,
  description text NOT NULL,
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  occurred_on date NOT NULL DEFAULT CURRENT_DATE,
  status public.addon_charge_status NOT NULL DEFAULT 'pending',
  invoice_line_item_id uuid REFERENCES public.invoice_line_items(id) ON DELETE SET NULL,
  credit_ledger_id uuid REFERENCES public.credit_ledger(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'office' CHECK (source IN ('office','field','recurring','signup')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON public.addon_charges(organization_id, client_id, status);
CREATE INDEX ON public.addon_charges(organization_id, status, occurred_on);
CREATE INDEX ON public.addon_charges(visit_id) WHERE visit_id IS NOT NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.addon_charges TO authenticated;
GRANT ALL ON public.addon_charges TO service_role;
ALTER TABLE public.addon_charges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "addon_charges readable by org" ON public.addon_charges
  FOR SELECT TO authenticated USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "addon_charges writable by org staff" ON public.addon_charges
  FOR ALL TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id))
  WITH CHECK (public.can_write_org(auth.uid(), organization_id));

ALTER TABLE public.credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_kind_check;
ALTER TABLE public.credit_ledger ADD CONSTRAINT credit_ledger_kind_check
  CHECK (kind = ANY (ARRAY['prepayment','visit_debit','refund','adjustment','referral_reward','referral_bonus','addon_debit']));

CREATE OR REPLACE FUNCTION public.client_default_billing_cadence(_client_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT billing_cadence::text
       FROM public.subscriptions
      WHERE client_id = _client_id AND status = 'active'
      ORDER BY started_on DESC NULLS LAST
      LIMIT 1),
    'postpaid'
  );
$$;
GRANT EXECUTE ON FUNCTION public.client_default_billing_cadence(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.create_addon_charge(
  _client_id uuid,
  _addon_service_id uuid,
  _quantity integer DEFAULT 1,
  _unit_price_cents integer DEFAULT NULL,
  _description text DEFAULT NULL,
  _visit_id uuid DEFAULT NULL,
  _source text DEFAULT 'office',
  _note text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org uuid; _svc record; _price integer; _amt integer; _desc text;
  _charge_id uuid; _ledger_id uuid; _cadence text;
BEGIN
  SELECT organization_id INTO _org FROM public.clients WHERE id = _client_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Client not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN RAISE EXCEPTION 'Not authorized'; END IF;

  SELECT * INTO _svc FROM public.addon_services WHERE id = _addon_service_id AND organization_id = _org;
  IF _svc IS NULL THEN RAISE EXCEPTION 'Add-on service not found'; END IF;

  _price := COALESCE(_unit_price_cents, _svc.unit_price_cents);
  _amt := _price * GREATEST(_quantity, 1);
  _desc := COALESCE(_description, _svc.name);
  _cadence := public.client_default_billing_cadence(_client_id);

  INSERT INTO public.addon_charges(
    organization_id, client_id, addon_service_id, visit_id, description,
    unit_price_cents, quantity, amount_cents, source, note, created_by
  ) VALUES (
    _org, _client_id, _addon_service_id, _visit_id, _desc,
    _price, GREATEST(_quantity,1), _amt, _source, _note, auth.uid()
  ) RETURNING id INTO _charge_id;

  IF _cadence = 'prepaid' AND _amt > 0 THEN
    INSERT INTO public.credit_ledger(organization_id, client_id, delta_cents, kind, note)
    VALUES (_org, _client_id, -_amt, 'addon_debit', 'Add-on: ' || _desc)
    RETURNING id INTO _ledger_id;

    UPDATE public.addon_charges
       SET status = 'paid_from_credit', credit_ledger_id = _ledger_id, updated_at = now()
     WHERE id = _charge_id;
  END IF;

  RETURN _charge_id;
END; $$;
GRANT EXECUTE ON FUNCTION public.create_addon_charge(uuid, uuid, integer, integer, text, uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.void_addon_charge(_charge_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _c record;
BEGIN
  SELECT * INTO _c FROM public.addon_charges WHERE id = _charge_id;
  IF _c IS NULL THEN RAISE EXCEPTION 'Charge not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), _c.organization_id) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF _c.status = 'invoiced' THEN RAISE EXCEPTION 'Already invoiced - void the invoice instead'; END IF;
  IF _c.status = 'voided' THEN RETURN; END IF;

  IF _c.status = 'paid_from_credit' AND _c.credit_ledger_id IS NOT NULL THEN
    INSERT INTO public.credit_ledger(organization_id, client_id, delta_cents, kind, note)
    VALUES (_c.organization_id, _c.client_id, _c.amount_cents, 'refund', 'Void add-on: ' || _c.description);
  END IF;

  UPDATE public.addon_charges SET status='voided', updated_at=now() WHERE id=_charge_id;
END; $$;
GRANT EXECUTE ON FUNCTION public.void_addon_charge(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.generate_addon_charges_through(_org_id uuid, _through date)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _s record; _n integer := 0; _step interval; _next date; _charge_id uuid;
BEGIN
  IF NOT public.can_write_org(auth.uid(), _org_id) THEN RAISE EXCEPTION 'Not authorized'; END IF;

  FOR _s IN
    SELECT * FROM public.addon_subscriptions
     WHERE organization_id = _org_id AND status = 'active' AND next_charge_on <= _through
  LOOP
    _step := CASE _s.frequency
      WHEN 'weekly' THEN interval '7 days'
      WHEN 'biweekly' THEN interval '14 days'
      WHEN 'monthly' THEN interval '1 month'
      WHEN 'quarterly' THEN interval '3 months'
      WHEN 'yearly' THEN interval '1 year'
    END;

    _next := _s.next_charge_on;
    WHILE _next <= _through LOOP
      INSERT INTO public.addon_charges(
        organization_id, client_id, addon_service_id, addon_subscription_id,
        description, unit_price_cents, quantity, amount_cents, occurred_on, source
      )
      SELECT _s.organization_id, _s.client_id, _s.addon_service_id, _s.id,
             svc.name, _s.price_cents, _s.quantity, _s.price_cents * _s.quantity, _next, 'recurring'
        FROM public.addon_services svc WHERE svc.id = _s.addon_service_id
      RETURNING id INTO _charge_id;

      IF public.client_default_billing_cadence(_s.client_id) = 'prepaid' THEN
        DECLARE _lid uuid; _amt integer;
        BEGIN
          SELECT amount_cents INTO _amt FROM public.addon_charges WHERE id = _charge_id;
          INSERT INTO public.credit_ledger(organization_id, client_id, delta_cents, kind, note)
          VALUES (_s.organization_id, _s.client_id, -_amt, 'addon_debit',
                  'Recurring add-on ' || _next::text)
          RETURNING id INTO _lid;
          UPDATE public.addon_charges
             SET status='paid_from_credit', credit_ledger_id=_lid, updated_at=now()
           WHERE id=_charge_id;
        END;
      END IF;

      _n := _n + 1;
      _next := (_next + _step)::date;
    END LOOP;

    UPDATE public.addon_subscriptions SET next_charge_on = _next, updated_at = now() WHERE id = _s.id;
  END LOOP;

  RETURN _n;
END; $$;
GRANT EXECUTE ON FUNCTION public.generate_addon_charges_through(uuid, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.generate_invoice_for_client(_client_id uuid, _through date)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org uuid; _invoice_id uuid; _v record; _a record;
  _total integer := 0; _min_date date; _max_date date;
  _visit_count integer := 0; _addon_count integer := 0;
  _li_id uuid; _addon_min date; _addon_max date;
BEGIN
  SELECT organization_id INTO _org FROM public.clients WHERE id = _client_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Client not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN RAISE EXCEPTION 'Not authorized'; END IF;

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
    RAISE EXCEPTION 'No unbilled items for this client through %', _through;
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
           s.price_cents, p.address_line1
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
      ELSE
        _amt := COALESCE(_v.price_cents, 0);
        _desc := 'Service on ' || to_char(_v.scheduled_on, 'YYYY-MM-DD') || COALESCE(' - ' || _v.address_line1, '');
      END IF;
      INSERT INTO public.invoice_line_items(invoice_id, visit_id, subscription_id, description, amount_cents)
      VALUES (_invoice_id, _v.visit_id, _v.subscription_id, _desc, _amt);
      _total := _total + _amt;
    END;
  END LOOP;

  FOR _a IN
    SELECT * FROM public.addon_charges
     WHERE client_id = _client_id AND status = 'pending' AND occurred_on <= _through
     ORDER BY occurred_on
  LOOP
    INSERT INTO public.invoice_line_items(invoice_id, subscription_id, description, amount_cents)
    VALUES (_invoice_id, NULL,
      _a.description || ' (' || to_char(_a.occurred_on,'YYYY-MM-DD') || ')' ||
      CASE WHEN _a.quantity > 1 THEN ' x ' || _a.quantity ELSE '' END,
      _a.amount_cents)
    RETURNING id INTO _li_id;

    UPDATE public.addon_charges
       SET status = 'invoiced', invoice_line_item_id = _li_id, updated_at = now()
     WHERE id = _a.id;
    _total := _total + _a.amount_cents;
  END LOOP;

  UPDATE public.invoices SET subtotal_cents = _total, total_cents = _total, updated_at = now()
   WHERE id = _invoice_id;
  RETURN _invoice_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.generate_invoices_for_org(_org_id uuid, _through date)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _c record; _n integer := 0;
BEGIN
  IF NOT public.can_write_org(auth.uid(), _org_id) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  FOR _c IN
    SELECT DISTINCT client_id FROM (
      SELECT v.client_id
        FROM public.visits v
        JOIN public.subscriptions s ON s.id = v.subscription_id
        LEFT JOIN public.invoice_line_items li ON li.visit_id = v.id
       WHERE v.organization_id = _org_id
         AND v.scheduled_on <= _through
         AND li.id IS NULL
         AND s.billing_cadence = 'postpaid'
         AND (v.status = 'completed' OR (v.status = 'skipped' AND v.skip_billable = true))
      UNION
      SELECT ac.client_id
        FROM public.addon_charges ac
       WHERE ac.organization_id = _org_id
         AND ac.status = 'pending'
         AND ac.occurred_on <= _through
         AND public.client_default_billing_cadence(ac.client_id) = 'postpaid'
    ) x
  LOOP
    BEGIN
      PERFORM public.generate_invoice_for_client(_c.client_id, _through);
      _n := _n + 1;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
  RETURN _n;
END; $$;

INSERT INTO public.addon_services(organization_id, code, name, description, kind, unit_price_cents, active)
SELECT o.id, x.code, x.name, x.description, x.kind::public.addon_kind, x.price, true
  FROM public.organizations o
 CROSS JOIN (VALUES
    ('deodorize', 'Yard deodorize', 'Enzyme-based yard deodorizing treatment', 'one_time', 2500),
    ('haul_away', 'Haul-away', 'Remove and dispose of waste offsite', 'one_time', 1500),
    ('tick_treatment', 'Tick treatment', 'Perimeter tick and flea treatment', 'one_time', 4500),
    ('station_refill', 'Station refill', 'Refill bag dispenser and empty bin', 'one_time', 3500),
    ('deep_clean', 'Seasonal deep clean', 'Full seasonal deep clean', 'one_time', 8500)
 ) AS x(code, name, description, kind, price)
 ON CONFLICT (organization_id, code) DO NOTHING;
