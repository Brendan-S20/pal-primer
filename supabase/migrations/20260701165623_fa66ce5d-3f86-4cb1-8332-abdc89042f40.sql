
-- 1. Hazard fields on properties
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS aggressive_dog boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bees_wasps boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sharp_objects boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS slippery_surfaces boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS do_not_enter_if_dog_out boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hazard_notes text,
  ADD COLUMN IF NOT EXISTS yard_size text CHECK (yard_size IN ('small','medium','large','xlarge'));

-- 2. Skip reason enum
DO $$ BEGIN
  CREATE TYPE public.skip_reason_code AS ENUM (
    'client_cancelled_late','gate_locked','dog_outside','weather',
    'our_fault','access_blocked','unsafe_conditions','other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.visits
  ADD COLUMN IF NOT EXISTS skip_reason_code public.skip_reason_code,
  ADD COLUMN IF NOT EXISTS skip_billable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS skip_charge_cents integer NOT NULL DEFAULT 0;

-- 3. Per-org skip billing rules
CREATE TABLE IF NOT EXISTS public.skip_billing_rules (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  reason_code public.skip_reason_code NOT NULL,
  billable_pct integer NOT NULL DEFAULT 0 CHECK (billable_pct BETWEEN 0 AND 100),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, reason_code)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.skip_billing_rules TO authenticated;
GRANT ALL ON public.skip_billing_rules TO service_role;
ALTER TABLE public.skip_billing_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members read skip rules" ON public.skip_billing_rules
  FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "managers write skip rules" ON public.skip_billing_rules
  FOR ALL TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id))
  WITH CHECK (public.can_write_org(auth.uid(), organization_id));

-- Sensible defaults per reason (industry-typical)
CREATE OR REPLACE FUNCTION public.default_skip_billable_pct(_code public.skip_reason_code)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE _code
    WHEN 'client_cancelled_late' THEN 100
    WHEN 'gate_locked'           THEN 100
    WHEN 'dog_outside'           THEN 100
    WHEN 'access_blocked'        THEN 100
    WHEN 'unsafe_conditions'     THEN 50
    WHEN 'weather'               THEN 0
    WHEN 'our_fault'             THEN 0
    WHEN 'other'                 THEN 0
  END
$$;

-- 4. Updated skip_visit: reason code + free text, applies org rule
CREATE OR REPLACE FUNCTION public.skip_visit(
  _visit_id uuid,
  _reason text,
  _code public.skip_reason_code DEFAULT 'other'
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org uuid; _price integer; _pct integer; _charge integer;
BEGIN
  IF NOT public.is_visit_tech(auth.uid(), _visit_id) THEN
    RAISE EXCEPTION 'Not authorized for this visit';
  END IF;
  IF _reason IS NULL OR length(trim(_reason)) = 0 THEN
    RAISE EXCEPTION 'A reason is required to skip a visit';
  END IF;

  SELECT v.organization_id, s.price_cents
    INTO _org, _price
    FROM public.visits v
    JOIN public.subscriptions s ON s.id = v.subscription_id
   WHERE v.id = _visit_id;

  SELECT billable_pct INTO _pct
    FROM public.skip_billing_rules
   WHERE organization_id = _org AND reason_code = _code;
  IF _pct IS NULL THEN
    _pct := public.default_skip_billable_pct(_code);
  END IF;

  _charge := ROUND(COALESCE(_price, 0) * _pct / 100.0)::int;

  UPDATE public.visits
     SET status = 'skipped',
         skip_reason = _reason,
         skip_reason_code = _code,
         skip_billable = (_charge > 0),
         skip_charge_cents = _charge,
         updated_at = now()
   WHERE id = _visit_id AND status IN ('scheduled','in_progress');
END; $$;

-- 5. Invoice generator now also picks up billable skips
CREATE OR REPLACE FUNCTION public.generate_invoice_for_client(_client_id uuid, _through date)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
     AND v.scheduled_on <= _through
     AND li.id IS NULL
     AND s.billing_cadence = 'postpaid'
     AND (v.status = 'completed' OR (v.status = 'skipped' AND v.skip_billable = true));

  IF _count = 0 THEN
    RAISE EXCEPTION 'No unbilled billable visits for this client through %', _through;
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
        _desc := 'Service on ' || to_char(_v.scheduled_on, 'YYYY-MM-DD') || COALESCE(' — ' || _v.address_line1, '');
      END IF;
      INSERT INTO public.invoice_line_items(invoice_id, visit_id, subscription_id, description, amount_cents)
      VALUES (_invoice_id, _v.visit_id, _v.subscription_id, _desc, _amt);
      _total := _total + _amt;
    END;
  END LOOP;

  UPDATE public.invoices SET subtotal_cents = _total, total_cents = _total, updated_at = now()
   WHERE id = _invoice_id;
  RETURN _invoice_id;
END;
$$;

-- Also update the org-wide generator's WHERE clause to match
CREATE OR REPLACE FUNCTION public.generate_invoices_for_org(_org_id uuid, _through date)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _c record; _n integer := 0;
BEGIN
  IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  FOR _c IN
    SELECT DISTINCT v.client_id
      FROM public.visits v
      JOIN public.subscriptions s ON s.id = v.subscription_id
      LEFT JOIN public.invoice_line_items li ON li.visit_id = v.id
     WHERE v.organization_id = _org_id
       AND v.scheduled_on <= _through
       AND li.id IS NULL
       AND s.billing_cadence = 'postpaid'
       AND (v.status = 'completed' OR (v.status = 'skipped' AND v.skip_billable = true))
  LOOP
    PERFORM public.generate_invoice_for_client(_c.client_id, _through);
    _n := _n + 1;
  END LOOP;
  RETURN _n;
END; $$;

GRANT EXECUTE ON FUNCTION public.default_skip_billable_pct(public.skip_reason_code) TO authenticated;
