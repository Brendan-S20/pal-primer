-- BUILD-6: only the FRANCHISE removes a location. Owner decision, 2026-07-30.
--
-- I built unlink so either side's owner could end the link, reasoning that a
-- relationship you can enter and cannot exit is a trap. That reasoning is wrong
-- for franchising specifically, and the owner corrected it: a franchisee is
-- contractually bound to the franchise system. Exit is governed by the
-- franchise agreement, not by a button in software. A location that could
-- silently detach itself — and with it stop the royalty accrual its parent
-- depends on — would let the product override the contract.
--
-- So membership is now the parent's to grant and the parent's to end.
--
-- The trap concern was still real, though, and it is answered rather than
-- ignored: PLATFORM ADMINS can also unlink. That covers the case the child-side
-- button was protecting against — a parent who abandons the franchise, stops
-- responding, or whose account is closed, leaving a franchisee permanently
-- attached to a dead organization with no recourse. Support can act; the
-- franchisee cannot act unilaterally. That matches how the underlying business
-- relationship actually works.
--
-- Idempotent.

CREATE OR REPLACE FUNCTION public.unlink_franchise_child(_child_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _caller_org uuid;
  _parent uuid;
BEGIN
  SELECT parent_organization_id INTO _parent
    FROM public.organizations WHERE id = _child_org_id;
  IF _parent IS NULL THEN
    RAISE EXCEPTION 'That organization is not part of a franchise.';
  END IF;

  SELECT organization_id INTO _caller_org FROM public.user_roles
   WHERE user_id = auth.uid() LIMIT 1;

  -- The parent's owner, or platform support. NOT the child — see the header.
  IF NOT (
    (_caller_org = _parent AND public.has_role(auth.uid(), _parent, 'owner'::public.app_role))
    OR public.is_platform_admin(auth.uid())
  ) THEN
    RAISE EXCEPTION 'Only the franchise owner can remove a location. If you need to leave a franchise, contact them — or contact HoundStack support if they are unreachable.';
  END IF;

  PERFORM set_config('app.allow_protected_org_write', '1', true);

  UPDATE public.organizations
     SET parent_organization_id = NULL,
         franchise_royalty_percent = 0
   WHERE id = _child_org_id;

  -- Stop calling an org a franchise parent once its last location is removed.
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE parent_organization_id = _parent) THEN
    UPDATE public.organizations SET is_franchise_parent = false WHERE id = _parent;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.unlink_franchise_child(uuid) IS
  'BUILD-6: removes a location from a franchise. The FRANCHISE OWNER or a platform admin only — a franchisee cannot detach itself, because exit is governed by the franchise agreement rather than by software. Platform admins are included so a franchisee whose parent has abandoned them is not permanently stranded. Royalty invoices already raised are preserved.';

REVOKE ALL ON FUNCTION public.unlink_franchise_child(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unlink_franchise_child(uuid) TO authenticated, service_role;
