-- BUILD-6 / BUILD-12: a refund or chargeback becomes a REVIEW ITEM.
--
-- Applied live on 2026-07-31 as `reversal_review_items` while the Stripe
-- webhook handlers were being built; this is the same statement, filed so the
-- repo and the database agree (IMP-2 / check-migrations.mjs).
--
-- WHY THIS EXISTS. Money leaving the account after a sale is the single event
-- most likely to be discovered late and by accident — the payment silently
-- stops counting, the totals quietly shrink, and nobody is told. The owner was
-- explicit that this must be surfaced: "make sure it's known or alerted,
-- because it's going to happen; it's unavoidable."
--
-- So every reversal files a review item against the payment. The review queue
-- already exists (20260730100000_review-queue.sql) and is already the one place
-- a tenant looks for "things that need a human"; adding a third kind of entry
-- there beats inventing a second inbox nobody checks.
--
-- The wording is deliberately plain and tells the reader what has ALREADY
-- happened to their numbers, not just that an event occurred — a franchisee
-- reading "your revenue changed" needs to know whether they still owe royalty
-- on it. Chargebacks also name the deadline pressure, because evidence in
-- Stripe is time-boxed and a late reply is a lost dispute.
--
-- ON CONFLICT DO NOTHING against review_items(organization_id, kind,
-- subject_id): Stripe redelivers webhooks, and one refund must not stack up
-- five identical entries.
--
-- Returns NULL rather than raising for an unrecognised kind, because the caller
-- is a webhook handler: a surprise event type must not fail the whole delivery
-- and trigger Stripe's retry loop.
--
-- Idempotent.

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
    ELSE NULL END;
  IF _item_kind IS NULL THEN RETURN NULL; END IF;

  _reason := CASE _kind
    WHEN 'refund' THEN _money || ' was refunded to a customer. This revenue has been removed from your totals; if it was already counted in a franchise settlement it carries into the next one.'
    WHEN 'chargeback' THEN _money || ' was charged back by a customer''s bank. The money has left the account. You have limited time to submit evidence in Stripe if you want to dispute it.'
    ELSE _money || ' chargeback was WON — the money has been returned and any deduction taken for it has been reversed.'
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
  'BUILD-12: files a review-queue entry when money is refunded or charged back, so a reversal is never discovered by noticing the totals shrank. Idempotent against webhook redelivery. Returns NULL for an unrecognised kind rather than raising, so a surprise Stripe event cannot fail the delivery.';

REVOKE ALL ON FUNCTION public.file_reversal_review_item(uuid, uuid, text, bigint, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.file_reversal_review_item(uuid, uuid, text, bigint, uuid) TO service_role;
