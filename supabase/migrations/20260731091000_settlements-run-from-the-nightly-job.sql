-- IMP-10 follow-up: let the nightly job call the ONE settlement routine.
--
-- Royalty generation existed three times: this SQL function, a TypeScript loop
-- in franchise.functions.ts, and a second TypeScript loop in the nightly cron.
-- The two TypeScript copies predate settlements and know nothing about who
-- collected the money, about refunds, or about direction — they write a
-- royalty amount and leave `direction` and `net_due_cents` at their defaults,
-- so a nightly run silently produced a statement whose headline contradicted
-- its own arithmetic.
--
-- Three implementations of the same money calculation is not a duplication
-- smell; it is a guarantee that a fix lands in one of them. BUG-21 was fixed in
-- this function alone and both loops kept the old behaviour.
--
-- So both callers now delegate here, and this function needs to be callable by
-- the cron. It runs as service_role with no user session, so `auth.uid()` is
-- null and the owner check rejects it — which is why the nightly job grew its
-- own copy in the first place rather than calling the routine that already
-- existed.
--
-- The bypass is deliberately `auth.role() = 'service_role'` and nothing looser.
-- That role is reachable only from server code holding the service key; it is
-- the same exemption tg_orgs_protect_platform_columns already uses, so this
-- introduces no new trust boundary.
--
-- Idempotent. The body is otherwise byte-identical to the BUG-21 version.

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
  IF NOT (
    public.has_role(auth.uid(), _parent, 'owner'::public.app_role)
    OR public.is_platform_admin(auth.uid())
    -- The nightly cron. Server-side only; see the header.
    OR auth.role() = 'service_role'
  ) THEN
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
     AND p.status IN ('succeeded', 'refunded')   -- BUG-21: money that ARRIVED
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
        OR (fa.status = 'applied'                -- BUG-20: idempotent re-run
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

REVOKE ALL ON FUNCTION public.generate_franchise_settlements(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_franchise_settlements(uuid, date, date) TO authenticated, service_role;
