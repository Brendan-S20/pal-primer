-- B7 / I8: server-side credit application.
--
-- 1) invoices.credit_applied_cents — the partial-payment concept the schema
--    lacked. An invoice's open (due) amount is total_cents - credit_applied_cents;
--    every AR/open-amount computation (src/lib/ar.ts, dashboards, reports,
--    charge amounts) subtracts it.
-- 2) credit_ledger kind 'invoice_application' — the debit entry recorded when
--    credit is applied to an invoice, via the same post_credit_entry RPC every
--    other ledger writer uses, so balance and ledger never drift.
-- 3) apply_credit_to_invoice(_invoice_id) — the single authoritative
--    application routine (staff action, autopay pre-step, and generation-time
--    auto-apply all call it). Idempotent and concurrency-safe: advisory lock +
--    row locks; a double-click or concurrent nightly run finds no remaining
--    credit/due and applies nothing.
-- 4) admin_generate_invoice_for_client — redefined (wave-2 body unchanged
--    otherwise) to auto-apply available credit at generation time (I8 "credits
--    auto-applied first"), so nightly invoices go out net of credit. Skipped
--    for clients with an active prepaid subscription: their credit balance is
--    prepayment being consumed by visit_debit entries, not general credit, and
--    draining it into a postpaid invoice would break the prepaid flow.
--
-- Reconciliation decision (I5/I6): existing credit balances are deliberately
-- NOT retroactively applied to existing open invoices by this migration.
-- Auto-applying historical credit would silently move money on records staff
-- have already seen and possibly discussed with clients (I6: never silently
-- alter historical billing). Staff apply existing credits explicitly via the
-- new "Apply credit" action, which records ledger + payment + activity rows.

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS credit_applied_cents integer NOT NULL DEFAULT 0;

ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_credit_applied_range;
ALTER TABLE public.invoices ADD CONSTRAINT invoices_credit_applied_range
  CHECK (credit_applied_cents >= 0 AND credit_applied_cents <= total_cents);

ALTER TABLE public.credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_kind_check;
ALTER TABLE public.credit_ledger ADD CONSTRAINT credit_ledger_kind_check
  CHECK (kind = ANY (ARRAY['prepayment','visit_debit','refund','adjustment',
                           'referral_reward','referral_bonus','addon_debit',
                           'invoice_application']));

-- The single credit-application routine.
--
-- Returns jsonb: { applied_cents, remaining_due_cents, invoice_status, reason }
--   reason: 'applied' | 'no_credit' | 'nothing_due' | 'not_open' | 'prepaid_topup'
--
-- Authorization: staff need manage_client_billing (checked in-function against
-- the invoice's org). Service-role callers (nightly autopay, billing engine)
-- have auth.uid() IS NULL and are allowed; anon cannot execute at all.
--
-- Money movement per application (atomic, one transaction):
--   * credit_ledger: -N 'invoice_application' entry (post_credit_entry also
--     decrements clients.credit_balance_cents)
--   * payments: a succeeded row with raw_event.source='credit_application'
--     (payments has no method column; the raw_event note is the instrument
--     record, matching the existing manual_mark_paid pattern)
--   * invoices: credit_applied_cents += N; flipped to paid (paid_at=now())
--     only when fully covered.
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

  INSERT INTO public.payments(organization_id, invoice_id, amount_cents, currency, status, paid_at, raw_event)
  VALUES (_inv.organization_id, _invoice_id, _apply, COALESCE(_inv.currency, 'usd'),
          'succeeded', now(),
          jsonb_build_object('source', 'credit_application'));

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

-- admin_generate_invoice_for_client: identical to 20260716235000 (claim-based
-- addon flip, empty-shell delete) plus generation-time credit auto-apply at
-- the end. See the header comment for the prepaid-subscription exclusion.
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
  -- Skipped for clients with an active prepaid subscription (their balance is
  -- prepayment consumed by visit_debit, not general credit). apply_credit_to_
  -- invoice is a no-op when the balance is zero and marks the invoice paid
  -- when fully covered; auto-send only emails invoices still 'open'.
  IF NOT EXISTS (
    SELECT 1 FROM public.subscriptions s
     WHERE s.client_id = _client_id
       AND s.billing_cadence = 'prepaid'
       AND s.status = 'active'
  ) THEN
    PERFORM public.apply_credit_to_invoice(_invoice_id);
  END IF;

  RETURN _invoice_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_generate_invoice_for_client(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_generate_invoice_for_client(uuid, date) TO service_role;
