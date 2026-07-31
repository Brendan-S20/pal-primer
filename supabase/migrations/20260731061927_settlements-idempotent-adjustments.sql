-- BUG-20: regenerating a settlement forgot the adjustments it had just applied.
--
-- Applied live on 2026-07-31 as `settlements_idempotent_adjustments`; filed
-- here so the repo and the database agree (IMP-2 / check-migrations.mjs).
--
-- THE BUG, caught by running the generator twice on purpose.
--
--   run 1:  settled                  net $0    revenue $1000  royalty $100  adjustments $900
--   run 2:  location_owes_franchise  net $900  revenue $1000  royalty $100  adjustments $0
--
-- Run 1 folded a $900 pending adjustment into the balance and then marked that
-- adjustment 'applied'. Run 2 recalculated from scratch, looked for PENDING
-- adjustments, found none — because run 1 had consumed them — and produced a
-- settlement as if the refund had never happened. The location was back to
-- owing $900 it had already been credited.
--
-- This is the worst shape a money bug can take: the wrong number is produced by
-- an action that looks completely safe. "Regenerate" is something a franchise
-- owner will click without a second thought — after adding a location, after
-- correcting a royalty rate, or just because they are not sure the first one
-- took. Nothing in the UI suggests it could change what is owed. And because
-- both runs are internally consistent, the number that arrives second is
-- entirely plausible; nobody would look at $900 and think to check.
--
-- THE FIX. Recalculation must count what it already consumed FOR THIS DRAFT:
-- an adjustment is in scope if it is still pending, OR if it is already applied
-- to a settlement covering exactly this period which is still a draft.
--
-- The `status = 'draft'` half is what keeps this from becoming a different bug.
-- Once a settlement has been sent it is frozen (the ON CONFLICT clause refuses
-- to touch it), so its adjustments must NOT be pulled back into a later
-- recalculation — they belong to a statement someone has already acted on.
--
-- VERIFIED against the live database before this file was written: three
-- consecutive runs all hold at settled / $0 / adjustments $900, and a fourth
-- run after the settlement was marked 'sent' leaves it untouched.
--
-- Idempotent.

CREATE OR REPLACE FUNCTION public.generate_franchise_settlements(
  _parent uuid, _start date, _end date
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _n integer := 0;
BEGIN
  IF NOT (public.has_role(auth.uid(), _parent, 'owner'::public.app_role)
          OR public.is_platform_admin(auth.uid())) THEN
    RAISE EXCEPTION 'Only the franchise owner can generate settlements.';
  END IF;
  IF _end <= _start THEN
    RAISE EXCEPTION 'The period end must be after its start.';
  END IF;

  WITH kids AS (
    SELECT id, coalesce(franchise_royalty_percent, 0) AS pct
    FROM public.organizations WHERE parent_organization_id = _parent
  ),
  rev AS (
    SELECT k.id AS child, k.pct,
           coalesce(sum(p.amount_cents) FILTER (WHERE p.collected_by_organization_id = _parent), 0)::bigint AS by_parent,
           coalesce(sum(p.amount_cents) FILTER (WHERE p.collected_by_organization_id IS DISTINCT FROM _parent), 0)::bigint AS by_location,
           coalesce(sum(p.amount_cents), 0)::bigint AS total
    FROM kids k
    LEFT JOIN public.payments p
      ON p.organization_id = k.id
     AND p.status = 'succeeded'
     AND p.created_at >= _start::timestamptz
     AND p.created_at <  _end::timestamptz
    GROUP BY k.id, k.pct
  ),
  adj AS (
    SELECT fa.child_organization_id AS child,
           coalesce(sum(fa.location_share_cents), 0)::bigint AS loc_owes
    FROM public.franchise_adjustments fa
    LEFT JOIN public.franchise_royalty_invoices fri ON fri.id = fa.applied_settlement_id
    WHERE fa.parent_organization_id = _parent
      AND (
        fa.status = 'pending'
        -- Already folded into THIS period's draft: still ours to count, or the
        -- recalculation would drop it and quietly change what is owed.
        OR (fa.status = 'applied'
            AND fri.period_start = _start
            AND fri.period_end = _end
            AND fri.status = 'draft')
      )
    GROUP BY fa.child_organization_id
  ),
  calc AS (
    SELECT r.child, r.pct, r.by_parent, r.by_location, r.total,
           round(r.total * r.pct / 100.0)::bigint AS royalty,
           coalesce(a.loc_owes, 0) AS loc_owes,
           (r.by_parent - round(r.total * r.pct / 100.0) - coalesce(a.loc_owes, 0))::bigint AS balance
    FROM rev r LEFT JOIN adj a ON a.child = r.child
  ),
  ins AS (
    INSERT INTO public.franchise_royalty_invoices (
      parent_organization_id, child_organization_id, period_start, period_end,
      revenue_cents, royalty_percent, amount_cents,
      direction, royalty_cents, net_due_cents,
      revenue_collected_by_parent_cents, revenue_collected_by_location_cents,
      adjustments_applied_cents, status, created_by
    )
    SELECT _parent, child, _start, _end,
           total, pct, royalty,
           CASE WHEN balance > 0 THEN 'franchise_owes_location'
                WHEN balance < 0 THEN 'location_owes_franchise'
                ELSE 'settled' END,
           royalty, abs(balance),
           by_parent, by_location,
           loc_owes, 'draft', auth.uid()
    FROM calc
    ON CONFLICT (child_organization_id, period_start, period_end) DO UPDATE
      SET revenue_cents = EXCLUDED.revenue_cents,
          royalty_percent = EXCLUDED.royalty_percent,
          amount_cents = EXCLUDED.amount_cents,
          direction = EXCLUDED.direction,
          royalty_cents = EXCLUDED.royalty_cents,
          net_due_cents = EXCLUDED.net_due_cents,
          revenue_collected_by_parent_cents = EXCLUDED.revenue_collected_by_parent_cents,
          revenue_collected_by_location_cents = EXCLUDED.revenue_collected_by_location_cents,
          adjustments_applied_cents = EXCLUDED.adjustments_applied_cents
      WHERE public.franchise_royalty_invoices.status = 'draft'
    RETURNING id, child_organization_id
  )
  UPDATE public.franchise_adjustments fa
     SET status = 'applied', applied_settlement_id = i.id
    FROM ins i
   WHERE fa.child_organization_id = i.child_organization_id
     AND fa.parent_organization_id = _parent
     AND fa.status = 'pending';

  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;

COMMENT ON FUNCTION public.generate_franchise_settlements(uuid, date, date) IS
  'BUILD-6: draws up each location''s settlement for a period — revenue, royalty, and the location''s share of refunds and chargebacks — and nets it into a single direction and amount. Safe to re-run: a draft is recalculated including the adjustments it already consumed (BUG-20), and a sent settlement is never rewritten.';

REVOKE ALL ON FUNCTION public.generate_franchise_settlements(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_franchise_settlements(uuid, date, date) TO authenticated, service_role;
