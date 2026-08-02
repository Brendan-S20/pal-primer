-- BUG-24 / BUG-25 / BUG-26: an adjustment records WHO HELD THE MONEY, handles a
-- second partial refund, and repays a location when a dispute is won after the
-- statement went out.
--
-- ── BUG-24: the settlement charged a location for a refund it had already paid ──
--
-- `franchise_share_cents` has been written by this function since adjustments
-- were built and read by NOTHING — `grep` finds the column definition and this
-- writer, and no reader anywhere. That was the tell.
--
-- The settlement nets `by_parent − royalty − location_share`. It credits only
-- revenue the PARENT collected, but debits the location's share of a reversal
-- unconditionally. When a location collects its own payments, the refund
-- already left the location's own Stripe account — so the settlement charges it
-- a second time. Reproduced against the live database, $1,000 refunded on a
-- $1,000 sale, 10% royalty, location collecting:
--
--   policy      | produced                     | actually owed
--   ------------+------------------------------+------------------------------
--   location    | location owes $1,100         | location owes $100
--   split       | location owes $1,000         | settled, $0
--   franchise   | location owes $100           | franchise owes location $900
--
-- Every case out by exactly the full refund, every case in the franchise's
-- favour. The `franchise` row is the one that should worry us: the franchise
-- contractually agreed to absorb the loss, and the software billed the
-- franchisee for it instead.
--
-- The missing term is the one nobody was reading:
--
--   balance = collected_by_parent
--           − royalty
--           − Σ location_share   where the PARENT paid the refund out
--           + Σ franchise_share  where the LOCATION paid the refund out
--
-- Which is just "settle the half the other party is carrying". Verified against
-- all six combinations of collector × policy.
--
-- The collector is FROZEN onto the adjustment rather than looked up at
-- settlement time, for the same reason the shares are: routing can change, and
-- a location that switches to franchise-collection in August must not have its
-- July refunds re-attributed.
--
-- ── BUG-25: only the first partial refund of a payment was ever recorded ──────
--
-- Stripe fires `charge.refunded` once per refund and carries the CUMULATIVE
-- `amount_refunded`. The unique constraint was `(payment_id, kind)` with
-- ON CONFLICT DO NOTHING, so a $200 refund followed by the remaining $800
-- recorded $200 and silently dropped the rest — the location kept $800 it no
-- longer had, and the income sheet deducted $200 of $1,000 that left the bank.
--
-- Now each event records the DELTA and the cumulative figure is what makes it
-- idempotent: a redelivery carries the same cumulative and is refused, a
-- genuine second refund carries a higher one and is recorded. Hence
-- `(payment_id, kind, cumulative_cents)`.
--
-- ── BUG-26: winning a dispute after the statement went out kept the money ─────
--
-- The owner's rule: "if the franchise makes that amount back and it's awarded
-- for a chargeback/refund, then it is paid back at the moment." The won-dispute
-- branch only marked the original 'reversed'. If that original had already been
-- applied to a settlement the parent had SENT, nothing ever gave the money
-- back — while the review-queue alert told the owner "any deduction taken for
-- it has been reversed."
--
-- A reversal that has not been settled yet is still just cancelled. One that
-- HAS been settled now raises a compensating adjustment with negated shares, so
-- the next settlement returns it through the same mechanism that took it. That
-- is as close to "at the moment" as a periodic settlement can honestly get, and
-- it is visible on the statement rather than being an off-ledger promise.
--
-- Idempotent.

ALTER TABLE public.franchise_adjustments
  ADD COLUMN IF NOT EXISTS collected_by_organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cumulative_cents bigint;

COMMENT ON COLUMN public.franchise_adjustments.collected_by_organization_id IS
  'BUG-24: whose Stripe account the ORIGINAL payment landed in, frozen at the moment the reversal was recorded. Decides which side of the settlement carries the loss; routing can change later and must not re-attribute past reversals.';
COMMENT ON COLUMN public.franchise_adjustments.cumulative_cents IS
  'BUG-25: the cumulative amount Stripe reported refunded for this payment at the moment of this event. amount_cents is the DELTA this event added. Uniqueness on (payment_id, kind, cumulative_cents) makes webhook redelivery idempotent while still admitting a genuine second partial refund.';

-- Existing rows: one event each, so the delta IS the cumulative, and the
-- collector is whatever the payment says today (the only information we have,
-- and correct for every row written so far because routing has never changed).
UPDATE public.franchise_adjustments fa
   SET cumulative_cents = fa.amount_cents
 WHERE fa.cumulative_cents IS NULL;

UPDATE public.franchise_adjustments fa
   SET collected_by_organization_id =
         coalesce(p.collected_by_organization_id, fa.child_organization_id)
  FROM public.payments p
 WHERE p.id = fa.payment_id
   AND fa.collected_by_organization_id IS NULL;

ALTER TABLE public.franchise_adjustments
  DROP CONSTRAINT IF EXISTS franchise_adjustments_payment_id_kind_key;

CREATE UNIQUE INDEX IF NOT EXISTS franchise_adjustments_payment_kind_cumulative_key
  ON public.franchise_adjustments (payment_id, kind, cumulative_cents);

