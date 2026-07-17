-- QA round 3 phase 1 adversarial-review fixes for credit application (B7/I8):
--
-- 1) Credit application no longer inserts a 'succeeded' payments row. Payments
--    is the cash ledger: royalty billing (generateRoyaltiesForParent), the
--    weekly digest, platform metrics, and franchise reports all compute
--    revenue as SUM(payments where succeeded). A credit application moves no
--    new money — the cash arrived when the credit was granted (e.g. a prepaid
--    top-up's Stripe payment). Recording it again double-counted revenue and
--    billed franchise royalties on phantom collections. The application is
--    fully audited without it: credit_ledger 'invoice_application' entry (with
--    the invoice reference) + invoices.credit_applied_cents + the activity log.
--
-- 2) Generation-time auto-apply now skips clients with ANY non-canceled
--    prepaid subscription (active OR paused). A paused prepaid client's credit
--    balance is still unconsumed prepayment; draining it into a postpaid
--    invoice (e.g. an addon charge billed during a seasonal pause) is exactly
--    the hazard the exclusion exists to prevent.
--
-- 3) Data fix: remove the phantom payments rows already minted by the previous
--    definition so revenue sums are correct retroactively (the feature shipped
--    hours ago; these rows are only credit applications, never Stripe cash).

DELETE FROM public.payments WHERE raw_event->>'source' = 'credit_application';

-- Same body as 20260717090000 minus the payments INSERT.
CREATE OR REPLACE FUNCTION public.apply_credit_to_invoice(_invoice_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _inv record;
  _balance integer;
  _open integer;
  _apply integer;
  _fully boolean;
BEGIN
  -- Serialize with the billing engine and with double-submitted staff clicks.
  PERFORM pg_advisory_xact_lock(hashtext('credit-apply:' || _invoice_id::text));

  SELECT * INTO _inv FROM public.invoices WHERE id = _invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  IF auth.uid() IS NOT NULL
     AND NOT public.has_permission(auth.uid(), _inv.organization_id, 'manage_client_billing') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  _open := GREATEST(COALESCE(_inv.total_cents, 0) - COALESCE(_inv.credit_applied_cents, 0), 0);

  IF _inv.status <> 'open' THEN
    RETURN jsonb_build_object(
      'applied_cents', 0,
      'remaining_due_cents', CASE WHEN _inv.status = 'draft' THEN _open ELSE 0 END,
      'invoice_status', _inv.status,
      'reason', 'not_open');
  END IF;

  -- Applying credit to a prepaid top-up would be circular: paying a top-up
  -- grants credit (tg_invoice_paid_credit), so credit would buy itself back.
  IF _inv.kind = 'prepaid_topup' THEN
    RETURN jsonb_build_object(
      'applied_cents', 0,
      'remaining_due_cents', _open,
      'invoice_status', _inv.status,
      'reason', 'prepaid_topup');
  END IF;

  IF _open <= 0 THEN
    RETURN jsonb_build_object(
      'applied_cents', 0,
      'remaining_due_cents', 0,
      'invoice_status', _inv.status,
      'reason', 'nothing_due');
  END IF;

  -- Lock the client row so a concurrent application can't double-spend the
  -- same balance.
  SELECT credit_balance_cents INTO _balance
    FROM public.clients WHERE id = _inv.client_id FOR UPDATE;

  _apply := LEAST(GREATEST(COALESCE(_balance, 0), 0), _open);
  IF _apply <= 0 THEN
    RETURN jsonb_build_object(
      'applied_cents', 0,
      'remaining_due_cents', _open,
      'invoice_status', _inv.status,
      'reason', 'no_credit');
  END IF;

  _fully := (_apply >= _open);

  PERFORM public.post_credit_entry(
    _inv.organization_id, _inv.client_id, -_apply, 'invoice_application',
    _invoice_id, NULL,
    'Applied to invoice #' || left(_invoice_id::text, 8));

  -- Deliberately NO payments row: payments is the cash ledger and credit
  -- application moves no new cash (see migration header).

  UPDATE public.invoices
     SET credit_applied_cents = COALESCE(credit_applied_cents, 0) + _apply,
         status  = CASE WHEN _fully THEN 'paid'::public.invoice_status ELSE status END,
         paid_at = CASE WHEN _fully THEN now() ELSE paid_at END,
         updated_at = now()
   WHERE id = _invoice_id;

  RETURN jsonb_build_object(
    'applied_cents', _apply,
    'remaining_due_cents', _open - _apply,
    'invoice_status', CASE WHEN _fully THEN 'paid' ELSE 'open' END,
    'reason', 'applied');
END;
$$;

REVOKE ALL ON FUNCTION public.apply_credit_to_invoice(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_credit_to_invoice(uuid) TO authenticated, service_role;

-- admin_generate_invoice_for_client: only the auto-apply exclusion changes —
-- any non-canceled prepaid subscription (active OR paused) blocks auto-apply.
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
    -- CLAIM the charge first (status guard): if a concurrent run already
    -- flipped it to 'invoiced' (or it was voided/paid meanwhile), NOT FOUND --
    -- skip the line item instead of billing the addon twice.
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

  -- Everything we counted was claimed by a concurrent run before we could
  -- bill it: delete the empty shell instead of leaving a $0 open invoice.
  IF NOT EXISTS (
    SELECT 1 FROM public.invoice_line_items WHERE invoice_id = _invoice_id
  ) THEN
    DELETE FROM public.invoices WHERE id = _invoice_id;
    RETURN NULL;
  END IF;

  UPDATE public.invoices SET subtotal_cents = _total, total_cents = _total, updated_at = now()
   WHERE id = _invoice_id;

  -- I8: credits auto-applied first — nightly invoices go out net of credit.
  -- Skipped for clients with ANY non-canceled prepaid subscription (active OR
  -- paused): their balance is unconsumed prepayment, not general credit, and
  -- a pause must not turn it into payment for postpaid charges.
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

REVOKE EXECUTE ON FUNCTION public.admin_generate_invoice_for_client(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_generate_invoice_for_client(uuid, date) TO service_role;
