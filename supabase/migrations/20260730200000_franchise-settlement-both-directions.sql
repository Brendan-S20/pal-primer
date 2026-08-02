-- BUILD-6: settle a franchise period in whichever direction the money flowed.
-- Owner decision, 2026-07-30: support both, parent-collects is the primary.
--
-- The existing model only understood one direction — the franchisee collects
-- and owes a royalty. Under parent-collection the arrow reverses: the franchise
-- holds the cash and owes the location its share. Same inputs, opposite
-- counterparty. A model that only knows one of them would produce an invoice
-- billing a franchisee for money the franchise is already sitting on.
--
-- FIRST, PROVENANCE. payments recorded no indication of WHICH Stripe account
-- received the money. Without that, a location that switches routing
-- mid-period gets settled entirely by whatever is true on generation day —
-- every payment taken under the old arrangement misattributed, in the
-- calculation that decides who owes whom. So collection is now stamped on each
-- payment as it is taken (collectingOrgIdFor in stripe-connect.server.ts).
--
-- Existing rows are backfilled to their own organization. That is a fact, not
-- an assumption: parent-collection did not exist when they were written.
--
-- Cash handed to a location is deliberately recorded as collected BY the
-- location even when routing says otherwise — it never passed through anyone's
-- Stripe account, and crediting the franchise with holding it would make the
-- settlement claim they owe money they never received.
--
-- ONE FORMULA COVERS ALL THREE CASES:
--
--     balance = revenue_the_franchise_collected − (total_revenue × royalty%)
--
--   balance < 0  the franchise holds less than its cut  → location owes it
--   balance > 0  the franchise holds more than its cut  → it owes the location
--   balance = 0  they cancel exactly                    → settled
--
-- Verified live against all three, including a mid-period switch:
--   location collects $1,000 @10%  → location owes $100
--   franchise collects $1,000 @10% → franchise owes $900 (royalty $100)
--   $500 each side @10%            → franchise owes $400, having collected
--                                    $500 and being entitled to $100 of the
--                                    $1,000 total
--
-- The generator refuses to rewrite a settlement past 'draft', so a period
-- someone has already acted on cannot be silently recalculated underneath them.
--
-- Idempotent.

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS collected_by_organization_id uuid REFERENCES public.organizations(id);

COMMENT ON COLUMN public.payments.collected_by_organization_id IS
  'BUILD-6: which organization''s Stripe account actually received this money. Normally the payment''s own organization_id; for a franchise location whose parent collects, the PARENT. Recorded at charge time because routing can change — settling a period by today''s routing would misattribute every payment taken under the old arrangement.';

UPDATE public.payments
   SET collected_by_organization_id = organization_id
 WHERE collected_by_organization_id IS NULL;

CREATE INDEX IF NOT EXISTS payments_collected_by_idx
  ON public.payments (collected_by_organization_id, status, created_at);

ALTER TABLE public.franchise_royalty_invoices
  ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'location_owes_franchise',
  ADD COLUMN IF NOT EXISTS royalty_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS net_due_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS revenue_collected_by_parent_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS revenue_collected_by_location_cents bigint NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'franchise_royalty_direction_check') THEN
    ALTER TABLE public.franchise_royalty_invoices
      ADD CONSTRAINT franchise_royalty_direction_check
      CHECK (direction IN ('location_owes_franchise', 'franchise_owes_location', 'settled'));
  END IF;
END $$;

COMMENT ON COLUMN public.franchise_royalty_invoices.direction IS
  'BUILD-6: who pays whom for this period. location_owes_franchise = the franchisee collected and owes the royalty. franchise_owes_location = the franchise collected and owes the location its share after the royalty. settled = the two exactly cancel.';
COMMENT ON COLUMN public.franchise_royalty_invoices.royalty_cents IS
  'The franchise''s cut for the period: total revenue x royalty_percent. Always the same regardless of who collected — only who physically holds it changes.';
COMMENT ON COLUMN public.franchise_royalty_invoices.net_due_cents IS
  'What actually has to move, always a positive number. Read it together with direction.';

CREATE OR REPLACE FUNCTION public.generate_franchise_settlements(
  _parent uuid,
  _start date,
  _end date
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
    SELECT id, name, coalesce(franchise_royalty_percent, 0) AS pct
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
  calc AS (
    SELECT child, pct, by_parent, by_location, total,
           round(total * pct / 100.0)::bigint AS royalty,
           (by_parent - round(total * pct / 100.0))::bigint AS balance
    FROM rev
  )
  INSERT INTO public.franchise_royalty_invoices (
    parent_organization_id, child_organization_id, period_start, period_end,
    revenue_cents, royalty_percent, amount_cents,
    direction, royalty_cents, net_due_cents,
    revenue_collected_by_parent_cents, revenue_collected_by_location_cents,
    status, created_by
  )
  SELECT _parent, child, _start, _end,
         total, pct, royalty,
         CASE WHEN balance > 0 THEN 'franchise_owes_location'
              WHEN balance < 0 THEN 'location_owes_franchise'
              ELSE 'settled' END,
         royalty, abs(balance),
         by_parent, by_location,
         'draft', auth.uid()
  FROM calc
  ON CONFLICT (child_organization_id, period_start, period_end) DO UPDATE
    SET revenue_cents = EXCLUDED.revenue_cents,
        royalty_percent = EXCLUDED.royalty_percent,
        amount_cents = EXCLUDED.amount_cents,
        direction = EXCLUDED.direction,
        royalty_cents = EXCLUDED.royalty_cents,
        net_due_cents = EXCLUDED.net_due_cents,
        revenue_collected_by_parent_cents = EXCLUDED.revenue_collected_by_parent_cents,
        revenue_collected_by_location_cents = EXCLUDED.revenue_collected_by_location_cents
    WHERE public.franchise_royalty_invoices.status = 'draft';

  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;

COMMENT ON FUNCTION public.generate_franchise_settlements(uuid, date, date) IS
  'BUILD-6: settles a period for every location, in whichever direction the money actually flowed. Splits revenue by payments.collected_by_organization_id rather than by current routing, so a location that switched mid-period settles correctly. Idempotent; refuses to rewrite a settlement already past draft.';

REVOKE ALL ON FUNCTION public.generate_franchise_settlements(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_franchise_settlements(uuid, date, date) TO authenticated, service_role;