CREATE OR REPLACE FUNCTION public.record_franchise_adjustment(
  _payment_id uuid,
  _kind text,
  _amount_cents bigint,
  _note text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _child uuid; _parent uuid; _pct numeric; _resp text; _collector uuid;
  _fran bigint; _loc bigint; _id uuid;
  _orig public.franchise_adjustments%ROWTYPE;
  _settled boolean;
  _already bigint;
  _delta bigint;
BEGIN
  SELECT p.organization_id, o.parent_organization_id,
         coalesce(o.franchise_royalty_percent, 0), o.chargeback_responsibility,
         coalesce(p.collected_by_organization_id, p.organization_id)
    INTO _child, _parent, _pct, _resp, _collector
    FROM public.payments p JOIN public.organizations o ON o.id = p.organization_id
   WHERE p.id = _payment_id;

  -- Not a franchise location: nothing to apportion, and no adjustment to make.
  IF _parent IS NULL THEN RETURN NULL; END IF;

  IF _kind = 'chargeback_won' THEN
    SELECT * INTO _orig FROM public.franchise_adjustments
     WHERE payment_id = _payment_id AND kind = 'chargeback'
       AND status IN ('pending', 'applied')
     ORDER BY created_at
     LIMIT 1;
    IF _orig.id IS NULL THEN RETURN NULL; END IF;

    -- Has the deduction actually MOVED yet? It has, once the settlement that
    -- consumed it left draft — that statement is a bill someone has acted on.
    SELECT EXISTS (
      SELECT 1 FROM public.franchise_royalty_invoices fri
       WHERE fri.id = _orig.applied_settlement_id AND fri.status <> 'draft'
    ) INTO _settled;

    UPDATE public.franchise_adjustments
       SET status = 'reversed', reversed_at = now()
     WHERE id = _orig.id;

    IF NOT _settled THEN
      -- Nothing has been billed for it, so cancelling is the whole job.
      RETURN _orig.id;
    END IF;

    -- BUG-26: it HAS been billed. Give it back through the same mechanism that
    -- took it, with the shares negated, so the next statement shows the
    -- repayment as a line rather than an unexplained swing.
    INSERT INTO public.franchise_adjustments (
      parent_organization_id, child_organization_id, payment_id,
      kind, amount_cents, cumulative_cents,
      franchise_share_cents, location_share_cents,
      collected_by_organization_id, note
    )
    VALUES (
      _orig.parent_organization_id, _orig.child_organization_id, _payment_id,
      'chargeback_won', _orig.amount_cents, _orig.amount_cents,
      -_orig.franchise_share_cents, -_orig.location_share_cents,
      _orig.collected_by_organization_id,
      coalesce(_note, 'Chargeback won — repaying a deduction already settled')
    )
    ON CONFLICT (payment_id, kind, cumulative_cents) DO NOTHING
    RETURNING id INTO _id;

    IF _id IS NOT NULL THEN
      UPDATE public.franchise_adjustments
         SET reversed_by_adjustment_id = _id
       WHERE id = _orig.id;
    END IF;
    RETURN coalesce(_id, _orig.id);
  END IF;

  -- BUG-25: Stripe reports the CUMULATIVE amount refunded. Record only what
  -- this event added, and let the cumulative figure carry the idempotency.
  SELECT coalesce(sum(amount_cents), 0) INTO _already
    FROM public.franchise_adjustments
   WHERE payment_id = _payment_id AND kind = _kind AND status <> 'reversed';

  _delta := _amount_cents - _already;
  IF _delta <= 0 THEN RETURN NULL; END IF;

  -- Freeze the split from the policy in force right now.
  IF _resp = 'franchise' THEN
    _fran := _delta; _loc := 0;
  ELSIF _resp = 'split' THEN
    -- Each gives back exactly what they took on the original sale.
    _fran := round(_delta * _pct / 100.0)::bigint;
    _loc  := _delta - _fran;
  ELSE
    _fran := 0; _loc := _delta;
  END IF;

  INSERT INTO public.franchise_adjustments (
    parent_organization_id, child_organization_id, payment_id,
    kind, amount_cents, cumulative_cents,
    franchise_share_cents, location_share_cents,
    collected_by_organization_id, note
  )
  VALUES (
    _parent, _child, _payment_id,
    _kind, _delta, _amount_cents,
    _fran, _loc,
    _collector, _note
  )
  ON CONFLICT (payment_id, kind, cumulative_cents) DO NOTHING
  RETURNING id INTO _id;

  RETURN _id;
END;
$$;

COMMENT ON FUNCTION public.record_franchise_adjustment(uuid, text, bigint, text) IS
  'BUILD-6: apportions a refund or chargeback between a franchise and its location, freezing both the policy in force and WHICH ACCOUNT the money left (BUG-24). Records the delta of Stripe''s cumulative refund figure so a second partial refund is not dropped (BUG-25). A won dispute that was already settled raises a compensating adjustment rather than only cancelling itself (BUG-26). Returns NULL for an organization that is not part of a franchise.';

REVOKE ALL ON FUNCTION public.record_franchise_adjustment(uuid, text, bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_franchise_adjustment(uuid, text, bigint, text) TO service_role;
