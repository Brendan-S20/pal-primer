-- BUILD-12: the invoice dispute queue.
--
-- Owner decision: "If the invoice is disputed, it should end-up in a dispute
-- queue; then that can either be toggled into the analytics or toggled out, it
-- should definitely show as an issue/lost."
--
-- Three things follow, and the third is the one that needed schema.
--
-- ── A DISPUTE THAT IS LOST IS NEVER RECORDED AS LOST ────────────────────────
--
-- The Stripe webhook records `charge.dispute.created` (money withdrawn) and
-- `charge.dispute.closed` ONLY when the outcome is `won`. A loss is deliberately
-- not recorded, because the money already left when the dispute opened and
-- recording it again would deduct it twice.
--
-- That is right about the MONEY and wrong about the STATE. It means a lost
-- dispute stays "open" in the queue forever: the amount is correct, the status
-- is a lie, and the owner cannot tell "still fighting this" from "lost it in
-- March". The owner's phrasing — "it should definitely show as an issue/lost" —
-- is exactly this gap.
--
-- So `payment_chargeback_lost` is added as a review kind that moves NO money.
-- It is a status fact, filed when the dispute closes against us, and the queue
-- reads it to say what actually happened. Inferring the loss instead — "open
-- for more than 75 days, probably lost" — would be a guess, and guessing is the
-- thing the review queue exists to stop.
--
-- ── THE ANALYTICS TOGGLE ───────────────────────────────────────────────────
--
-- `disputes_in_analytics` defaults to FALSE, which means a disputed amount is
-- deducted from analytics revenue — the money is genuinely gone while the
-- dispute is open, so the conservative reading is also the accurate one. An
-- owner who expects to win can flip it and see revenue as if the disputes hold.
--
-- IT DOES NOT AND MUST NOT AFFECT THE TAX REPORTS. A figure on a return cannot
-- depend on a display preference; BUILD-13's cash-basis sheets read the
-- reversal ledger directly and ignore this column entirely. The toggle is a
-- management-analytics lens, and the tax pack says so in its own caveats.
--
-- Refunds are NOT covered by the toggle. A refund is settled and final — the
-- customer has their money and no outcome is pending. Only a dispute has a
-- future worth optimism about.
--
-- Idempotent.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS disputes_in_analytics boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.organizations.disputes_in_analytics IS
  'BUILD-12: when true, amounts under an OPEN dispute are still counted in the analytics/dashboard revenue figures. Default false — the money has left the account. Never consulted by the tax reports, which read the reversal ledger directly.';

-- Add the status-only kind. Recreated rather than altered because a CHECK
-- constraint cannot be extended in place.
ALTER TABLE public.review_items DROP CONSTRAINT IF EXISTS review_items_kind_check;
ALTER TABLE public.review_items ADD CONSTRAINT review_items_kind_check CHECK (
  kind = ANY (ARRAY[
    'visit_timestamps_unreliable',
    'visit_started_never_finished',
    'visit_stuck_in_progress',
    'payment_refunded',
    'payment_chargeback',
    'payment_chargeback_won',
    -- BUILD-12. Moves no money; records that the dispute closed against us.
    'payment_chargeback_lost'
  ])
);

-- Teach the filer the new kind. Everything else is unchanged; the money-moving
-- kinds keep their existing wording so an alert already sent still reads the
-- same as one sent tomorrow.
CREATE OR REPLACE FUNCTION public.file_reversal_review_item(
  _org_id uuid,
  _payment_id uuid,
  _kind text,
  _amount_cents bigint,
  _adjustment_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _item_kind text;
  _reason text;
  _money text := '$' || to_char(_amount_cents / 100.0, 'FM999999990.00');
  _id uuid;
BEGIN
  _item_kind := CASE _kind
    WHEN 'refund' THEN 'payment_refunded'
    WHEN 'chargeback' THEN 'payment_chargeback'
    WHEN 'chargeback_won' THEN 'payment_chargeback_won'
    WHEN 'chargeback_lost' THEN 'payment_chargeback_lost'
    ELSE NULL END;
  IF _item_kind IS NULL THEN RETURN NULL; END IF;

  _reason := CASE _kind
    WHEN 'refund' THEN _money || ' was refunded to a customer. This revenue has been removed from your totals; if it was already counted in a franchise settlement it carries into the next one.'
    WHEN 'chargeback' THEN _money || ' was charged back by a customer''s bank. The money has left the account. You have limited time to submit evidence in Stripe if you want to dispute it.'
    WHEN 'chargeback_won' THEN _money || ' chargeback was WON — the money has been returned and any deduction taken for it has been reversed.'
    -- Deliberately says no money moved. The withdrawal happened when the
    -- dispute opened; a reader seeing a second dollar figure would reasonably
    -- assume they had been hit twice.
    ELSE 'The ' || _money || ' chargeback was decided in the customer''s favour. No further money moves — it left when the dispute opened — but this sale is now final as lost.'
  END;

  INSERT INTO public.review_items (
    organization_id, kind, subject_table, subject_id, reason, detail
  )
  VALUES (
    _org_id, _item_kind, 'payments', _payment_id, _reason,
    jsonb_build_object('amount_cents', _amount_cents, 'adjustment_id', _adjustment_id)
  )
  ON CONFLICT (organization_id, kind, subject_id) DO NOTHING
  RETURNING id INTO _id;

  RETURN _id;
END;
$$;

COMMENT ON FUNCTION public.file_reversal_review_item(uuid, uuid, text, bigint, uuid) IS
  'BUILD-12: files a review-queue entry when money is refunded or charged back, and when a dispute is finally decided. Idempotent against webhook redelivery. Returns NULL for an unrecognised kind rather than raising, so a surprise Stripe event cannot fail the delivery. ''chargeback_lost'' records STATE only — the money left when the dispute opened.';

REVOKE ALL ON FUNCTION public.file_reversal_review_item(uuid, uuid, text, bigint, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.file_reversal_review_item(uuid, uuid, text, bigint, uuid) TO service_role;
