-- BUG-21 / IMP-10: revenue counts money that ARRIVED, not money we still have.
--
-- THE RULE, and it is the whole migration:
--
--   A payment's status says what is true TODAY. Revenue for a past period is a
--   question about what happened THEN. Filtering a historical period by today's
--   status silently rewrites the past.
--
-- So `succeeded` alone is the wrong filter. When a refund or chargeback lands,
-- the Stripe webhook sets payments.status = 'refunded'. Every query that counts
-- only 'succeeded' therefore erases the ORIGINAL RECEIPT — retroactively, in a
-- period that may already be closed, filed, or settled, with nothing to show it
-- happened. `refunded` still means the money arrived; the reversal is a
-- separate event with its own date and is deducted there.
--
-- ── WHY THIS IS A MONEY BUG, NOT A REPORTING ONE ───────────────────────────
--
-- generate_franchise_settlements deducts the location's frozen share of a
-- refund AND, until now, lost the original revenue at the same time. The loss
-- was counted twice. Reproduced against the live database, $1000 payment
-- collected by the franchise, 10% royalty, refunded in the SAME period:
--
--   responsibility  | what it produced          | what is actually owed
--   ----------------+---------------------------+--------------------------
--   location        | location owes $1,000      | location owes $100
--   split           | location owes $900        | settled, $0
--   franchise       | settled, $0               | franchise owes location $900
--
-- Every mode wrong, and wrong in the direction that favours whoever runs the
-- generator. The `franchise` row is the one that should worry us most: the
-- franchise explicitly agreed to bear the chargeback, and the settlement
-- quietly paid the location nothing at all.
--
-- Note also `revenue_cents: 0` on a statement covering a $1,000 sale. A
-- franchisee reading that has no way to tell it apart from a month with no
-- business.
--
-- With the fix, the same three cases come out as the right-hand column, and
-- the arithmetic is visible on the statement: revenue $1,000, royalty $100,
-- adjustments as apportioned.
--
-- ── WHY NOT SUBTRACT THE REFUND FROM REVENUE INSTEAD ────────────────────────
--
-- Because a refund does not always fall in the period of the sale, and the two
-- treatments only agree when it does. Netting refunds into revenue works for a
-- same-period refund and silently misstates every carried-forward one. Keeping
-- the receipt where it happened and the reversal where IT happened is the only
-- treatment that survives a period boundary — and it is what an accountant
-- expects to see, which matters now that BUILD-13 hands these numbers over.
--
-- The TypeScript mirror of this rule lives in src/lib/revenue.ts, and a test
-- replays the list of statuses against this file so the two cannot drift.
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
     -- Money that ARRIVED. 'refunded' belongs here: the customer paid, and the
     -- reversal is accounted for separately by the adj CTE below. Dropping it
     -- would deduct the same loss twice — see the header.
     AND p.status IN ('succeeded', 'refunded')
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
        -- recalculation would drop it and quietly change what is owed (BUG-20).
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
  'BUILD-6: draws up each location''s settlement for a period — revenue, royalty, and the location''s share of refunds and chargebacks — and nets it into a single direction and amount. Revenue counts money that arrived, including payments later refunded, so a reversal is deducted once rather than twice (BUG-21). Safe to re-run: a draft is recalculated including the adjustments it already consumed (BUG-20), and a sent settlement is never rewritten.';

-- The franchise dashboard's "Revenue MTD" had the same filter and the same
-- flaw, minus the money movement: a refund made the month's revenue shrink
-- with no line explaining why, which is exactly the "discovered by accident"
-- failure the review queue exists to prevent.
CREATE OR REPLACE FUNCTION public.franchise_rollup(_parent_org uuid)
RETURNS TABLE(
  organization_id uuid, organization_name text, active_clients integer,
  visits_today integer, visits_completed_today integer, revenue_mtd_cents bigint,
  ar_open_cents bigint, tech_count integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _tz text;
  _today date;
  _month_start timestamptz;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), _parent_org, 'owner'::public.app_role)
    OR public.has_role(auth.uid(), _parent_org, 'office_manager'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized to view franchise rollup';
  END IF;

  SELECT coalesce(timezone, 'America/Chicago') INTO _tz
    FROM public.organizations WHERE id = _parent_org;
  _today := (now() AT TIME ZONE _tz)::date;
  _month_start := (date_trunc('month', (now() AT TIME ZONE _tz))) AT TIME ZONE _tz;

  RETURN QUERY
  WITH children AS (
    SELECT o.id, o.name
    FROM public.organizations o
    WHERE o.id = _parent_org OR o.parent_organization_id = _parent_org
  )
  SELECT
    c.id,
    c.name,
    COALESCE((SELECT COUNT(*)::int FROM public.clients cl
               WHERE cl.organization_id = c.id AND cl.active = true), 0),
    COALESCE((SELECT COUNT(*)::int FROM public.visits v
               WHERE v.organization_id = c.id AND v.scheduled_on = _today), 0),
    COALESCE((SELECT COUNT(*)::int FROM public.visits v
               WHERE v.organization_id = c.id AND v.scheduled_on = _today
                 AND v.status = 'completed'), 0),
    COALESCE((SELECT SUM(p.amount_cents)::bigint FROM public.payments p
               WHERE p.organization_id = c.id
                 AND p.status IN ('succeeded', 'refunded')
                 AND p.created_at >= _month_start), 0),
    COALESCE((SELECT SUM(GREATEST(i.total_cents - COALESCE(i.credit_applied_cents, 0), 0))::bigint
                FROM public.invoices i
               WHERE i.organization_id = c.id AND i.status = 'open'), 0),
    COALESCE((SELECT COUNT(*)::int FROM public.staff s
               WHERE s.organization_id = c.id AND s.active = true), 0)
  FROM children c
  ORDER BY (c.id = _parent_org) DESC, c.name;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_franchise_settlements(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_franchise_settlements(uuid, date, date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.franchise_rollup(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.franchise_rollup(uuid) TO authenticated, service_role;
