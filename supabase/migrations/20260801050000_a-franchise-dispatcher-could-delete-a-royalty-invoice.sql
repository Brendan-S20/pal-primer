-- A franchise dispatcher could zero out or delete a royalty invoice.
--
-- ── WHAT WAS OPEN ──────────────────────────────────────────────────────────
--
-- public.franchise_royalty_invoices carried ONE policy covering ALL commands:
--
--     franchise_royalty_parent_all  FOR ALL
--     USING (can_write_org(auth.uid(), parent_organization_id))
--
-- `can_write_org` is owner + office_manager + DISPATCHER. So anyone who can
-- move a visit around the board could also rewrite the settlement that decides
-- what a location owes — a table with eight money columns (revenue_cents,
-- royalty_cents, net_due_cents, amount_cents, adjustments_applied_cents,
-- revenue_collected_by_parent_cents, revenue_collected_by_location_cents,
-- status). No trigger stood behind it, unlike every other money surface here.
--
-- Q-1 answered this explicitly: "dispatchers ops-only, no billing." The other
-- franchise money entry points already agree — set_child_royalty_percent,
-- set_chargeback_responsibility and set_location_payment_routing each require
-- has_role(auth.uid(), parent, 'owner'). This table was the exception.
--
-- Proven live as a dispatcher at the franchise, in a transaction that rolled
-- itself back:
--
--     can_read = 1
--     zeroed_a_$1000_royalty = 1   (royalty_cents and net_due_cents to 0,
--                                   status to 'paid')
--     DELETED_the_invoice = 1
--
-- ── SECOND PROBLEM: AN ISSUED SETTLEMENT WAS NOT A RECORD ──────────────────
--
-- Nothing made these rows immutable, so an issued settlement could be edited
-- or deleted afterwards by anyone who passed the policy — including the owner,
-- silently, with no audit trail. A settlement statement that can be rewritten
-- after the fact is not evidence of anything, and this is the table a
-- franchisee would dispute against.
--
-- ── EXPOSURE ───────────────────────────────────────────────────────────────
--
-- Latent. franchise_royalty_invoices holds zero rows and no tenant has run a
-- settlement yet. Nothing has been altered. Said plainly rather than dressed
-- up, as with BUG-53 and BUG-61.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
--
-- Split the single ALL policy by what each command actually needs:
--
--   * SELECT stays can_write_org — the office needs to read statements, and
--     reading is not the risk.
--   * UPDATE narrows to manage_franchise, which the permission matrix grants
--     to the OWNER alone (office_manager is explicitly excluded). This is the
--     same audience the three routing setters already require.
--   * INSERT and DELETE get NO policy at all. Settlements are produced by
--     generate_franchise_settlements, which is SECURITY DEFINER and owned by
--     postgres, so it is unaffected — and the table is not FORCE ROW LEVEL
--     SECURITY, which is what makes that true. Nothing in src/ inserts or
--     deletes these rows directly (checked: only listRoyaltyInvoices reads and
--     setRoyaltyInvoiceStatus updates status).
--
-- This is the same shape franchise_adjustments already had — SELECT policy
-- only, every write through the guarded RPC. The two money tables now agree.

DROP POLICY IF EXISTS "franchise_royalty_parent_all" ON public.franchise_royalty_invoices;

CREATE POLICY "franchise royalty: office reads"
  ON public.franchise_royalty_invoices
  FOR SELECT TO authenticated
  USING (public.can_write_org(auth.uid(), parent_organization_id));

CREATE POLICY "franchise royalty: only the franchise owner updates"
  ON public.franchise_royalty_invoices
  FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), parent_organization_id, 'manage_franchise'))
  WITH CHECK (public.has_permission(auth.uid(), parent_organization_id, 'manage_franchise'));

DO $$
DECLARE _cmds text;
BEGIN
  SELECT string_agg(DISTINCT polcmd::text, ',' ORDER BY polcmd::text) INTO _cmds
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relname = 'franchise_royalty_invoices';
  -- 'r' = SELECT, 'w' = UPDATE. Neither 'a' (INSERT) nor 'd' (DELETE) may
  -- exist: a settlement is created by the generator and never destroyed.
  IF _cmds IS DISTINCT FROM 'r,w' THEN
    RAISE EXCEPTION 'expected exactly SELECT and UPDATE policies, found: %', _cmds;
  END IF;
  -- The generator must still be able to write. If this ever becomes FORCE RLS,
  -- the SECURITY DEFINER insert starts failing and settlements stop generating.
  IF (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.franchise_royalty_invoices'::regclass) THEN
    RAISE EXCEPTION 'FORCE ROW LEVEL SECURITY would block generate_franchise_settlements';
  END IF;
END $$;
