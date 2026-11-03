-- Cash and checks can be given back, with a reason (#653 part 2, F-09).
--
-- A refund issued through Stripe has been recorded since #674. Money that was
-- never in Stripe could not be given back at all: a check that bounced, cash
-- returned at the door, a payment recorded against the wrong invoice. The
-- office now records it here, against the payment, with a reason it must give.
--
--   _reverse = false   a refund: the money went back to the customer. The
--                      invoice keeps its status, as a Stripe refund does
--                      (20261102130000), and reads Refunded / Partly refunded.
--   _reverse = true    a reversal: the money never really arrived (a bounced
--                      check, a payment recorded in error). A paid invoice
--                      that is now owed something goes back to open.
--
-- Either way the payment row is marked the way the Stripe webhook marks one
-- (status 'refunded', refunded_cents), so invoice_paid_cents and every
-- balance follow, and a dated 'payment_refunded' review item is filed
-- (already resolved, because the office did it) so the reversal register,
-- /reports, the CPA pack and franchise_rollup deduct it on the day it
-- happened. One per payment: the register keeps one cumulative row a payment.
CREATE OR REPLACE FUNCTION public.refund_manual_payment(
  _payment_id uuid,
  _amount_cents integer,
  _reason text,
  _reverse boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _p public.payments%ROWTYPE;
  _inv public.invoices%ROWTYPE;
  _why text := btrim(COALESCE(_reason, ''));
  _tax integer;
  _reopened boolean := false;
  _parent uuid;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to record a refund' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO _p FROM public.payments WHERE id = _payment_id FOR UPDATE;
  IF _p.id IS NULL
     OR NOT public.has_permission(_uid, _p.organization_id, 'manage_client_billing') THEN
    RAISE EXCEPTION 'Only someone who manages billing can record a refund' USING ERRCODE = '42501';
  END IF;
  IF _p.stripe_payment_intent_id IS NOT NULL THEN
    RAISE EXCEPTION 'This payment went through Stripe. Refund it from the invoice, and Stripe returns the money.'
      USING ERRCODE = '22023';
  END IF;
  IF _p.status <> 'succeeded' OR _p.refunded_cents > 0
     OR EXISTS (SELECT 1 FROM public.review_items ri
                 WHERE ri.organization_id = _p.organization_id
                   AND ri.kind = 'payment_refunded' AND ri.subject_id = _p.id) THEN
    RAISE EXCEPTION 'A refund is already recorded on this payment' USING ERRCODE = '22023';
  END IF;
  IF char_length(_why) < 3 OR char_length(_why) > 300 THEN
    RAISE EXCEPTION 'Say why the money is going back (3 to 300 characters)' USING ERRCODE = '22023';
  END IF;
  IF _amount_cents IS NULL OR _amount_cents < 1 OR _amount_cents > _p.amount_cents THEN
    RAISE EXCEPTION 'Enter an amount from $0.01 to %',
      '$' || to_char(_p.amount_cents / 100.0, 'FM999,999,990.00') USING ERRCODE = '22023';
  END IF;

  SELECT * INTO _inv FROM public.invoices WHERE id = _p.invoice_id FOR UPDATE;
  -- The payment's own tax share, pro rata, as splitRefund takes it.
  _tax := CASE WHEN _p.amount_cents > 0
               THEN LEAST(COALESCE(_p.tax_cents, 0),
                          round(_amount_cents::numeric * COALESCE(_p.tax_cents, 0) / _p.amount_cents)::integer)
               ELSE 0 END;

  UPDATE public.payments
     SET status = 'refunded', refunded_cents = _amount_cents, updated_at = now()
   WHERE id = _p.id;

  -- A prepaid top-up's credit comes back off the account, as a Stripe refund
  -- of one does. A linked stay deposit has none (it returns 0).
  PERFORM public.reverse_prepaid_credit_for_payment(_p.id, _amount_cents);

  INSERT INTO public.review_items (organization_id, kind, subject_table, subject_id, reason, detail,
                                   status, detected_at, resolved_at, resolved_by, resolution_note)
  VALUES (_p.organization_id, 'payment_refunded', 'payments', _p.id,
          left((CASE WHEN _reverse THEN 'Reversed: ' ELSE 'Refunded: ' END) || _why, 500),
          jsonb_build_object(
            'amount_cents', _amount_cents,
            'revenue_cents', _amount_cents - _tax,
            'tax_cents', _tax,
            'invoice_id', _p.invoice_id,
            'method', _p.method,
            'offline', true,
            'reversal', _reverse,
            'reason', _why,
            'recorded_by', _uid),
          'resolved', now(), now(), _uid, left(_why, 500));

  -- A reversal: the money was never kept, so a paid invoice is owed again.
  -- Measured on the stay invoice when this was its deposit's payment.
  _parent := COALESCE(_inv.deposit_for_invoice_id, _inv.id);
  IF _reverse THEN
    UPDATE public.invoices i
       SET status = 'open', paid_at = NULL, updated_at = now()
     WHERE i.id IN (_inv.id, _parent)
       AND i.status = 'paid'
       AND COALESCE(i.total_cents, 0) - COALESCE(i.credit_applied_cents, 0)
           - COALESCE(i.amount_paid_cents, 0) > 0;
    _reopened := FOUND;
  END IF;

  RETURN jsonb_build_object(
    'payment_id', _p.id,
    'invoice_id', _p.invoice_id,
    'organization_id', _p.organization_id,
    'client_id', _inv.client_id,
    'amount_cents', _amount_cents,
    'reversal', _reverse,
    'reopened', _reopened);
END;
$function$;

REVOKE ALL ON FUNCTION public.refund_manual_payment(uuid, integer, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refund_manual_payment(uuid, integer, text, boolean) TO authenticated, service_role;

-- Replays into an empty database: one function and a check of its grants.

DO $check$
BEGIN
  IF has_function_privilege('anon', 'public.refund_manual_payment(uuid, integer, text, boolean)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.refund_manual_payment(uuid, integer, text, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'refund_manual_payment has the wrong grants';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc
           WHERE oid = 'public.refund_manual_payment(uuid, integer, text, boolean)'::regprocedure)
     OR (SELECT prosrc FROM pg_proc
          WHERE oid = 'public.refund_manual_payment(uuid, integer, text, boolean)'::regprocedure)
        NOT LIKE '%manage_client_billing%' THEN
    RAISE EXCEPTION 'refund_manual_payment does not ask who may give money back';
  END IF;
END
$check$;
