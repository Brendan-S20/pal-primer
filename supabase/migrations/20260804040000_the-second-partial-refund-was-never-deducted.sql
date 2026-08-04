-- Two defects in the reversal ledger, both of which OVERSTATE or UNDERSTATE a
-- tenant's revenue permanently and neither of which raises an error.
--
-- ── 1. THE SECOND PARTIAL REFUND WAS THROWN AWAY ──────────────────────────
--
-- `file_reversal_review_item` ends in
--
--     ON CONFLICT (organization_id, kind, subject_id, dispute_ref) DO NOTHING
--
-- and for a refund `_ref` is forced to '' (correctly — a refund is not a
-- dispute and has no dispute id). So every refund on a given payment collapses
-- onto ONE key.
--
-- That is right for a redelivered webhook and wrong for a real second refund,
-- because Stripe's `amount_refunded` is CUMULATIVE and `charge.refunded` fires
-- once per refund:
--
--     $100 charge, refund $30  → amount_refunded = 3000 → row filed at 3000
--     later, refund $50 more   → amount_refunded = 8000 → DO NOTHING
--
-- The ledger says $30 for ever. $50 that left the bank is still counted as
-- revenue, and nothing anywhere reports a problem.
--
-- The intent behind DO NOTHING was idempotency, and the mechanism was the
-- mistake: a cumulative total should be written monotonically, not deduped on
-- identity. DO UPDATE with GREATEST gives both — a replay writes the same
-- number and changes nothing, a genuine second refund raises it, and an
-- out-of-order redelivery of the OLDER event cannot lower it back. Webhook
-- delivery is explicitly not ordered, so "take the max" is not defensive
-- decoration; it is the only form of this that survives a retry landing late.
--
-- ── 2. THE SURCHARGE WAS DEDUCTED FROM REVENUE IT WAS NEVER IN ────────────
--
-- With pass-through on, a $100 invoice is charged as $103. `payments` keeps
-- those apart deliberately — `surcharge_cents` beside `amount_cents`, so the
-- recovered fee is reported as fee recovery and never as revenue.
--
-- The refund path ignored the split: `amount_refunded` is on the CHARGE, so it
-- is base + surcharge, and it went straight into the ledger that every revenue
-- surface subtracts. Refunding that charge took $103 off revenue containing
-- $100 — the tenant's income understated by exactly the fee they never earned.
--
-- Both numbers are true and they are not the same, so the row now carries both.
-- `amount_cents` stays what MOVED (what the customer got back, what the alert
-- quotes, what reconciles against Stripe) and `revenue_cents` is what comes off
-- income. src/lib/refund-split.ts does the division, proportionally, matching
-- what platform-fee.ts already does when reversing the application fee.
--
-- `_revenue_cents` defaults to NULL so any caller that has not been updated
-- keeps the old behaviour exactly: readers fall back to `amount_cents`.

CREATE OR REPLACE FUNCTION public.file_reversal_review_item(
  _org_id uuid,
  _payment_id uuid,
  _kind text,
  _amount_cents bigint,
  _adjustment_id uuid DEFAULT NULL::uuid,
  _dispute_ref text DEFAULT NULL::text,
  _revenue_cents bigint DEFAULT NULL::bigint
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
  -- Absent means "no split known" — the pre-surcharge behaviour, and what an
  -- un-updated caller gets.
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

  _reason := CASE _kind
    WHEN 'refund' THEN _money || ' was refunded to a customer. This revenue has been removed from your totals; if it was already counted in a franchise settlement it carries into the next one.'
    WHEN 'chargeback' THEN _money || ' was charged back by a customer''s bank. The money has left the account. You have limited time to submit evidence in Stripe if you want to dispute it.'
    WHEN 'chargeback_won' THEN _money || ' chargeback was WON — the money has been returned and any deduction taken for it has been reversed.'
    WHEN 'dispute_inquiry' THEN 'A customer''s bank has queried a ' || _money || ' charge. NO money has been taken and your revenue is unchanged. Answering the inquiry in Stripe is how it stays that way — an unanswered inquiry is what becomes a chargeback.'
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
    -- Raise to the new cumulative total; never lower. A replayed webhook writes
    -- the same figure, a real second partial refund writes a bigger one, and an
    -- out-of-order redelivery of an earlier event cannot walk it back.
    SET detail = review_items.detail || jsonb_build_object(
          'amount_cents',
            GREATEST(COALESCE((review_items.detail->>'amount_cents')::bigint, 0), _amount_cents),
          'revenue_cents',
            GREATEST(COALESCE((review_items.detail->>'revenue_cents')::bigint, 0), _revenue)
        ),
        -- `adjustment_id` is deliberately NOT touched on update. The franchise
        -- adjustment was recorded against the first filing and re-pointing it
        -- to a later one would orphan the settlement row it belongs to.
        -- Keep the human-readable line in step with the number above it, or the
        -- alert keeps quoting the first partial refund for ever.
        reason = CASE
          WHEN _amount_cents >= COALESCE((review_items.detail->>'amount_cents')::bigint, 0)
          THEN EXCLUDED.reason ELSE review_items.reason END
  RETURNING id INTO _id;

  RETURN _id;
END;
$function$;

COMMENT ON FUNCTION public.file_reversal_review_item(uuid, uuid, text, bigint, uuid, text, bigint) IS
  'Files one reversal per (org, kind, payment, dispute). Stripe amount_refunded is CUMULATIVE, so a repeat call RAISES the stored total rather than being discarded — DO NOTHING silently dropped every partial refund after the first. detail.amount_cents is what MOVED; detail.revenue_cents is what comes off income, which differs when a card surcharge was inside the refunded charge.';

-- The old 6-argument signature would otherwise sit alongside the new one and
-- keep answering calls, which is how half the callers end up on a fixed
-- function and half on a broken one with nothing to show for it.
DROP FUNCTION IF EXISTS public.file_reversal_review_item(uuid, uuid, text, bigint, uuid, text);
