-- `franchise_rollup` and a location's own dashboard disagreed about the same
-- month by exactly the surcharge.
--
-- Refund reversals now carry TWO figures: `detail.amount_cents` is what MOVED
-- (base + surcharge — what the customer got back, what reconciles against
-- Stripe) and `detail.revenue_cents` is what comes off INCOME (base only,
-- because the surcharge was fee recovery and was never revenue).
--
-- `loadOrgReversals` was updated to prefer `revenue_cents`. This function was
-- not. Both then subtract their figure from a gross built the same way, out of
-- `payments.amount_cents` — which is base only. For a pass-through location
-- with $10,000 collected and one $100 invoice charged as $103 and refunded:
--
--   the location's own Dashboard    100000 - 10000 = $9,000.00
--   the franchise's rollup          100000 - 10300 = $8,997.00
--
-- Two screens, same month, $3.00 apart. That is the BUG-21 shape — one number
-- with two implementations — reintroduced by fixing only one of them.
--
-- ONLY the two reversal expressions change; the rest is the live definition
-- verbatim. A first draft of this migration rewrote the whole function from
-- scratch and invented a DIFFERENT return shape — 7 columns against the live
-- 10 — which would have broken every caller. Checked against
-- pg_get_function_result before applying.
--
-- The COALESCE fallback is not decoration: every reversal filed before the
-- split has no `revenue_cents`, and falling back to `amount_cents` is exactly
-- right for those rows — they predate pass-through, so the two were equal.
-- Without it, historical months would net to zero refunds.

CREATE OR REPLACE FUNCTION public.franchise_rollup(_parent_org uuid)
RETURNS TABLE(organization_id uuid, organization_name text, active_clients integer, visits_today integer, visits_completed_today integer, revenue_mtd_cents bigint, revenue_mtd_gross_cents bigint, refunds_mtd_cents bigint, ar_open_cents bigint, tech_count integer)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
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

  -- BUILD-1: the role check settled WHO may act; this settles whether the
  -- organization bought the capability. See the header.
  IF NOT public.has_plan_entitlement(_parent_org, 'franchise_structure') THEN
    RAISE EXCEPTION 'PLAN_UPGRADE_REQUIRED: Franchise management is included on Enterprise and above. This organization is on %.',
      initcap(public.plan_tier_for_org(_parent_org));
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
                            THEN -COALESCE((ri.detail->>'revenue_cents')::bigint, (ri.detail->>'amount_cents')::bigint)
                            ELSE  COALESCE((ri.detail->>'revenue_cents')::bigint, (ri.detail->>'amount_cents')::bigint) END
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
$function$;
