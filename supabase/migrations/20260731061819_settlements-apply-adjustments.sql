-- BUILD-6: settlements CONSUME the adjustments that are waiting on them.
--
-- Applied live on 2026-07-31 as `settlements_apply_adjustments`; filed here so
-- the repo and the database agree (IMP-2 / check-migrations.mjs).
--
-- Up to now a refund or chargeback recorded a franchise_adjustments row and
-- then sat there forever. Recording what is owed without ever collecting it is
-- worse than not recording it, because the number looks handled.
--
-- THE RULE, from the owner: "Settlements carry forward adjustments, it should
-- be handled within 30 days, and if the franchise makes that amount back and
-- it's awarded for a chargeback/refund, then it is paid back at the moment."
-- So a reversal that happens mid-period does not need its own money movement —
-- it rides along on the next settlement. Recovery is the exception and is
-- reversed immediately, which record_franchise_adjustment already handles.
--
-- THE MATH. For each location, over the period:
--
--   balance = collected_by_parent
--           − round(total_revenue × royalty_pct / 100)
--           − Σ pending location_share
--
--   balance > 0  →  franchise_owes_location   (parent holds the location's cut)
--   balance < 0  →  location_owes_franchise   (location holds the parent's cut)
--   balance = 0  →  settled
--
-- Only the LOCATION's share of an adjustment is subtracted. The franchise's own
-- share is already absorbed, because the franchise is the one netting out the
-- royalty it no longer earned. Subtracting both would charge the loss twice.
--
-- The share was frozen at the moment the reversal was recorded, from the
-- chargeback_responsibility policy then in force. Re-deriving it here would let
-- a policy change silently rewrite settlements that were already agreed.
--
-- ON CONFLICT ... WHERE status = 'draft' — a settlement that has been sent is a
-- statement someone has acted on. Regeneration may refine a draft; it may never
-- rewrite a sent one.
--
-- NOTE ON ORDER: the adjustments_applied_cents column landed live in the very
-- next statement (`settlement_adjustments_column`, filed alongside this one).
-- The ADD COLUMN is repeated here, IF NOT EXISTS, so a fresh replay in filename
-- order works rather than depending on plpgsql deferring identifier resolution.
--
-- Idempotent.

ALTER TABLE public.franchise_royalty_invoices
  ADD COLUMN IF NOT EXISTS adjustments_applied_cents bigint NOT NULL DEFAULT 0;

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
    WHERE fa.parent_organization_id = _parent
      AND fa.status = 'pending'
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

COMMENT ON COLUMN public.franchise_royalty_invoices.adjustments_applied_cents IS
  'BUILD-6: the location''s share of refunds and chargebacks folded into this settlement. Shown on the statement so a deduction is never unexplained.';

REVOKE ALL ON FUNCTION public.generate_franchise_settlements(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_franchise_settlements(uuid, date, date) TO authenticated, service_role;
