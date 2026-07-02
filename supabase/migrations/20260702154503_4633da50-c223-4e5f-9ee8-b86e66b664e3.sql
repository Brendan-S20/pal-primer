
CREATE OR REPLACE FUNCTION public.is_platform_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = 'platform_admin'
  )
$$;

REVOKE EXECUTE ON FUNCTION public.is_platform_admin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_platform_admin(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.platform_org_stats()
RETURNS TABLE (
  organization_id uuid,
  organization_name text,
  billing_tier text,
  plan_status text,
  active_clients bigint,
  users_count bigint,
  revenue_mtd_cents bigint,
  ar_open_cents bigint,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT
    o.id,
    o.name,
    o.billing_tier,
    o.plan_status::text,
    COALESCE((SELECT COUNT(*) FROM public.clients c WHERE c.organization_id = o.id AND c.is_active), 0),
    COALESCE((SELECT COUNT(DISTINCT ur.user_id) FROM public.user_roles ur WHERE ur.organization_id = o.id), 0),
    COALESCE((
      SELECT SUM(i.total_cents)::bigint
      FROM public.invoices i
      WHERE i.organization_id = o.id
        AND i.status = 'paid'
        AND i.issued_at >= date_trunc('month', now())
    ), 0),
    COALESCE((
      SELECT SUM(i.total_cents - COALESCE(i.amount_paid_cents, 0))::bigint
      FROM public.invoices i
      WHERE i.organization_id = o.id
        AND i.status IN ('open', 'overdue')
    ), 0),
    o.created_at
  FROM public.organizations o
  ORDER BY o.created_at DESC;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.platform_org_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_org_stats() TO authenticated;
