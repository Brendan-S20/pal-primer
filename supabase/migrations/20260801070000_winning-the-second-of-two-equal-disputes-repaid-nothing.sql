-- Winning the second of two equal disputes on one payment repaid nothing.
--
-- Proven live, in a transaction that rolled itself back. One payment, two
-- separate Stripe disputes of $400 each (dp_A, dp_B), both lost, both settled
-- on an issued statement, then both won:
--
--     both_deductions_filed=yes  deducted=80000
--     repayments=1  repaid=40000        (expected 2 / 80000)
--
-- The location was charged $800 and repaid $400. The missing $400 stays with
-- the franchise, permanently and silently — no error, no row, nothing on the
-- statement to reconcile against.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
--
-- Two unique indexes guard this table:
--
--     franchise_adjustments_payment_kind_cumulative_key
--         (payment_id, kind, cumulative_cents)
--     franchise_adjustments_payment_kind_dispute_key
--         (payment_id, kind, dispute_ref) WHERE dispute_ref IS NOT NULL
--
-- The second is the right identity for anything born of a Stripe dispute, and
-- it does the job: (pay, chargeback_won, dp_A) and (pay, chargeback_won, dp_B)
-- are distinct. The first is the right identity for a REFUND, where
-- `cumulative_cents` is Stripe's running `amount_refunded` and re-billing on a
-- partial refund is the thing to prevent.
--
-- A repayment row writes `cumulative_cents = _orig.amount_cents` — not a
-- running total, just the amount being given back. Two disputes of the same
-- size therefore produce the same key under the cumulative index, and the
-- second INSERT hit `ON CONFLICT ... DO NOTHING`, which is exactly the clause
-- written to make webhook redelivery harmless. It could not tell a redelivery
-- from a second dispute, because the key it arbitrated on cannot.
--
-- Equal amounts are not a corner case here. A franchise location on a flat
-- monthly plan bills every client the same figure, so any two disputes in a
-- period are likely to collide.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
--
-- The cumulative index becomes partial on `dispute_ref IS NULL`, so each index
-- guards only what it is the right identity for: refunds by cumulative amount,
-- disputes by dispute id. Nothing is loosened — every row is still covered by
-- exactly one of the two.
--
-- The two ON CONFLICT clauses drop their explicit target. A named target must
-- match an index exactly, and with a partial index that means repeating the
-- predicate at both call sites — a second place to get it wrong. Bare
-- `ON CONFLICT DO NOTHING` means "if any uniqueness rule on this table says
-- this row already exists, we are done", which is what the guard was always
-- for.
--
-- ── EXPOSURE ───────────────────────────────────────────────────────────────
--
-- Latent. franchise_adjustments holds zero rows and there is not one franchise
-- in the database; the probe had to build one. No location has been short-paid.
--
-- ── ONE CLAIM DISMISSED, NOT FIXED ─────────────────────────────────────────
--
-- The same audit flagged the idempotency check below — `EXISTS (... dispute_ref
-- = _ref)` has no status filter, so a chargeback that is won and then lost
-- again under the SAME dispute id files no deduction. That reproduces:
--
--     first_deduction=filed, after_win_status=reversed
--     REPRESENTED_DEDUCTION=DROPPED  live_deductions=0
--
-- It is left alone deliberately. Stripe closes a dispute once; a second dispute
-- on the same charge is a new dispute with a new id, which src/lib/disputes.ts
-- states outright ("a payment can be disputed more than once over its life",
-- each row belonging to one dispute id). So the scenario is unreachable, while
-- the redelivery it guards against is routine. Loosening the guard would trade
-- a bug that cannot happen for double-billing that can.


DROP INDEX IF EXISTS public.franchise_adjustments_payment_kind_cumulative_key;

CREATE UNIQUE INDEX franchise_adjustments_payment_kind_cumulative_key
  ON public.franchise_adjustments (payment_id, kind, cumulative_cents)
  WHERE dispute_ref IS NULL;

