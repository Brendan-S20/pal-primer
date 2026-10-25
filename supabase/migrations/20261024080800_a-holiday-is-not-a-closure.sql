-- A holiday is not a closure (#411 review, item 6).
--
-- invoice_stay and stay_visit_bill charged a sitting service's holiday
-- surcharge on a date in blackout_dates. A blackout means the business is
-- closed: the generator moves ordinary visits off it. A business that sits
-- pets over Christmas wants the holiday rate on the 24th and its walks
-- running as usual, and could not say so.
--
--   public.holiday_dates   per business, one row a date. A sitting visit on
--                          the date takes its service's holiday_surcharge_pct.
--                          Nothing is skipped or moved.
--
-- An overnight's visit is dated the evening it starts, so the night that
-- counts is the night that starts on the date: the night of Dec 24 starts on
-- the 24th.
--
-- stay_visit_bill reads holiday_dates instead of blackout_dates, and
-- invoice_stay now writes its lines through stay_visit_bill, so the two can
-- no longer disagree. restate_stay_billing already reads stay_visit_bill.
--
-- Invoices already written keep their lines. So a later change to a stay
-- does not lose its holiday rate, every blackout date that already has a stay
-- visit on it is copied into holiday_dates. A blackout with no stay visit is
-- not copied: it was a closure, and stays booked from now on will not be
-- charged a holiday rate for it unless the owner adds the date.
--
-- Reads: any member (the office books stays, and the rate is no secret).
-- Writes: can_write_org, one policy per command as blackout_dates has; the
-- server function asks manage_pricing, because the date sets a price.
--
-- Replays into an empty database: a table, a copy that finds no rows, and two
-- functions. No number is asserted.

CREATE TABLE IF NOT EXISTS public.holiday_dates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  holiday_on date NOT NULL,
  name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT holiday_dates_org_day_key UNIQUE (organization_id, holiday_on),
  CONSTRAINT holiday_dates_name_length CHECK (name IS NULL OR char_length(name) <= 200)
);

COMMENT ON TABLE public.holiday_dates IS
  'Dates a sitting visit takes its service''s holiday surcharge. Not a closure: nothing is skipped or moved. An overnight counts on the date its night starts. Migration 20261024080800.';

ALTER TABLE public.holiday_dates ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.holiday_dates');

DROP POLICY IF EXISTS "holiday read" ON public.holiday_dates;
CREATE POLICY "holiday read" ON public.holiday_dates
  FOR SELECT TO authenticated
  USING (public.is_org_member((SELECT auth.uid()), organization_id));
DROP POLICY IF EXISTS "holiday write (insert)" ON public.holiday_dates;
CREATE POLICY "holiday write (insert)" ON public.holiday_dates
  FOR INSERT TO authenticated
  WITH CHECK (public.can_write_org((SELECT auth.uid()), organization_id));
DROP POLICY IF EXISTS "holiday write (update)" ON public.holiday_dates;
CREATE POLICY "holiday write (update)" ON public.holiday_dates
  FOR UPDATE TO authenticated
  USING (public.can_write_org((SELECT auth.uid()), organization_id))
  WITH CHECK (public.can_write_org((SELECT auth.uid()), organization_id));
DROP POLICY IF EXISTS "holiday write (delete)" ON public.holiday_dates;
CREATE POLICY "holiday write (delete)" ON public.holiday_dates
  FOR DELETE TO authenticated
  USING (public.can_write_org((SELECT auth.uid()), organization_id));

REVOKE ALL ON TABLE public.holiday_dates FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.holiday_dates TO authenticated;
GRANT ALL ON TABLE public.holiday_dates TO service_role;

-- Blackout dates that already price a stay visit keep pricing it.
INSERT INTO public.holiday_dates(organization_id, holiday_on, name)
SELECT b.organization_id, b.blackout_on, b.reason
  FROM public.blackout_dates b
 WHERE EXISTS (SELECT 1 FROM public.visits v
                 JOIN public.subscriptions s ON s.id = v.subscription_id
                WHERE s.stay_id IS NOT NULL
                  AND v.organization_id = b.organization_id
                  AND v.scheduled_on = b.blackout_on)
ON CONFLICT (organization_id, holiday_on) DO NOTHING;

-- ── One stay visit as the invoice bills it ───────────────────────────────

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
      SELECT EXISTS (SELECT 1 FROM public.holiday_dates hd
                      WHERE hd.organization_id = v.organization_id AND hd.holiday_on = v.scheduled_on) AS holiday
    ) h
   WHERE v.id = _visit_id;
$function$;

