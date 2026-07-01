
CREATE TYPE public.invoice_kind AS ENUM ('postpaid', 'prepaid_topup');
ALTER TABLE public.invoices ADD COLUMN kind public.invoice_kind NOT NULL DEFAULT 'postpaid';

ALTER TABLE public.clients ADD COLUMN credit_balance_cents integer NOT NULL DEFAULT 0;

CREATE TABLE public.credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  delta_cents integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('prepayment','visit_debit','refund','adjustment')),
  invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  visit_id uuid REFERENCES public.visits(id) ON DELETE SET NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_ledger_client_idx ON public.credit_ledger(client_id, created_at DESC);
CREATE INDEX credit_ledger_org_idx ON public.credit_ledger(organization_id, created_at DESC);

GRANT SELECT, INSERT ON public.credit_ledger TO authenticated;
GRANT ALL ON public.credit_ledger TO service_role;
ALTER TABLE public.credit_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members read ledger" ON public.credit_ledger
  FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "managers write ledger" ON public.credit_ledger
  FOR INSERT TO authenticated
  WITH CHECK (public.can_write_org(auth.uid(), organization_id));

CREATE OR REPLACE FUNCTION public.post_credit_entry(
  _org_id uuid, _client_id uuid, _delta integer, _kind text,
  _invoice_id uuid, _visit_id uuid, _note text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.credit_ledger(organization_id, client_id, delta_cents, kind, invoice_id, visit_id, note)
  VALUES (_org_id, _client_id, _delta, _kind, _invoice_id, _visit_id, _note);
  UPDATE public.clients SET credit_balance_cents = credit_balance_cents + _delta, updated_at = now()
   WHERE id = _client_id;
END; $$;

CREATE OR REPLACE FUNCTION public.tg_invoice_paid_credit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid' AND NEW.kind = 'prepaid_topup' THEN
    PERFORM public.post_credit_entry(
      NEW.organization_id, NEW.client_id, NEW.total_cents,
      'prepayment', NEW.id, NULL, 'Prepaid invoice payment'
    );
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER invoices_paid_credit
AFTER UPDATE ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.tg_invoice_paid_credit();

CREATE OR REPLACE FUNCTION public.generate_prepaid_invoice(_subscription_id uuid, _visit_count integer)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
  IF NOT public.can_write_org(auth.uid(), _org) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF _visit_count IS NULL OR _visit_count < 1 THEN RAISE EXCEPTION 'visit_count must be >= 1'; END IF;

  INSERT INTO public.invoices(organization_id, client_id, status, kind, issued_at)
  VALUES (_org, _client, 'open', 'prepaid_topup', now())
  RETURNING id INTO _invoice_id;

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
    _n := _n + 1;
    _min := LEAST(COALESCE(_min, _v.scheduled_on), _v.scheduled_on);
    _max := GREATEST(COALESCE(_max, _v.scheduled_on), _v.scheduled_on);
  END LOOP;

  IF _n = 0 THEN
    DELETE FROM public.invoices WHERE id = _invoice_id;
    RAISE EXCEPTION 'No upcoming scheduled visits to prepay';
  END IF;

  UPDATE public.invoices
     SET subtotal_cents = _total, total_cents = _total,
         period_start = _min, period_end = _max, updated_at = now()
   WHERE id = _invoice_id;

  RETURN _invoice_id;
END; $$;

CREATE OR REPLACE FUNCTION public.generate_invoice_for_client(_client_id uuid, _through date)
 RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  _org uuid; _invoice_id uuid; _v record;
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
   WHERE v.client_id = _client_id
     AND v.status = 'completed'
     AND v.scheduled_on <= _through
     AND li.id IS NULL
     AND s.billing_cadence = 'postpaid';

  IF _count = 0 THEN
    RAISE EXCEPTION 'No unbilled postpaid completed visits for this client through %', _through;
  END IF;

  INSERT INTO public.invoices(organization_id, client_id, period_start, period_end, status, kind, issued_at)
  VALUES (_org, _client_id, _min_date, _max_date, 'open', 'postpaid', now())
  RETURNING id INTO _invoice_id;

  FOR _v IN
    SELECT v.id AS visit_id, v.subscription_id, v.scheduled_on,
           s.price_cents, p.address_line1
      FROM public.visits v
      JOIN public.subscriptions s ON s.id = v.subscription_id
      LEFT JOIN public.properties p ON p.id = v.property_id
      LEFT JOIN public.invoice_line_items li ON li.visit_id = v.id
     WHERE v.client_id = _client_id
       AND v.status = 'completed'
       AND v.scheduled_on <= _through
       AND li.id IS NULL
       AND s.billing_cadence = 'postpaid'
     ORDER BY v.scheduled_on
  LOOP
    INSERT INTO public.invoice_line_items(invoice_id, visit_id, subscription_id, description, amount_cents)
    VALUES (_invoice_id, _v.visit_id, _v.subscription_id,
            'Service on ' || to_char(_v.scheduled_on, 'YYYY-MM-DD') || COALESCE(' — ' || _v.address_line1, ''),
            COALESCE(_v.price_cents, 0));
    _total := _total + COALESCE(_v.price_cents, 0);
  END LOOP;

  UPDATE public.invoices SET subtotal_cents = _total, total_cents = _total, updated_at = now()
   WHERE id = _invoice_id;
  RETURN _invoice_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_visit(_visit_id uuid)
 RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE _has_photo boolean; _sub_id uuid; _org uuid; _client uuid; _cadence public.billing_cadence; _price integer;
BEGIN
  IF NOT public.is_visit_tech(auth.uid(), _visit_id) THEN
    RAISE EXCEPTION 'Not authorized for this visit';
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.visit_photos WHERE visit_id = _visit_id AND kind = 'completion') INTO _has_photo;
  IF NOT _has_photo THEN
    RAISE EXCEPTION 'A completion photo is required before completing this visit';
  END IF;

  UPDATE public.visits
     SET status='completed', completed_at = now(),
         started_at = COALESCE(started_at, now()), updated_at = now()
   WHERE id = _visit_id AND status IN ('scheduled','in_progress');

  SELECT v.subscription_id, v.organization_id, v.client_id, s.billing_cadence, s.price_cents
    INTO _sub_id, _org, _client, _cadence, _price
    FROM public.visits v JOIN public.subscriptions s ON s.id = v.subscription_id
   WHERE v.id = _visit_id;

  IF _cadence = 'prepaid' AND COALESCE(_price, 0) > 0 THEN
    PERFORM public.post_credit_entry(_org, _client, -_price, 'visit_debit', NULL, _visit_id, 'Visit completed');
  END IF;
END;
$function$;
