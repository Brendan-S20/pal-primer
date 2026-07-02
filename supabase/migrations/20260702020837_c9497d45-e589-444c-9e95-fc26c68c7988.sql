
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS parent_organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_franchise_parent boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_orgs_parent ON public.organizations(parent_organization_id);

CREATE OR REPLACE FUNCTION public.franchise_rollup(_parent_org uuid)
RETURNS TABLE (
  organization_id uuid,
  organization_name text,
  active_clients integer,
  visits_today integer,
  visits_completed_today integer,
  revenue_mtd_cents bigint,
  ar_open_cents bigint,
  tech_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Authorize: caller must be owner or office_manager of the parent org, or the parent itself
  IF NOT (
    public.has_role(auth.uid(), _parent_org, 'owner'::public.app_role)
    OR public.has_role(auth.uid(), _parent_org, 'office_manager'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized to view franchise rollup';
  END IF;

  RETURN QUERY
  WITH children AS (
    SELECT o.id, o.name
    FROM public.organizations o
    WHERE o.id = _parent_org OR o.parent_organization_id = _parent_org
  )
  SELECT
    c.id,
    c.name,
    COALESCE((SELECT COUNT(*)::int FROM public.clients cl WHERE cl.organization_id = c.id AND cl.status = 'active'), 0),
    COALESCE((SELECT COUNT(*)::int FROM public.visits v WHERE v.organization_id = c.id AND v.scheduled_on = CURRENT_DATE), 0),
    COALESCE((SELECT COUNT(*)::int FROM public.visits v WHERE v.organization_id = c.id AND v.scheduled_on = CURRENT_DATE AND v.status = 'completed'), 0),
    COALESCE((SELECT SUM(p.amount_cents)::bigint FROM public.payments p WHERE p.organization_id = c.id AND p.status = 'succeeded' AND p.created_at >= date_trunc('month', now())), 0),
    COALESCE((SELECT SUM(i.total_cents - COALESCE(i.amount_paid_cents,0))::bigint FROM public.invoices i WHERE i.organization_id = c.id AND i.status IN ('open','draft','past_due')), 0),
    COALESCE((SELECT COUNT(*)::int FROM public.staff s WHERE s.organization_id = c.id AND s.active = true), 0)
  FROM children c
  ORDER BY c.name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.franchise_rollup(uuid) TO authenticated;
