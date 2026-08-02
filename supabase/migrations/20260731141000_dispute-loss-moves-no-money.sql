-- BUILD-12, second half: a LOST dispute must not deduct anything.
--
-- Caught while wiring the webhook, before it shipped.
--
-- `record_franchise_adjustment` handles 'chargeback_won' explicitly and treats
-- EVERYTHING ELSE as a new deduction to apportion. Feeding it the new
-- 'chargeback_lost' kind would therefore have taken the money a second time:
-- no prior row exists for that kind, so `_already` is 0, `_delta` becomes the
-- full amount, and a fresh adjustment is inserted for the whole disputed sum.
--
-- On a $1,000 chargeback that we then lose, the location would be billed
-- $1,000 when the dispute opened and $1,000 again when it closed — for one
-- event, and only for franchise locations, which is the hardest kind of bug to
-- notice because it looks fine for every ordinary business.
--
-- The withdrawal is recorded once, when the dispute OPENS. Losing it changes
-- the outcome, not the money. So the function refuses the kind outright rather
-- than relying on every caller to remember; the webhook also skips the call,
-- because a guard is worth having on both sides of a boundary that decides
-- whether somebody gets billed twice.
--
-- Idempotent.

CREATE OR REPLACE FUNCTION public.record_franchise_adjustment(
  _payment_id uuid,
  _kind text,
  _amount_cents bigint,
  _note text DEFAULT NULL::text
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
BEGIN
  -- BUILD-12: a lost dispute is a STATUS fact. The money left when the dispute
  -- opened and was apportioned then; there is nothing further to move, and the
  -- generic branch below would treat this as a brand-new deduction.
  IF _kind = 'chargeback_lost' THEN
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
    SELECT * INTO _orig FROM public.franchise_adjustments
     WHERE payment_id = _payment_id AND kind = 'chargeback'
       AND status IN ('pending', 'applied')
     ORDER BY created_at
     LIMIT 1;
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

  SELECT coalesce(sum(amount_cents), 0) INTO _already
    FROM public.franchise_adjustments
   WHERE payment_id = _payment_id AND kind = _kind AND status <> 'reversed';

  _delta := _amount_cents - _already;
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
$function$;

COMMENT ON FUNCTION public.record_franchise_adjustment(uuid, text, bigint, text) IS
  'BUILD-6/BUILD-12: apportions a refund or chargeback between a franchise and its location, freezing the policy and the collecting account in force at the time. Records the DELTA of a cumulative Stripe amount, so partial refunds accumulate correctly. Returns NULL for a lost dispute — that is a status change, and the money moved when the dispute opened.';
