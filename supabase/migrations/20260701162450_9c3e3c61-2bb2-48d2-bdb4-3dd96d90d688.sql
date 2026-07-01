
-- Invoice status enum
CREATE TYPE public.invoice_status AS ENUM ('draft','open','paid','void','uncollectible');
CREATE TYPE public.payment_status AS ENUM ('pending','succeeded','failed','refunded');

-- Invoices
CREATE TABLE public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  period_start date,
  period_end date NOT NULL,
  subtotal_cents integer NOT NULL DEFAULT 0,
  total_cents integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'usd',
  status public.invoice_status NOT NULL DEFAULT 'draft',
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  checkout_url text,
  issued_at timestamptz,
  paid_at timestamptz,
  voided_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoices TO authenticated;
GRANT ALL ON public.invoices TO service_role;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "invoices readable by org members" ON public.invoices
  FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "invoices writable by managers" ON public.invoices
  FOR ALL TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id))
  WITH CHECK (public.can_write_org(auth.uid(), organization_id));

CREATE INDEX ON public.invoices(organization_id, status);
CREATE INDEX ON public.invoices(client_id);

CREATE TRIGGER touch_invoices BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- Invoice line items
CREATE TABLE public.invoice_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  visit_id uuid REFERENCES public.visits(id) ON DELETE SET NULL,
  subscription_id uuid REFERENCES public.subscriptions(id) ON DELETE SET NULL,
  description text NOT NULL,
  amount_cents integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoice_line_items TO authenticated;
GRANT ALL ON public.invoice_line_items TO service_role;
ALTER TABLE public.invoice_line_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "line items readable via parent invoice" ON public.invoice_line_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.invoices i
     WHERE i.id = invoice_id AND public.is_org_member(auth.uid(), i.organization_id)
  ));
CREATE POLICY "line items writable via parent invoice" ON public.invoice_line_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.invoices i
     WHERE i.id = invoice_id AND public.can_write_org(auth.uid(), i.organization_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.invoices i
     WHERE i.id = invoice_id AND public.can_write_org(auth.uid(), i.organization_id)
  ));

CREATE UNIQUE INDEX invoice_line_items_visit_unique ON public.invoice_line_items(visit_id)
  WHERE visit_id IS NOT NULL;
CREATE INDEX ON public.invoice_line_items(invoice_id);

-- Payments
CREATE TABLE public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  amount_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'usd',
  status public.payment_status NOT NULL DEFAULT 'pending',
  stripe_payment_intent_id text,
  stripe_checkout_session_id text,
  paid_at timestamptz,
  raw_event jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.payments TO authenticated;
GRANT ALL ON public.payments TO service_role;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "payments readable by org members" ON public.payments
  FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "payments writable by managers" ON public.payments
  FOR ALL TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id))
  WITH CHECK (public.can_write_org(auth.uid(), organization_id));

CREATE INDEX ON public.payments(invoice_id);
CREATE UNIQUE INDEX payments_pi_unique ON public.payments(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE TRIGGER touch_payments BEFORE UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- Function: generate invoice for a client from unbilled completed visits
CREATE OR REPLACE FUNCTION public.generate_invoice_for_client(
  _client_id uuid,
  _through date
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org uuid;
  _invoice_id uuid;
  _v record;
  _total integer := 0;
  _min_date date;
  _max_date date;
  _count integer := 0;
BEGIN
  SELECT organization_id INTO _org FROM public.clients WHERE id = _client_id;
  IF _org IS NULL THEN
    RAISE EXCEPTION 'Client not found';
  END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Count billable visits first
  SELECT COUNT(*), MIN(v.scheduled_on), MAX(v.scheduled_on)
    INTO _count, _min_date, _max_date
    FROM public.visits v
    LEFT JOIN public.invoice_line_items li ON li.visit_id = v.id
   WHERE v.client_id = _client_id
     AND v.status = 'completed'
     AND v.scheduled_on <= _through
     AND li.id IS NULL;

  IF _count = 0 THEN
    RAISE EXCEPTION 'No unbilled completed visits for this client through %', _through;
  END IF;

  INSERT INTO public.invoices(organization_id, client_id, period_start, period_end, status, issued_at)
  VALUES (_org, _client_id, _min_date, _max_date, 'open', now())
  RETURNING id INTO _invoice_id;

  FOR _v IN
    SELECT v.id AS visit_id, v.subscription_id, v.scheduled_on,
           s.price_cents, s.frequency,
           p.address_line1, p.city
      FROM public.visits v
      JOIN public.subscriptions s ON s.id = v.subscription_id
      LEFT JOIN public.properties p ON p.id = v.property_id
      LEFT JOIN public.invoice_line_items li ON li.visit_id = v.id
     WHERE v.client_id = _client_id
       AND v.status = 'completed'
       AND v.scheduled_on <= _through
       AND li.id IS NULL
     ORDER BY v.scheduled_on
  LOOP
    INSERT INTO public.invoice_line_items(invoice_id, visit_id, subscription_id, description, amount_cents)
    VALUES (
      _invoice_id, _v.visit_id, _v.subscription_id,
      'Service on ' || to_char(_v.scheduled_on, 'YYYY-MM-DD') ||
        COALESCE(' — ' || _v.address_line1, ''),
      COALESCE(_v.price_cents, 0)
    );
    _total := _total + COALESCE(_v.price_cents, 0);
  END LOOP;

  UPDATE public.invoices
     SET subtotal_cents = _total, total_cents = _total, updated_at = now()
   WHERE id = _invoice_id;

  RETURN _invoice_id;
END;
$$;

-- Function: generate invoices for every client in org with unbilled completed visits
CREATE OR REPLACE FUNCTION public.generate_invoices_for_org(
  _org_id uuid,
  _through date
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _c record; _n integer := 0;
BEGIN
  IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  FOR _c IN
    SELECT DISTINCT v.client_id
      FROM public.visits v
      LEFT JOIN public.invoice_line_items li ON li.visit_id = v.id
     WHERE v.organization_id = _org_id
       AND v.status = 'completed'
       AND v.scheduled_on <= _through
       AND li.id IS NULL
  LOOP
    PERFORM public.generate_invoice_for_client(_c.client_id, _through);
    _n := _n + 1;
  END LOOP;
  RETURN _n;
END;
$$;

-- Function: void invoice
CREATE OR REPLACE FUNCTION public.void_invoice(_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _org uuid; _status public.invoice_status;
BEGIN
  SELECT organization_id, status INTO _org, _status FROM public.invoices WHERE id = _invoice_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _status = 'paid' THEN
    RAISE EXCEPTION 'Cannot void a paid invoice';
  END IF;
  UPDATE public.invoices
     SET status = 'void', voided_at = now(), updated_at = now()
   WHERE id = _invoice_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_invoice_for_client(uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_invoices_for_org(uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_invoice(uuid) TO authenticated;
