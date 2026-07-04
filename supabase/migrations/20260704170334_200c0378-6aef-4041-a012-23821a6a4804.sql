
-- Picks a plan slug based on active client count and updates organizations.billing_tier
CREATE OR REPLACE FUNCTION public.assign_billing_tier_for_org(_org_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _count integer;
  _slug text;
BEGIN
  SELECT active_client_count INTO _count FROM public.organizations WHERE id = _org_id;
  IF _count IS NULL THEN RETURN NULL; END IF;

  SELECT slug INTO _slug
  FROM public.platform_plans
  WHERE is_active = true
    AND client_limit_min <= _count
    AND (client_limit_max IS NULL OR client_limit_max >= _count)
  ORDER BY sort_order ASC
  LIMIT 1;

  IF _slug IS NOT NULL THEN
    UPDATE public.organizations SET billing_tier = _slug WHERE id = _org_id AND billing_tier IS DISTINCT FROM _slug;
  END IF;
  RETURN _slug;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_reassign_billing_tier()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.active_client_count IS DISTINCT FROM OLD.active_client_count THEN
    PERFORM public.assign_billing_tier_for_org(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organizations_assign_tier ON public.organizations;
CREATE TRIGGER organizations_assign_tier
AFTER INSERT OR UPDATE OF active_client_count ON public.organizations
FOR EACH ROW EXECUTE FUNCTION public.trg_reassign_billing_tier();

CREATE OR REPLACE FUNCTION public.reassign_all_billing_tiers()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _n integer := 0;
  _r record;
BEGIN
  FOR _r IN SELECT id FROM public.organizations LOOP
    PERFORM public.assign_billing_tier_for_org(_r.id);
    _n := _n + 1;
  END LOOP;
  RETURN _n;
END;
$$;
