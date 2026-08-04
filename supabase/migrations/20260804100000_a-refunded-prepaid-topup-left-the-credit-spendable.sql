-- A refunded prepaid top-up gave the money back and left the credit spendable.
--
-- `tg_invoice_paid_credit` (20260701163602) grants `total_cents` of credit the
-- moment a `prepaid_topup` invoice flips to paid. The refund handler touches
-- `payments.status`, `review_items`, `franchise_adjustments` and the
-- application fee — and never `credit_ledger`.
--
-- So: a client buys $500 of credit, changes their mind, the tenant refunds
-- $500 in Stripe. The webhook records the reversal, marks the payment
-- refunded, and the balance stays at $500. `apply_credit_to_invoice` then
-- spends it against future invoices. The same dollars are counted twice and
-- nothing anywhere reports it.
--
-- ── A TARGET, NOT AN INCREMENT ────────────────────────────────────────────
--
-- `amount_refunded` is cumulative and `charge.refunded` fires once per refund,
-- so adding the refunded amount each time would over-reverse from the second
-- partial refund onward — the same trap the application-fee reversal and the
-- reversal ledger both had to be written around. This computes the total that
-- should have been clawed back by now, subtracts what already has been, and
-- posts only the difference. A redelivery computes zero.
--
-- Capped at what was granted, so an over-refund cannot drive the balance
-- negative, and it returns 0 immediately for any payment whose invoice is not
-- a top-up — which is nearly all of them.
--
-- ── ONE BUG THE PROBE CAUGHT ──────────────────────────────────────────────
--
-- The first draft read `p.client_id`. `payments` has no such column — it holds
-- `organization_id` and `invoice_id` and nothing else identifying the client —
-- so it would have thrown on the first refunded top-up in production, inside
-- the webhook, after the reversal had already been recorded. It comes from the
-- invoice instead.
--
-- Verified live, rolled back after: $500 granted → full refund nets to 0 →
-- redelivery reverses 0 more → a $200 then cumulative $350 refund leaves
-- $150 → an ordinary postpaid invoice reverses nothing.

CREATE OR REPLACE FUNCTION public.reverse_prepaid_credit_for_payment(
  _payment_id uuid,
  _refunded_cents bigint
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  _org uuid; _client uuid; _inv uuid; _kind text; _granted bigint;
  _target bigint; _already bigint; _delta bigint;
BEGIN
  SELECT p.organization_id, i.client_id, p.invoice_id, i.kind::text, i.total_cents
    INTO _org, _client, _inv, _kind, _granted
    FROM public.payments p
    JOIN public.invoices i ON i.id = p.invoice_id
   WHERE p.id = _payment_id;

  IF _inv IS NULL OR _kind IS DISTINCT FROM 'prepaid_topup' THEN
    RETURN 0;
  END IF;

  _target := LEAST(GREATEST(_refunded_cents, 0), COALESCE(_granted, 0));

  SELECT COALESCE(-SUM(delta_cents), 0) INTO _already
    FROM public.credit_ledger
   WHERE invoice_id = _inv AND kind = 'refund';

  _delta := _target - _already;
  IF _delta = 0 THEN RETURN 0; END IF;

  INSERT INTO public.credit_ledger (organization_id, client_id, delta_cents, kind, invoice_id, note)
  VALUES (_org, _client, -_delta, 'refund', _inv,
          'Prepaid top-up refunded (payment ' || _payment_id::text || ')');

  RETURN _delta;
END;
$function$;

COMMENT ON FUNCTION public.reverse_prepaid_credit_for_payment(uuid, bigint) IS
  'Removes prepaid credit when the top-up that granted it is refunded. Writes a TARGET, not an increment, so redelivery and partial refunds converge; capped at what was granted; returns 0 for any payment whose invoice is not a top-up.';

REVOKE ALL ON FUNCTION public.reverse_prepaid_credit_for_payment(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_prepaid_credit_for_payment(uuid, bigint) TO service_role;
