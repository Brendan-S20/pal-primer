-- BUG-24 (part 2) and BUG-27: the settlement nets against whoever actually
-- carried the loss, and its period boundaries are the ORGANIZATION's days.
--
-- ── BUG-24: the missing term ────────────────────────────────────────────────
--
-- See 20260731100000 for the reproduction. The balance credited only revenue
-- the PARENT collected but debited the location's share of every reversal,
-- including reversals whose money left the LOCATION's own Stripe account. So a
-- self-collecting location paid for its refunds twice, in all three chargeback
-- policies, always in the franchise's favour.
--
-- The formula now has the term that `franchise_share_cents` was written for and
-- nothing ever read:
--
--   balance = collected_by_parent
--           − royalty
--           − Σ location_share   where the PARENT paid the refund out
--           + Σ franchise_share  where the LOCATION paid the refund out
--
-- Read as: settle the half the OTHER party is carrying. If the franchise took
-- the money back out of its own account, the location owes it their share; if
-- the location did, the franchise owes them theirs. Verified against all six
-- combinations of collector × policy, plus the no-reversal case.
--
-- The compensating rows BUG-26 raises carry negative shares, so they flow
-- through the same two sums and repay in whichever direction the original
-- deduction ran. No special case.
--
-- ── BUG-27: the period was measured in UTC days ─────────────────────────────
--
-- `_start::timestamptz` resolves against the SERVER's timezone, which is UTC.
-- Every other money surface uses the organization's own calendar day —
-- franchise_rollup does `now() AT TIME ZONE _tz`, the tax pack does
-- `orgLocalDay`. So a payment taken at 22:00 on 31 July in Chicago is 03:00 on
-- 1 August in UTC: the tax pack bills it to July, the dashboard counts it in
-- July, and the July SETTLEMENT excluded it — revenue understated, royalty
-- billed a month late, and the two documents an owner reads side by side
-- disagreeing about the same sale.
--
-- Every payment after 19:00 local on a month's last day was landing on the
-- wrong statement. The period is now anchored in the organization's timezone,
-- which is what "the month of July" means to the person being billed.
--
-- ── Return value ────────────────────────────────────────────────────────────
--
-- Now the number of STATEMENTS written, not the number of adjustments
-- consumed. Both callers report it to a human as "Generated N", and they were
-- compensating by separately counting rows that already existed — so a run that
-- recalculated nothing (every statement already sent) still reported success
-- for each. Returning the real figure lets the callers stop guessing.
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
  _tz text;
  _from timestamptz;
  _to timestamptz;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), _parent, 'owner'::public.app_role)
    OR public.is_platform_admin(auth.uid())
    OR auth.role() = 'service_role'
  ) THEN
    RAISE EXCEPTION 'Only the franchise owner can generate settlements.';
  END IF;
  IF _end <= _start THEN
    RAISE EXCEPTION 'The period end must be after its start.';
  END IF;

  -- BUG-27: the franchise's own calendar, not the database's.
  SELECT coalesce(timezone, 'America/Chicago') INTO _tz
    FROM public.organizations WHERE id = _parent;
  _from := _start::timestamp AT TIME ZONE _tz;
  _to   := _end::timestamp   AT TIME ZONE _tz;

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
     AND p.created_at >= _from
     AND p.created_at <  _to
    GROUP BY k.id, k.pct
  ),
  adj AS (
    SELECT fa.child_organization_id AS child,
           -- BUG-24: what the location owes the franchise, for reversals the
           -- FRANCHISE paid out of its own account.
           coalesce(sum(fa.location_share_cents)
                    FILTER (WHERE fa.collected_by_organization_id = _parent), 0)::bigint AS loc_owes,
           -- ...and what the franchise owes the location, for reversals the
           -- LOCATION paid out of its own account. This is the term that was
           -- missing entirely.
           coalesce(sum(fa.franchise_share_cents)
                    FILTER (WHERE fa.collected_by_organization_id IS DISTINCT FROM _parent), 0)::bigint AS fran_owes
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
           coalesce(a.fran_owes, 0) AS fran_owes,
           (r.by_parent
            - round(r.total * r.pct / 100.0)
            - coalesce(a.loc_owes, 0)
            + coalesce(a.fran_owes, 0))::bigint AS balance
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
           -- Both directions of adjustment, so the statement's own arithmetic
           -- visibly adds up whichever way the reversal ran.
           loc_owes - fran_owes, 'draft', auth.uid()
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
  ),
  consume AS (
    UPDATE public.franchise_adjustments fa
       SET status = 'applied', applied_settlement_id = i.id
      FROM ins i
     WHERE fa.child_organization_id = i.child_organization_id
       AND fa.parent_organization_id = _parent
       AND fa.status = 'pending'
    RETURNING fa.id
  )
  -- The number of STATEMENTS drawn up. Both callers report this to a human.
  SELECT count(*)::integer INTO _n FROM ins;

  RETURN _n;
END;
$$;

COMMENT ON FUNCTION public.generate_franchise_settlements(uuid, date, date) IS
  'BUILD-6: draws up each location''s settlement for a period and returns how many statements it wrote. Revenue counts money that arrived (BUG-21); reversals net against whichever account actually paid them out (BUG-24); periods are the franchise''s own calendar days (BUG-27); re-running a draft includes the adjustments it already consumed (BUG-20) and never rewrites a sent statement.';

REVOKE ALL ON FUNCTION public.generate_franchise_settlements(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_franchise_settlements(uuid, date, date) TO authenticated, service_role;
