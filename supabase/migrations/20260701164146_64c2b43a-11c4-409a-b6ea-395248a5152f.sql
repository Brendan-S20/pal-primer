
CREATE TYPE public.org_plan_status AS ENUM ('free', 'active', 'past_due', 'canceled');

ALTER TABLE public.organizations
  ADD COLUMN stripe_customer_id text,
  ADD COLUMN stripe_subscription_id text,
  ADD COLUMN plan_status public.org_plan_status NOT NULL DEFAULT 'free',
  ADD COLUMN current_period_end timestamptz;

CREATE UNIQUE INDEX organizations_stripe_customer_id_key ON public.organizations(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE UNIQUE INDEX organizations_stripe_subscription_id_key ON public.organizations(stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

-- Free tier allows up to 3 active clients. Paid ('active') is unlimited. past_due keeps working; canceled reverts to free.
CREATE OR REPLACE FUNCTION public.org_can_add_client(_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN o.plan_status IN ('active', 'past_due') THEN true
    ELSE COALESCE(o.active_client_count, 0) < 3
  END
  FROM public.organizations o WHERE o.id = _org_id;
$$;

-- Enforce on client insert / reactivate
CREATE OR REPLACE FUNCTION public.tg_clients_enforce_plan_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _ok boolean;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.active THEN
    SELECT public.org_can_add_client(NEW.organization_id) INTO _ok;
    IF NOT _ok THEN
      RAISE EXCEPTION 'Free plan limit reached (3 active clients). Upgrade to add more.' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_OP = 'UPDATE' AND NEW.active AND NOT OLD.active THEN
    SELECT public.org_can_add_client(NEW.organization_id) INTO _ok;
    IF NOT _ok THEN
      RAISE EXCEPTION 'Free plan limit reached (3 active clients). Upgrade to reactivate more.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS clients_enforce_plan_limit ON public.clients;
CREATE TRIGGER clients_enforce_plan_limit
BEFORE INSERT OR UPDATE ON public.clients
FOR EACH ROW EXECUTE FUNCTION public.tg_clients_enforce_plan_limit();

GRANT EXECUTE ON FUNCTION public.org_can_add_client(uuid) TO authenticated;
