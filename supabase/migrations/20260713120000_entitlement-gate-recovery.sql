-- P0.1: the client-creation gate had no recovery path for canceled tenants.
--
-- 1. org_can_add_client now honors an admin-granted grace window
--    (organizations.grace_expires_at), so Platform Admin has a real lever to
--    unblock a tenant whose subscription lapsed while they sort out billing.
-- 2. The trigger message was always "Your free trial has ended…" even for
--    canceled subscriptions — misleading for tenants that were never on a
--    trial. The message now matches the org's actual state.

CREATE OR REPLACE FUNCTION public.org_can_add_client(_org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT CASE
    WHEN o.plan_status IN ('active', 'past_due') THEN true
    WHEN o.plan_status = 'trialing' AND (o.trial_ends_at IS NULL OR o.trial_ends_at > now()) THEN true
    WHEN o.plan_status = 'free' THEN true
    -- Admin-granted grace window: lets a canceled/lapsed tenant keep working
    -- long enough to reach their own Billing settings and reactivate.
    WHEN o.grace_expires_at IS NOT NULL AND o.grace_expires_at > now() THEN true
    ELSE false
  END
  FROM public.organizations o WHERE o.id = _org_id;
$fn$;

CREATE OR REPLACE FUNCTION public.tg_clients_enforce_plan_limit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  _ok boolean;
  _status text;
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.active)
     OR (TG_OP = 'UPDATE' AND NEW.active AND NOT OLD.active) THEN
    SELECT public.org_can_add_client(NEW.organization_id) INTO _ok;
    IF NOT _ok THEN
      SELECT o.plan_status::text INTO _status
        FROM public.organizations o WHERE o.id = NEW.organization_id;
      IF _status = 'canceled' THEN
        RAISE EXCEPTION 'Your subscription is canceled. Reactivate a plan in Settings → Billing to keep adding customers.'
          USING ERRCODE = 'check_violation';
      ELSIF _status = 'trialing' THEN
        RAISE EXCEPTION 'Your free trial has ended. Choose a plan to keep adding customers.'
          USING ERRCODE = 'check_violation';
      ELSE
        RAISE EXCEPTION 'Your current plan status (%) doesn''t allow adding customers. Visit Settings → Billing to update your plan.', COALESCE(_status, 'unknown')
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
