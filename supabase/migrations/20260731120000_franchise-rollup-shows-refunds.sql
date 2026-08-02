-- IMP-10: the franchise dashboard shows what came back, instead of quietly
-- counting it as revenue.
--
-- BUG-21 changed this function to count money that ARRIVED — payments that are
-- 'succeeded' OR 'refunded' — which fixed one problem and created the mirror of
-- it here. Before, a refund made a location's "Revenue MTD" shrink with nothing
-- to explain why. After, it doesn't shrink at all, which is worse: the number
-- is now confidently wrong in the flattering direction. A location that took
-- $5,000 on Monday and had it disputed on Wednesday reads $5,000 for the rest
-- of the month while its bank balance is zero.
--
-- The rule in src/lib/revenue.ts is only sound with BOTH halves — money counted
-- where it arrived, reversals deducted where they happened. This is the second
-- half, for this surface.
--
-- Three columns rather than one adjusted number, matching /reports and the tax
-- pack: gross, what came back, net. A franchise owner comparing a location's
-- statement to this screen needs to see the same components, or the settlement
-- looks like it disagrees with the dashboard.
--
-- Reversals come from review_items — the same rows the tenant was alerted with,
-- and the same source src/lib/reversals.server.ts reads. A won dispute is a
-- recovery and is netted OFF the deduction rather than added to it; counting a
-- recovery as a loss would understate by twice the amount.
--
-- The return type gains columns, so this is a DROP and CREATE rather than a
-- REPLACE. Nothing else calls it: getFranchiseRollup is the only caller.
--
-- Idempotent.

DROP FUNCTION IF EXISTS public.franchise_rollup(uuid);

CREATE FUNCTION public.franchise_rollup(_parent_org uuid)
RETURNS TABLE(
  organization_id uuid,
  organization_name text,
  active_clients integer,
  visits_today integer,
  visits_completed_today integer,
  revenue_mtd_cents bigint,
  revenue_mtd_gross_cents bigint,
  refunds_mtd_cents bigint,
  ar_open_cents bigint,
  tech_count integer
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
  ),
  money AS (
    SELECT c.id,
           COALESCE((SELECT SUM(p.amount_cents)::bigint FROM public.payments p
                      WHERE p.organization_id = c.id
                        AND p.status IN ('succeeded', 'refunded')
                        AND p.created_at >= _month_start), 0) AS gross,
           COALESCE((SELECT SUM(
                       CASE WHEN ri.kind = 'payment_chargeback_won'
                            THEN -(ri.detail->>'amount_cents')::bigint
                            ELSE  (ri.detail->>'amount_cents')::bigint END
                     )::bigint
                       FROM public.review_items ri
                      WHERE ri.organization_id = c.id
                        AND ri.kind IN ('payment_refunded','payment_chargeback','payment_chargeback_won')
                        AND ri.detected_at >= _month_start), 0) AS refunds
    FROM children c
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
    (m.gross - m.refunds)::bigint,
    m.gross,
    m.refunds,
    COALESCE((SELECT SUM(GREATEST(i.total_cents - COALESCE(i.credit_applied_cents, 0), 0))::bigint
                FROM public.invoices i
               WHERE i.organization_id = c.id AND i.status = 'open'), 0),
    COALESCE((SELECT COUNT(*)::int FROM public.staff s
               WHERE s.organization_id = c.id AND s.active = true), 0)
  FROM children c JOIN money m ON m.id = c.id
  ORDER BY (c.id = _parent_org) DESC, c.name;
END;
$$;

COMMENT ON FUNCTION public.franchise_rollup(uuid) IS
  'BUILD-6: each location''s headline numbers for the franchise dashboard. revenue_mtd_cents is NET — gross money received this month less refunds and chargebacks recorded this month, with both components returned separately so the dashboard and a settlement statement show the same arithmetic (IMP-10).';

REVOKE ALL ON FUNCTION public.franchise_rollup(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.franchise_rollup(uuid) TO authenticated, service_role;
