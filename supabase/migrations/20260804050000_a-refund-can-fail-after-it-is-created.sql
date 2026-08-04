-- A refund is not final when it is created.
--
-- `charge.refunded` fires the moment a refund is submitted. It can still FAIL
-- afterwards — a closed card, a rejected ACH return, a bank that will not take
-- it — and Stripe reports that as `charge.refund.updated` with the refund's
-- status moving to `failed` or `canceled`. When that happens the money never
-- left, and Stripe DECREMENTS `charge.amount_refunded` accordingly.
--
-- Nothing here listened for that. The reversal ledger recorded the refund at
-- submission and kept it for ever, so a failed refund permanently removed
-- revenue the tenant still had. It is the exact inverse of the partial-refund
-- bug fixed alongside it, and both were invisible for the same reason: the
-- ledger only ever learned about a refund once.
--
-- ── WHY THIS NEEDS A SEPARATE MODE ────────────────────────────────────────
--
-- The partial-refund fix made repeat filings MONOTONIC — GREATEST, never
-- lower — because `amount_refunded` is cumulative and webhook delivery is not
-- ordered, so a late redelivery of an earlier event must not walk the total
-- back. That is right for events that CARRY an amount.
--
-- A failure has to lower it, and monotonic-up cannot. So `_authoritative`:
-- the caller is not passing a number the event carried, it is passing what it
-- just re-read from Stripe, which is the current truth by construction. Ordering
-- does not apply to a value fetched now.
--
-- Deliberately a second parameter rather than "let refunds always overwrite".
-- Overwrite-always would reintroduce the out-of-order bug on the ordinary path,
-- where the number DOES come from the event. The two cases genuinely differ in
-- where the figure came from, and the parameter is what records that.

CREATE OR REPLACE FUNCTION public.file_reversal_review_item(
  _org_id uuid,
  _payment_id uuid,
  _kind text,
  _amount_cents bigint,
  _adjustment_id uuid DEFAULT NULL::uuid,
  _dispute_ref text DEFAULT NULL::text,
  _revenue_cents bigint DEFAULT NULL::bigint,
  -- TRUE only when the caller re-read the figure from Stripe rather than taking
  -- it from the event payload. Then it replaces the stored total instead of
  -- raising it, which is the only way a failed refund can be undone.
  _authoritative boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _item_kind text;
  _reason text;
  _money text := '$' || to_char(_amount_cents / 100.0, 'FM999999990.00');
  _ref text := coalesce(_dispute_ref, '');
  _revenue bigint := coalesce(_revenue_cents, _amount_cents);
  _id uuid;
BEGIN
  _item_kind := CASE _kind
    WHEN 'refund' THEN 'payment_refunded'
    WHEN 'chargeback' THEN 'payment_chargeback'
    WHEN 'chargeback_won' THEN 'payment_chargeback_won'
    WHEN 'chargeback_lost' THEN 'payment_chargeback_lost'
    WHEN 'dispute_inquiry' THEN 'payment_dispute_inquiry'
    WHEN 'dispute_inquiry_closed' THEN 'payment_dispute_inquiry_closed'
    ELSE NULL END;
  IF _item_kind IS NULL THEN RETURN NULL; END IF;

  -- A refund is not a dispute and has no dispute id; forcing one in would split
  -- its idempotency key and let a redelivered refund file twice.
  IF _item_kind = 'payment_refunded' THEN _ref := ''; END IF;

  -- A refund that failed back to zero is not a reversal at all. Removing the
  -- row is more honest than leaving a $0.00 line in a ledger of things that
  -- happened, and the contra line disappears with it.
  IF _authoritative AND _amount_cents <= 0 THEN
    DELETE FROM public.review_items
     WHERE organization_id = _org_id AND kind = _item_kind
       AND subject_id = _payment_id AND dispute_ref = _ref;
    RETURN NULL;
  END IF;

  _reason := CASE _kind
    WHEN 'refund' THEN _money || ' was refunded to a customer. This revenue has been removed from your totals; if it was already counted in a franchise settlement it carries into the next one.'
    WHEN 'chargeback' THEN _money || ' was charged back by a customer''s bank. The money has left the account. You have limited time to submit evidence if you want to dispute it.'
    WHEN 'chargeback_won' THEN _money || ' chargeback was WON — the money has been returned and any deduction taken for it has been reversed.'
    WHEN 'dispute_inquiry' THEN 'A customer''s bank has queried a ' || _money || ' charge. NO money has been taken and your revenue is unchanged. Answering the inquiry is how it stays that way — an unanswered inquiry is what becomes a chargeback.'
    WHEN 'dispute_inquiry_closed' THEN 'The bank''s query about a ' || _money || ' charge was dropped without becoming a chargeback. No money ever left the account and none is owed.'
    ELSE 'The ' || _money || ' chargeback was decided in the customer''s favour. No further money moves — it left when the dispute opened — but this sale is now final as lost.'
  END;

  INSERT INTO public.review_items (
    organization_id, kind, subject_table, subject_id, reason, detail, dispute_ref
  )
  VALUES (
    _org_id, _item_kind, 'payments', _payment_id, _reason,
    jsonb_build_object(
      'amount_cents', _amount_cents,
      'revenue_cents', _revenue,
      'adjustment_id', _adjustment_id,
      'dispute_id', nullif(_ref, '')
    ),
    _ref
  )
  ON CONFLICT (organization_id, kind, subject_id, dispute_ref) DO UPDATE
    SET detail = review_items.detail || jsonb_build_object(
          'amount_cents', CASE WHEN _authoritative THEN _amount_cents ELSE
            GREATEST(COALESCE((review_items.detail->>'amount_cents')::bigint, 0), _amount_cents) END,
          'revenue_cents', CASE WHEN _authoritative THEN _revenue ELSE
            GREATEST(COALESCE((review_items.detail->>'revenue_cents')::bigint, 0), _revenue) END
        ),
        -- adjustment_id is deliberately NOT touched: the franchise adjustment
        -- belongs to the first filing's settlement row.
        reason = CASE
          WHEN _authoritative
            OR _amount_cents >= COALESCE((review_items.detail->>'amount_cents')::bigint, 0)
          THEN EXCLUDED.reason ELSE review_items.reason END
  RETURNING id INTO _id;

  RETURN _id;
END;
$function$;

COMMENT ON FUNCTION public.file_reversal_review_item(uuid, uuid, text, bigint, uuid, text, bigint, boolean) IS
  'Files one reversal per (org, kind, payment, dispute). Stripe amount_refunded is CUMULATIVE, so an ordinary repeat filing RAISES the stored total — DO NOTHING once dropped every partial refund after the first. _authoritative=true replaces it instead, and is only for a figure the caller re-read from Stripe (a refund that FAILED after creation, where the money never left and amount_refunded went back down). detail.amount_cents is what MOVED; detail.revenue_cents is what comes off income.';

DROP FUNCTION IF EXISTS public.file_reversal_review_item(uuid, uuid, text, bigint, uuid, text, bigint);
