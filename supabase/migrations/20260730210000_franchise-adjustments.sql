-- BUILD-6: refunds and chargebacks. Owner decisions, 2026-07-30.
--
--   * A reversal carries forward into the next settlement, within 30 days.
--   * If the franchise wins the dispute and the money comes back, the
--     adjustment is repaid at that moment rather than waiting for a cycle.
--   * The franchise chooses, per location, who absorbs it.
--
-- THE GAP THIS CLOSES IS BIGGER THAN SETTLEMENT. The app recorded refunds and
-- chargebacks NOWHERE. The Stripe webhook handled exactly four event types —
-- checkout.session.completed, payment_intent.succeeded,
-- payment_intent.payment_failed, account.updated — so a refund simply did not
-- exist as far as HoundStack was concerned. Revenue, reports, dashboards and
-- settlements all counted money that had gone back to the customer.
--
-- Shares are FROZEN at creation from the policy in force at that moment.
-- Changing who absorbs chargebacks later must not silently rewrite who owed
-- what on an event that already happened. Verified: after switching a location
-- from 'location' to 'split', the existing adjustment is unchanged.
--
-- Both sides can READ an adjustment. A deduction a franchisee cannot look up is
-- indistinguishable from an error, and they will assume the worst.
--
-- Idempotent.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS chargeback_responsibility text NOT NULL DEFAULT 'location';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orgs_chargeback_responsibility_check') THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT orgs_chargeback_responsibility_check
      CHECK (chargeback_responsibility IN ('location', 'franchise', 'split'));
  END IF;
END $$;

COMMENT ON COLUMN public.organizations.chargeback_responsibility IS
  'BUILD-6: who absorbs a refund or chargeback on this location''s revenue. location = deducted from the location (default; they did the work and set the price). franchise = the franchise eats it. split = shared in the royalty proportion, so each gives back exactly what they took. Set by the franchise owner.';

CREATE TABLE IF NOT EXISTS public.franchise_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  child_organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  payment_id uuid REFERENCES public.payments(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('refund','chargeback','chargeback_won','manual')),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  franchise_share_cents bigint NOT NULL DEFAULT 0,
  location_share_cents  bigint NOT NULL DEFAULT 0,
  original_period_start date,
  original_period_end   date,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','applied','reversed','written_off')),
  due_by date NOT NULL DEFAULT (current_date + 30),
  applied_settlement_id uuid REFERENCES public.franchise_royalty_invoices(id) ON DELETE SET NULL,
  reversed_at timestamptz,
  reversed_by_adjustment_id uuid REFERENCES public.franchise_adjustments(id) ON DELETE SET NULL,
  note text CHECK (char_length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, kind)
);

CREATE INDEX IF NOT EXISTS franchise_adjustments_open_idx
  ON public.franchise_adjustments (parent_organization_id, status, due_by);
CREATE INDEX IF NOT EXISTS franchise_adjustments_child_idx
  ON public.franchise_adjustments (child_organization_id, status);

ALTER TABLE public.franchise_adjustments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS franchise_adjustments_select ON public.franchise_adjustments;
CREATE POLICY franchise_adjustments_select ON public.franchise_adjustments
  FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid(), parent_organization_id)
    OR public.is_org_member(auth.uid(), child_organization_id)
    OR public.is_platform_admin(auth.uid())
  );

GRANT SELECT ON public.franchise_adjustments TO authenticated;
GRANT ALL ON public.franchise_adjustments TO service_role;

COMMENT ON TABLE public.franchise_adjustments IS
  'BUILD-6: refunds and chargebacks that reverse revenue already settled. Carried into the next settlement rather than reopening a closed period. Shares are frozen at creation so a later policy change cannot rewrite history. A won dispute reverses the adjustment immediately.';