REVOKE ALL ON FUNCTION public.stay_visit_bill(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stay_visit_bill(uuid) TO service_role;

-- ── invoice_stay writes its lines through stay_visit_bill ────────────────
-- The same body as 20261024080300 apart from the line INSERT.

CREATE OR REPLACE FUNCTION public.invoice_stay(_stay_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _st public.stays%ROWTYPE;
  _svc public.services%ROWTYPE;
  _inv uuid;
  _dep uuid;
  _total integer;
  _today date;
BEGIN
  SELECT * INTO _st FROM public.stays WHERE id = _stay_id FOR UPDATE;
  IF _st.id IS NULL THEN RAISE EXCEPTION 'Stay not found.'; END IF;
  IF _st.invoice_id IS NOT NULL THEN RETURN _st.invoice_id; END IF;
  IF _st.status NOT IN ('requested', 'confirmed') THEN RAISE EXCEPTION 'This stay cannot be invoiced.'; END IF;
  SELECT * INTO _svc FROM public.services WHERE id = _st.service_id;
  IF NOT EXISTS (SELECT 1 FROM public.visits v JOIN public.subscriptions s ON s.id = v.subscription_id WHERE s.stay_id = _st.id) THEN
    RAISE EXCEPTION 'Generate the stay visits before invoicing.';
  END IF;
  INSERT INTO public.invoices(organization_id, client_id, status, kind, issued_at, due_on, period_start, period_end, notes)
  VALUES (_st.organization_id, _st.client_id, 'open', 'postpaid', now(), _st.starts_on, _st.starts_on, _st.ends_on, 'Stay: ' || _svc.name)
  RETURNING id INTO _inv;
  INSERT INTO public.invoice_line_items(invoice_id, visit_id, subscription_id, description, amount_cents)
  SELECT _inv, v.id, s.id, b.description, b.amount_cents
  FROM public.visits v JOIN public.subscriptions s ON s.id = v.subscription_id
  CROSS JOIN LATERAL public.stay_visit_bill(v.id) b
  WHERE s.stay_id = _st.id ORDER BY v.scheduled_on, s.earliest_time;
  SELECT sum(amount_cents)::integer INTO _total FROM public.invoice_line_items WHERE invoice_id = _inv;
  PERFORM public.set_invoice_totals(_inv, _total);
  IF COALESCE(_st.deposit_cents, 0) > 0 THEN
    IF _st.deposit_cents > _total THEN RAISE EXCEPTION 'The deposit cannot exceed the stay price.'; END IF;
    SELECT (now() AT TIME ZONE COALESCE(o.timezone, 'America/Chicago'))::date INTO _today FROM public.organizations o WHERE o.id = _st.organization_id;
    INSERT INTO public.invoices(organization_id, client_id, status, kind, issued_at, due_on, period_start, period_end, notes)
    VALUES (_st.organization_id, _st.client_id, 'open', 'prepaid_topup', now(), _today, _today, _today,
      'Deposit for ' || _svc.name || '. Paid, it is credited to your account and comes off your stay invoice.') RETURNING id INTO _dep;
    INSERT INTO public.invoice_line_items(invoice_id, description, amount_cents)
    VALUES (_dep, 'Stay deposit: ' || _svc.name, _st.deposit_cents);
    UPDATE public.invoices SET subtotal_cents = _st.deposit_cents, total_cents = _st.deposit_cents,
      tax_rate_bps = 0, tax_cents = 0, tax_label = NULL WHERE id = _dep;
  END IF;
  UPDATE public.stays SET invoice_id = _inv, deposit_invoice_id = _dep WHERE id = _st.id;
  RETURN _inv;
END;
$function$;
REVOKE ALL ON FUNCTION public.invoice_stay(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_stay(uuid) TO service_role;

-- ── What this file establishes, checked from any starting state ───────────
DO $check$
BEGIN
  IF to_regclass('public.holiday_dates') IS NULL
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.holiday_dates'::regclass) THEN
    RAISE EXCEPTION 'holiday_dates is missing or has no row level security';
  END IF;
  IF has_table_privilege('anon', 'public.holiday_dates', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.holiday_dates', 'INSERT') THEN
    RAISE EXCEPTION 'holiday_dates has the wrong grants';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.stay_visit_bill(uuid)'::regprocedure) NOT LIKE '%holiday_dates%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.stay_visit_bill(uuid)'::regprocedure) LIKE '%blackout_dates%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.invoice_stay(uuid)'::regprocedure) NOT LIKE '%stay_visit_bill%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.invoice_stay(uuid)'::regprocedure) LIKE '%blackout_dates%' THEN
    RAISE EXCEPTION 'a stay bill still reads blackout dates';
  END IF;
  IF has_function_privilege('authenticated', 'public.invoice_stay(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.stay_visit_bill(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a stay billing helper is callable by signed-in users';
  END IF;
END
$check$;
