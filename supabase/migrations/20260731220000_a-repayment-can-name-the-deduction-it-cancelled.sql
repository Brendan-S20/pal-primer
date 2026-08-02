-- BUG-26, the half that was never readable: which repayment cancelled which
-- deduction.
--
-- `record_franchise_adjustment` has written `reversed_at` and
-- `reversed_by_adjustment_id` since the reversal work landed, and NOTHING has
-- ever read either one. Verified against the live database on 2026-07-31: the
-- only function whose body mentions those two columns is the function that
-- writes them, no view or policy references them, and `generate_franchise_
-- settlements` filters adjustments on `status` alone. So the link from a
-- reversed chargeback deduction to the compensating adjustment that repaid it
-- existed in the table and in no answer the product could give.
--
-- That matters because of who asks. A settlement statement itemises gross,
-- refunds and net, and both a franchise owner and a franchisee reconcile it
-- against their bank. When a dispute is won AFTER the statement went out,
-- BUG-26 raises a compensating `chargeback_won` adjustment with negated shares,
-- and the next statement's adjustment total silently gets smaller. Without the
-- link, that credit is an unexplained swing: the franchisee sees "+$600" on one
-- statement and a "-$600" deduction on another two months earlier, with nothing
-- in the product joining them. Asking your franchisor to explain a number their
-- software cannot explain is exactly how a deduction becomes a dispute.
--
-- WHY A FUNCTION AND NOT A VIEW READ FROM THE CLIENT. The child side has to be
-- able to read this — a deduction a franchisee cannot look up is
-- indistinguishable from an error. `franchise_adjustments` already allows both
-- parties to SELECT, but `franchise_royalty_invoices` is parent-only
-- (`can_write_org(auth.uid(), parent_organization_id)`), so a franchisee cannot
-- see WHICH PERIOD their own deduction was billed in, which is the one fact
-- that makes the trail reconcilable against a bank statement. This function is
-- SECURITY DEFINER so both sides get the same answer, and it does its own
-- authorization: `view_financials` on the organization being asked about.
--
-- WHY BOTH DIRECTIONS. Reading down (a deduction naming its repayment) is what
-- a franchisee querying an old charge needs. Reading up (a repayment naming the
-- deduction it cancels) is what someone reading THIS period's statement needs,
-- because the credit is the line they cannot account for. Same link, two
-- questions, and only one of them is answered by following the column forwards.
--
-- `reversed_at` is what makes it a sequence rather than a pair: "deducted 3 Jun,
-- reversed 14 Jul, repaid on the July statement" is a story; two amounts and a
-- foreign key is not.
--
-- Idempotent. Read-only — adds a reader, changes no writer and no data.

DROP FUNCTION IF EXISTS public.franchise_adjustment_ledger(uuid);

