-- BUILD-2 — the 80% warning needs somewhere to land.
--
-- BUILD-10 built the review queue precisely so that "something a human should
-- look at" has one place to be looked at. An AI allowance running out is that:
-- nothing is broken, nothing is paused, but the next invoice is about to carry
-- a line the owner did not expect. Inventing a second notification surface for
-- it would be the mistake BUILD-10 was written to stop.
--
-- `review_items.kind` is a closed CHECK list, which is correct — an open text
-- column would let a typo create a category nobody ever reads. So the new kind
-- is added here, deliberately, rather than the constraint being relaxed.

ALTER TABLE public.review_items DROP CONSTRAINT IF EXISTS review_items_kind_check;
ALTER TABLE public.review_items ADD CONSTRAINT review_items_kind_check
  CHECK (kind = ANY (ARRAY[
    'visit_timestamps_unreliable',
    'visit_started_never_finished',
    'visit_stuck_in_progress',
    'payment_refunded',
    'payment_chargeback',
    'payment_chargeback_won',
    'payment_chargeback_lost',
    'payment_dispute_inquiry',
    'payment_dispute_inquiry_closed',
    'billing_run_failed',
    'ai_allowance_warning'
  ]));

-- ── what `dispute_ref` actually is ─────────────────────────────────────────
--
-- The unique index is (organization_id, kind, subject_id, dispute_ref), and
-- that fourth column is what lets ONE subject carry MORE THAN ONE item of the
-- same kind — a payment disputed twice, an org warned in July and again in
-- August. Its name says "dispute" because disputes were the first thing that
-- needed it (20260801070000), and a second user of the same mechanism now
-- makes the name misleading rather than merely narrow.
--
-- Renaming it would touch every dispute query for a cosmetic gain. Saying what
-- it is, where anyone reading the schema will find it, costs nothing and stops
-- the next author concluding it is unused for their kind and leaving it empty
-- — which would silently collapse every future occurrence into the first one.
COMMENT ON COLUMN public.review_items.dispute_ref IS
  'The occurrence key within (organization_id, kind, subject_id) — the fourth column of the unique index. For dispute kinds it is the Stripe dispute id. For ai_allowance_warning it is the period month (YYYY-MM-DD), so each month can be warned once. Empty string when a kind can only ever occur once per subject. NOT a dispute-only column despite the name.';

DO $$
DECLARE
  _org uuid;
  _plan uuid;
BEGIN
 BEGIN
  SELECT id INTO _plan FROM public.platform_plans WHERE slug = 'launch';
  INSERT INTO public.organizations (name, timezone, plan_id)
  VALUES ('BUILD-2 review-kind verification', 'America/Chicago', _plan)
  RETURNING id INTO _org;

  -- The new kind is accepted.
  INSERT INTO public.review_items
    (organization_id, kind, subject_table, subject_id, reason, detail, dispute_ref)
  VALUES (_org, 'ai_allowance_warning', 'organizations', _org, 'verification', '{}'::jsonb, '2026-08-01');

  -- Two different months are two different items — the whole reason the
  -- occurrence key is populated rather than left empty.
  INSERT INTO public.review_items
    (organization_id, kind, subject_table, subject_id, reason, detail, dispute_ref)
  VALUES (_org, 'ai_allowance_warning', 'organizations', _org, 'verification', '{}'::jsonb, '2026-09-01');

  IF (SELECT count(*) FROM public.review_items
       WHERE organization_id = _org AND kind = 'ai_allowance_warning') <> 2 THEN
    RAISE EXCEPTION 'two months should be two items';
  END IF;

  -- The same month twice is ONE item, or an org gets warned on every call.
  BEGIN
    INSERT INTO public.review_items
      (organization_id, kind, subject_table, subject_id, reason, detail, dispute_ref)
    VALUES (_org, 'ai_allowance_warning', 'organizations', _org, 'again', '{}'::jsonb, '2026-08-01');
    RAISE EXCEPTION 'the same month was allowed to file twice';
  EXCEPTION WHEN unique_violation THEN
    NULL;  -- expected
  END;

  -- A kind that is not in the list must still be refused.
  BEGIN
    INSERT INTO public.review_items
      (organization_id, kind, subject_table, subject_id, reason, detail, dispute_ref)
    VALUES (_org, 'not_a_real_kind', 'organizations', _org, 'x', '{}'::jsonb, '');
    RAISE EXCEPTION 'the kind check is not enforcing anything';
  EXCEPTION WHEN check_violation THEN
    NULL;  -- expected
  END;

  -- Every kind the queue already used must still be accepted; widening a
  -- CHECK by rewriting it is exactly how one goes missing.
  INSERT INTO public.review_items
    (organization_id, kind, subject_table, subject_id, reason, detail, dispute_ref)
  SELECT _org, k, 'organizations', _org, 'verification', '{}'::jsonb, k
    FROM unnest(ARRAY['visit_timestamps_unreliable','visit_started_never_finished',
                      'visit_stuck_in_progress','payment_refunded','payment_chargeback',
                      'payment_chargeback_won','payment_chargeback_lost',
                      'payment_dispute_inquiry','payment_dispute_inquiry_closed',
                      'billing_run_failed']) AS k;

  RAISE EXCEPTION 'BUILD2_REVIEW_KIND_ROLLBACK';
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'BUILD2_REVIEW_KIND_ROLLBACK' THEN RAISE; END IF;
 END;
 RAISE NOTICE 'review kind verified: new kind accepted, per-month uniqueness holds, old kinds survive, bad kinds still refused';
END $$;