CREATE OR REPLACE FUNCTION public.record_franchise_adjustment(
  _payment_id uuid,
  _kind text,
  _amount_cents bigint,
  _note text DEFAULT NULL::text,
  _dispute_ref text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _child uuid; _parent uuid; _pct numeric; _resp text; _collector uuid;
  _fran bigint; _loc bigint; _id uuid;
  _orig public.franchise_adjustments%ROWTYPE;
  _settled boolean;
  _already bigint;
  _delta bigint;
  _ref text := nullif(trim(coalesce(_dispute_ref, '')), '');
BEGIN
  -- A lost dispute and an inquiry both move NOTHING. The generic branch at the
  -- bottom treats any kind it does not recognise as a brand-new deduction, so
  -- an unrefused kind here bills a location for the full amount: $1,000 twice
  -- on a lost $1,000 chargeback, or $600 for a $600 inquiry that took nothing.
  IF _kind IN ('chargeback_lost', 'dispute_inquiry', 'dispute_inquiry_closed') THEN
    RETURN NULL;
  END IF;

  SELECT p.organization_id, o.parent_organization_id,
         coalesce(o.franchise_royalty_percent, 0), o.chargeback_responsibility,
         coalesce(p.collected_by_organization_id, p.organization_id)
    INTO _child, _parent, _pct, _resp, _collector
    FROM public.payments p JOIN public.organizations o ON o.id = p.organization_id
   WHERE p.id = _payment_id;

  IF _parent IS NULL THEN RETURN NULL; END IF;

  IF _kind = 'chargeback_won' THEN
    -- Reverse the deduction for THIS dispute. `ORDER BY created_at LIMIT 1`
    -- alone reversed the oldest chargeback on the payment, which on a payment
    -- disputed twice is the wrong one — repaying a settled $400 while the
    -- $600 the bank actually returned stayed billed.
    IF _ref IS NOT NULL THEN
      SELECT * INTO _orig FROM public.franchise_adjustments
       WHERE payment_id = _payment_id AND kind = 'chargeback'
         AND dispute_ref = _ref
         AND status IN ('pending', 'applied')
       LIMIT 1;
    END IF;
    IF _orig.id IS NULL THEN
      -- Fallback for a deduction filed before dispute ids were recorded. Only
      -- ref-less rows are eligible, so it can never steal another dispute's.
      SELECT * INTO _orig FROM public.franchise_adjustments
       WHERE payment_id = _payment_id AND kind = 'chargeback'
         AND dispute_ref IS NULL
         AND status IN ('pending', 'applied')
       ORDER BY created_at
       LIMIT 1;
    END IF;
    IF _orig.id IS NULL THEN RETURN NULL; END IF;

    SELECT EXISTS (
      SELECT 1 FROM public.franchise_royalty_invoices fri
       WHERE fri.id = _orig.applied_settlement_id AND fri.status <> 'draft'
    ) INTO _settled;

    UPDATE public.franchise_adjustments
       SET status = 'reversed', reversed_at = now()
     WHERE id = _orig.id;

    IF NOT _settled THEN
      RETURN _orig.id;
    END IF;

    INSERT INTO public.franchise_adjustments (
      parent_organization_id, child_organization_id, payment_id,
      kind, amount_cents, cumulative_cents,
      franchise_share_cents, location_share_cents,
      collected_by_organization_id, note, dispute_ref
    )
    VALUES (
      _orig.parent_organization_id, _orig.child_organization_id, _payment_id,
      'chargeback_won', _orig.amount_cents, _orig.amount_cents,
      -_orig.franchise_share_cents, -_orig.location_share_cents,
      _orig.collected_by_organization_id,
      coalesce(_note, 'Chargeback won — repaying a deduction already settled'),
      _orig.dispute_ref
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO _id;

    IF _id IS NOT NULL THEN
      UPDATE public.franchise_adjustments
         SET reversed_by_adjustment_id = _id
       WHERE id = _orig.id;
    END IF;
    RETURN coalesce(_id, _orig.id);
  END IF;

  SELECT coalesce(sum(amount_cents), 0) INTO _already
    FROM public.franchise_adjustments
   WHERE payment_id = _payment_id AND kind = _kind AND status <> 'reversed';

  IF _ref IS NOT NULL THEN
    -- A dispute is its own event with its own amount — NOT a restatement of
    -- an earlier one. Two disputes of $400 and $600 owe $1,000, and the
    -- cumulative arithmetic below billed $600. Idempotency comes from the
    -- dispute id instead, so a redelivered webhook still files nothing.
    IF EXISTS (
      SELECT 1 FROM public.franchise_adjustments
       WHERE payment_id = _payment_id AND kind = _kind AND dispute_ref = _ref
    ) THEN
      RETURN NULL;
    END IF;
    _delta := _amount_cents;
  ELSE
    -- Refunds keep the cumulative reading: Stripe's `amount_refunded` is a
    -- running total of the charge, so partial refunds must not re-bill.
    _delta := _amount_cents - _already;
  END IF;

  IF _delta <= 0 THEN RETURN NULL; END IF;

  IF _resp = 'franchise' THEN
    _fran := _delta; _loc := 0;
  ELSIF _resp = 'split' THEN
    _fran := round(_delta * _pct / 100.0)::bigint;
    _loc  := _delta - _fran;
  ELSE
    _fran := 0; _loc := _delta;
  END IF;

  INSERT INTO public.franchise_adjustments (
    parent_organization_id, child_organization_id, payment_id,
    kind, amount_cents, cumulative_cents,
    franchise_share_cents, location_share_cents,
    collected_by_organization_id, note, dispute_ref
  )
  VALUES (
    _parent, _child, _payment_id,
    _kind, _delta, _already + _delta,
    _fran, _loc,
    _collector, _note, _ref
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO _id;

  RETURN _id;
END;
$function$;

DO $$
DECLARE _pred text; _n int;
BEGIN
  SELECT pg_get_expr(i.indpred, i.indrelid) INTO _pred
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'franchise_adjustments_payment_kind_cumulative_key';
  IF _pred IS DISTINCT FROM '(dispute_ref IS NULL)' THEN
    RAISE EXCEPTION 'cumulative index should be partial on dispute_ref IS NULL, got: %',
      coalesce(_pred, '<not partial>');
  END IF;

  -- Both indexes must survive. Dropping either leaves a class of row with no
  -- uniqueness rule at all, which is worse than the bug being fixed.
  SELECT count(*) INTO _n FROM pg_class
   WHERE relname IN ('franchise_adjustments_payment_kind_cumulative_key',
                     'franchise_adjustments_payment_kind_dispute_key');
  IF _n <> 2 THEN
    RAISE EXCEPTION 'expected both uniqueness rules on franchise_adjustments, found %', _n;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'record_franchise_adjustment'
       AND p.prosrc LIKE '%ON CONFLICT (payment_id%'
  ) THEN
    RAISE EXCEPTION 'the function still names the cumulative index as its conflict target';
  END IF;
END $$;
