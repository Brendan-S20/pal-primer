-- A field tech could read the franchise's money ledger and its live invite codes.
--
-- Both tables gated SELECT on `is_org_member`, which includes techs. Proven
-- live by building a franchise inside a transaction that rolled itself back:
--
--     tech_reads_adjustments   = 1   (amounts, shares, dispute notes)
--     tech_reads_link_code     = 1   (the plaintext code)
--     tech_reads_royalty_invoices = 0  ← the fix in 20260801050000 holding
--
-- ── 1. THE ADJUSTMENT LEDGER ───────────────────────────────────────────────
--
-- franchise_adjustments is every refund and chargeback moving between a
-- franchise and its locations: amount_cents, franchise_share_cents,
-- location_share_cents, dispute_ref and a free-text note.
--
-- The product reads it through franchise_adjustment_ledger(), which authorizes
-- `has_permission(auth.uid(), _org_id, 'view_financials') OR is_platform_admin`.
-- That gate was real and the table underneath was open, so anyone holding a
-- session could skip the function and read the rows straight off PostgREST.
-- This is the fifth instance of that shape in this codebase (BUG-33, BUG-36,
-- BUG-42, BUG-61, franchise_royalty_invoices) — the routine is not the
-- boundary, the policy is.
--
-- The policy now names the same permission the routine does. Techs and
-- dispatchers hold neither view_financials nor manage_client_billing, so they
-- lose the read; owners and office managers keep it on both sides of the
-- relationship, which is who franchise_adjustment_ledger was already serving.
--
-- ── 2. THE INVITE CODES ────────────────────────────────────────────────────
--
-- franchise_link_codes.code is a bearer credential: whoever holds an unused,
-- unexpired, unrevoked code can attach an organization they own to this
-- franchise (redeem_franchise_link_code requires the redeemer be an owner —
-- of the CHILD, not of this parent). Reading it was open to every member of
-- the issuing org.
--
-- What that buys an insider is bounded but real: burn a pending invitation so
-- the intended franchisee's code no longer works, and drop an unrelated
-- organization into the franchise's rollup, settlements and payment routing.
-- Only the owner can issue one (create_franchise_link_code checks
-- has_role owner) and only the owner manages them from the UI, so nothing in
-- the product needs a wider read.
--
-- No policy is added for INSERT/UPDATE/DELETE: codes are written by
-- create_franchise_link_code and redeem_franchise_link_code (both SECURITY
-- DEFINER) and by listFranchiseLinkCodes/revokeFranchiseLinkCode through the
-- service-role client, none of which are subject to these policies. Neither
-- table is FORCE ROW LEVEL SECURITY, which is what keeps that true.
--
-- ── EXPOSURE ───────────────────────────────────────────────────────────────
--
-- Latent. There is not one franchise in the database: zero rows in
-- franchise_adjustments and franchise_link_codes, and no organization has
-- is_franchise_parent or a parent_organization_id set. The probe above had to
-- build a franchise to have anything to read. Nothing has been exposed.

DROP POLICY IF EXISTS "franchise_adjustments_select" ON public.franchise_adjustments;

CREATE POLICY "franchise adjustments: whoever may see financials"
  ON public.franchise_adjustments
  FOR SELECT TO authenticated
  USING (
    public.has_permission(auth.uid(), parent_organization_id, 'view_financials')
    OR public.has_permission(auth.uid(), child_organization_id, 'view_financials')
    OR public.is_platform_admin(auth.uid())
  );

DROP POLICY IF EXISTS "franchise_link_codes_select" ON public.franchise_link_codes;

CREATE POLICY "franchise link codes: only the franchise owner"
  ON public.franchise_link_codes
  FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), parent_organization_id, 'manage_franchise'));

DO $$
DECLARE _cmds text; _expr text;
BEGIN
  FOR _cmds, _expr IN
    SELECT c.relname, pg_get_expr(p.polqual, p.polrelid)
      FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
     WHERE c.relname IN ('franchise_adjustments', 'franchise_link_codes')
  LOOP
    -- is_org_member is the defect: it is the only membership helper that
    -- includes techs, and it is what both of these used to say.
    IF _expr LIKE '%is_org_member%' THEN
      RAISE EXCEPTION '% still admits every org member: %', _cmds, _expr;
    END IF;
  END LOOP;

  SELECT string_agg(DISTINCT polcmd::text, ',' ORDER BY polcmd::text) INTO _cmds
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relname IN ('franchise_adjustments', 'franchise_link_codes');
  IF _cmds IS DISTINCT FROM 'r' THEN
    RAISE EXCEPTION 'expected SELECT-only policies on both tables, found: %', _cmds;
  END IF;

  IF (SELECT bool_or(relforcerowsecurity) FROM pg_class
       WHERE oid IN ('public.franchise_adjustments'::regclass,
                     'public.franchise_link_codes'::regclass)) THEN
    RAISE EXCEPTION 'FORCE ROW LEVEL SECURITY would block the SECURITY DEFINER writers';
  END IF;
END $$;
