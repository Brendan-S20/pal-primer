-- BUILD-6: the same RLS wall that made franchise_rollup necessary also breaks
-- every other "list my locations" query.
--
-- getFranchiseContext and getFranchiseTrend both did
-- `.eq("parent_organization_id", orgId)` on the caller's own client, which
-- returns ZERO rows for every possible caller: a parent is not a member of its
-- children, so "Members read own org" filters them all out. That is the actual
-- reason the franchise page always rendered "No child organizations linked
-- yet" — not an empty database.
--
-- A light helper so those two do not each have to run the full counting
-- rollup just to learn which locations exist.
--
-- Idempotent.
CREATE OR REPLACE FUNCTION public.franchise_children(_parent_org uuid)
RETURNS TABLE (id uuid, name text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), _parent_org, 'owner'::public.app_role)
    OR public.has_role(auth.uid(), _parent_org, 'office_manager'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized to view franchise locations';
  END IF;

  RETURN QUERY
  SELECT o.id, o.name
  FROM public.organizations o
  WHERE o.parent_organization_id = _parent_org
  ORDER BY o.name;
END;
$$;

COMMENT ON FUNCTION public.franchise_children(uuid) IS
  'BUILD-6: the parent''s linked locations. SECURITY DEFINER for the same reason as franchise_rollup — a parent cannot see its children under RLS, so the tenant-scoped query this replaces returned an empty list to everyone.';

REVOKE ALL ON FUNCTION public.franchise_children(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.franchise_children(uuid) TO authenticated, service_role;