CREATE FUNCTION public.franchise_adjustment_ledger(_org_id uuid)
RETURNS TABLE (
  id uuid,
  child_organization_id uuid,
  child_name text,
  payment_id uuid,
  kind text,
  status text,
  amount_cents bigint,
  franchise_share_cents bigint,
  location_share_cents bigint,
  collected_by_parent boolean,
  note text,
  dispute_ref text,
  created_at timestamptz,
  settlement_id uuid,
  settlement_period_start date,
  settlement_period_end date,
  settlement_status text,
  -- The two columns this migration exists to make answerable.
  reversed_at timestamptz,
  reversed_by_adjustment_id uuid,
  -- …resolved forwards: the compensating adjustment, and the statement it was
  -- (or will be) repaid on.
  repaid_amount_cents bigint,
  repaid_at timestamptz,
  repaid_settlement_id uuid,
  repaid_settlement_period_start date,
  repaid_settlement_period_end date,
  repaid_settlement_status text,
  -- …and backwards: for a repayment line, the deduction it cancels.
  repays_adjustment_id uuid,
  repays_amount_cents bigint,
  repays_created_at timestamptz,
  repays_settlement_period_start date,
  repays_settlement_period_end date
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Deliberately NOT is_org_member, which is what the table's own SELECT policy
  -- uses. These are money lines on a settlement; a tech being able to read them
  -- because they happen to work at the location is not the same permission as
  -- being able to read the settlement they appear on.
  IF NOT (
    public.has_permission(auth.uid(), _org_id, 'view_financials')
    OR public.is_platform_admin(auth.uid())
    OR auth.role() = 'service_role'
  ) THEN
    RAISE EXCEPTION 'Not authorized to view settlement adjustments for this organization.';
  END IF;

  RETURN QUERY
  SELECT
    fa.id,
    fa.child_organization_id,
    kid.name,
    fa.payment_id,
    fa.kind,
    fa.status,
    fa.amount_cents,
    fa.franchise_share_cents,
    fa.location_share_cents,
    (fa.collected_by_organization_id = fa.parent_organization_id),
    fa.note,
    fa.dispute_ref,
    fa.created_at,
    fa.applied_settlement_id,
    own.period_start,
    own.period_end,
    own.status,
    fa.reversed_at,
    fa.reversed_by_adjustment_id,
    rep.amount_cents,
    rep.created_at,
    rep.applied_settlement_id,
    reps.period_start,
    reps.period_end,
    reps.status,
    back.id,
    back.amount_cents,
    back.created_at,
    backs.period_start,
    backs.period_end
  FROM public.franchise_adjustments fa
  JOIN public.organizations kid ON kid.id = fa.child_organization_id
  LEFT JOIN public.franchise_royalty_invoices own ON own.id = fa.applied_settlement_id
  -- Forwards: this row was reversed BY rep.
  LEFT JOIN public.franchise_adjustments rep ON rep.id = fa.reversed_by_adjustment_id
  LEFT JOIN public.franchise_royalty_invoices reps ON reps.id = rep.applied_settlement_id
  -- Backwards: this row IS the reversal of back.
  LEFT JOIN public.franchise_adjustments back ON back.reversed_by_adjustment_id = fa.id
  LEFT JOIN public.franchise_royalty_invoices backs ON backs.id = back.applied_settlement_id
  -- One predicate serves both callers: a parent asking about itself gets every
  -- location's lines, a location asking about itself gets only its own. Neither
  -- can name the other's organization and get anything, because the
  -- authorization above is against the id they passed.
  WHERE fa.child_organization_id = _org_id
     OR fa.parent_organization_id = _org_id
  ORDER BY fa.created_at DESC, fa.id;
END;
$function$;

COMMENT ON FUNCTION public.franchise_adjustment_ledger(uuid) IS
  'BUG-26 readback: the settlement adjustment lines for a franchise parent (all its locations) or a location (its own), with reversed_at and reversed_by_adjustment_id resolved in BOTH directions — a deduction names the repayment that cancelled it and the statement that repaid it, and a repayment names the deduction it cancels. SECURITY DEFINER because franchise_royalty_invoices is parent-only under RLS and a franchisee must still be able to see which period their own deduction was billed in. Requires view_financials on the organization asked about.';

REVOKE ALL ON FUNCTION public.franchise_adjustment_ledger(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.franchise_adjustment_ledger(uuid) TO authenticated, service_role;

COMMENT ON COLUMN public.franchise_adjustments.reversed_by_adjustment_id IS
  'BUG-26: the compensating adjustment that repaid this deduction after the dispute was won and the statement had already gone out. Read by franchise_adjustment_ledger() in both directions, so a settlement line can say which repayment cancelled which deduction.';

COMMENT ON COLUMN public.franchise_adjustments.reversed_at IS
  'BUG-26: when this adjustment was cancelled by a won dispute. Read by franchise_adjustment_ledger() — it is what turns the deduction and its repayment into a sequence a franchisee can reconcile against their bank rather than two unrelated amounts.';
