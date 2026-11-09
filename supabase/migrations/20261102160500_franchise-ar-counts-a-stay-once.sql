-- Franchise AR counts a stay once (#653 part 2, decision D3).
--
-- A linked stay deposit (invoices.deposit_for_invoice_id, 20261102160000) is
-- part payment of its stay invoice, which carries the whole price. Each
-- location's open AR in franchise_rollup summed every open invoice, so an
-- unpaid deposit was counted on top of the stay it is part of. It is left out
-- here, exactly as src/lib/ar.ts leaves it out of the dashboard and reports.
-- Nothing else in the function changes.
--
-- Replays into an empty database: one function and a check of its body.

CREATE OR REPLACE FUNCTION public.franchise_rollup(_parent_org uuid)
RETURNS TABLE(organization_id uuid, organization_name text, active_clients integer, visits_today integer, visits_completed_today integer, revenue_mtd_cents bigint, revenue_mtd_gross_cents bigint, refunds_mtd_cents bigint, ar_open_cents bigint, tech_count integer)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
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

  RETURN QUERY
  WITH children AS (
    -- Includes the parent's own row, so a rollup reads as the whole franchise
    -- rather than "everyone but me".
    SELECT o.id, o.name, coalesce(o.timezone, 'America/Chicago') AS tz
    FROM public.organizations o
    WHERE o.id = _parent_org OR o.parent_organization_id = _parent_org
  ),
  clock AS (
    -- Each row's own day and its own month, rather than the parent's imposed on
    -- everyone. `now()` is evaluated once per statement, so every row is cut
    -- from the same instant; only the zone differs, which is the whole point.
    SELECT c.id, c.name, c.tz,
           (now() AT TIME ZONE c.tz)::date AS today,
           (date_trunc('month', (now() AT TIME ZONE c.tz)) AT TIME ZONE c.tz) AS month_start
    FROM children c
  ),
  money AS (
    SELECT c.id,
           COALESCE((SELECT SUM(p.amount_cents)::bigint FROM public.payments p
                      WHERE p.organization_id = c.id
                        AND p.status IN ('succeeded', 'refunded')
                        AND p.created_at >= c.month_start), 0) AS gross,
           COALESCE((SELECT SUM(
                       CASE WHEN ri.kind = 'payment_chargeback_won'
                            THEN -COALESCE((ri.detail->>'revenue_cents')::bigint, (ri.detail->>'amount_cents')::bigint)
                            ELSE  COALESCE((ri.detail->>'revenue_cents')::bigint, (ri.detail->>'amount_cents')::bigint) END
                     )::bigint
                       FROM public.review_items ri
                      WHERE ri.organization_id = c.id
                        AND ri.kind IN ('payment_refunded','payment_chargeback','payment_chargeback_won')
                        AND ri.detected_at >= c.month_start), 0) AS refunds
    FROM clock c
  )
  SELECT
    c.id,
    c.name,
    COALESCE((SELECT COUNT(*)::int FROM public.clients cl
               WHERE cl.organization_id = c.id AND cl.active = true), 0),
    COALESCE((SELECT COUNT(*)::int FROM public.visits v
               WHERE v.organization_id = c.id AND v.scheduled_on = c.today), 0),
    COALESCE((SELECT COUNT(*)::int FROM public.visits v
               WHERE v.organization_id = c.id AND v.scheduled_on = c.today
                 AND v.status = 'completed'), 0),
    (m.gross - m.refunds)::bigint,
    m.gross,
    m.refunds,
    COALESCE((SELECT SUM(GREATEST(i.total_cents - COALESCE(i.credit_applied_cents, 0) - COALESCE(i.amount_paid_cents, 0), 0))::bigint
                FROM public.invoices i
               WHERE i.organization_id = c.id AND i.status = 'open'
                 -- A linked deposit is part of a stay invoice counted here already.
                 AND i.deposit_for_invoice_id IS NULL), 0),
    COALESCE((SELECT COUNT(*)::int FROM public.staff s
               WHERE s.organization_id = c.id AND s.active = true), 0)
  FROM clock c JOIN money m ON m.id = c.id
  ORDER BY (c.id = _parent_org) DESC, c.name;
END;
$function$;

REVOKE ALL ON FUNCTION public.franchise_rollup(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.franchise_rollup(uuid) TO authenticated, service_role;

DO $check$
BEGIN
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.franchise_rollup(uuid)'::regprocedure)
       NOT LIKE '%i.deposit_for_invoice_id IS NULL%' THEN
    RAISE EXCEPTION 'franchise_rollup still counts a linked deposit as open AR';
  END IF;
END
$check$;
