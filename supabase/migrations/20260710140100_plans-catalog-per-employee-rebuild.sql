-- Findings #6 + #51: rebuild the platform Plans catalog to match houndstack.com's
-- marketed per-employee model (Launch/Growth/Scale/Enterprise, $10/employee
-- overage, unlimited customers), replace the client-band tier assignment with a
-- seat-based one, add a real 14-day trial with an expiry mechanism, wire
-- organizations.plan_id for every org, and retire the duplicate free tiers
-- (Free/Puppy) and stale dog-themed client-band tiers. Old rows are DEACTIVATED,
-- not deleted, so history and any FK references remain intact. Applied to live
-- via Supabase MCP apply_migration on 2026-07-10. Idempotent.

ALTER TABLE public.platform_plans
  ADD COLUMN IF NOT EXISTS included_seats integer,
  ADD COLUMN IF NOT EXISTS price_per_seat_cents integer,
  ADD COLUMN IF NOT EXISTS is_enterprise boolean NOT NULL DEFAULT false;

ALTER TABLE public.platform_plans DROP CONSTRAINT IF EXISTS price_shape_present;
ALTER TABLE public.platform_plans ADD CONSTRAINT price_shape_present
  CHECK (is_free OR is_enterprise OR price_per_client_cents IS NOT NULL OR price_cents IS NOT NULL);

UPDATE public.platform_plans SET is_active = false, is_free = false;

INSERT INTO public.platform_plans
  (name, slug, description, price_cents, price_per_client_cents, client_limit_min, client_limit_max,
   included_seats, price_per_seat_cents, is_enterprise, currency, interval, is_active, is_free, sort_order)
VALUES
  ('Launch', 'launch', 'For new operations. Includes 3 employees; $10/mo per additional active employee. Unlimited customers.',
    7900, NULL, 0, NULL, 3, 1000, false, 'usd', 'month', true, false, 10),
  ('Growth', 'growth', 'For growing teams. Includes 10 employees; $10/mo per additional active employee. Unlimited customers.',
    19900, NULL, 0, NULL, 10, 1000, false, 'usd', 'month', true, false, 20),
  ('Scale', 'scale', 'For established operations. Includes 30 employees; $10/mo per additional active employee. Unlimited customers.',
    44900, NULL, 0, NULL, 30, 1000, false, 'usd', 'month', true, false, 30),
  ('Enterprise', 'enterprise', 'Custom pricing by contract. Multi-location, franchise rollup, and dedicated support.',
    NULL, NULL, 0, NULL, NULL, 1000, true, 'usd', 'month', true, false, 40)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price_cents = EXCLUDED.price_cents,
  price_per_client_cents = EXCLUDED.price_per_client_cents,
  client_limit_min = EXCLUDED.client_limit_min,
  client_limit_max = EXCLUDED.client_limit_max,
  included_seats = EXCLUDED.included_seats,
  price_per_seat_cents = EXCLUDED.price_per_seat_cents,
  is_enterprise = EXCLUDED.is_enterprise,
  interval = EXCLUDED.interval,
  is_active = true,
  is_free = false,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS active_seat_count integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.refresh_active_seat_count(_org_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $fn$
  UPDATE public.organizations
     SET active_seat_count = (
       SELECT COUNT(*) FROM public.staff WHERE organization_id = _org_id AND active = true
     ),
     updated_at = now()
   WHERE id = _org_id;
$fn$;

CREATE OR REPLACE FUNCTION public.assign_billing_tier_for_org(_org_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  _seats integer;
  _plan public.platform_plans;
BEGIN
  SELECT active_seat_count INTO _seats FROM public.organizations WHERE id = _org_id;
  IF _seats IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO _plan
  FROM public.platform_plans
  WHERE is_active = true AND is_enterprise = false AND included_seats IS NOT NULL
    AND included_seats >= GREATEST(_seats, 1)
  ORDER BY included_seats ASC, sort_order ASC
  LIMIT 1;

  IF _plan.id IS NULL THEN
    SELECT * INTO _plan
    FROM public.platform_plans
    WHERE is_active = true AND is_enterprise = false AND included_seats IS NOT NULL
    ORDER BY included_seats DESC, sort_order DESC
    LIMIT 1;
  END IF;

  IF _plan.id IS NOT NULL THEN
    UPDATE public.organizations
       SET billing_tier = _plan.slug,
           plan_id = _plan.id
     WHERE id = _org_id
       AND (billing_tier IS DISTINCT FROM _plan.slug OR plan_id IS DISTINCT FROM _plan.id);
  END IF;
  RETURN _plan.slug;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.org_seat_overage_cents(_org_id uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT GREATEST(0, COALESCE(o.active_seat_count, 0) - COALESCE(p.included_seats, 0))
         * COALESCE(p.price_per_seat_cents, 0)
  FROM public.organizations o
  LEFT JOIN public.platform_plans p ON p.id = o.plan_id
  WHERE o.id = _org_id;
$fn$;

CREATE OR REPLACE FUNCTION public.trg_reassign_billing_tier()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.active_client_count IS DISTINCT FROM OLD.active_client_count
     OR NEW.active_seat_count IS DISTINCT FROM OLD.active_seat_count THEN
    PERFORM public.assign_billing_tier_for_org(NEW.id);
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.tg_staff_maintain_seat_count()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.refresh_active_seat_count(OLD.organization_id);
    RETURN OLD;
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM public.refresh_active_seat_count(NEW.organization_id);
    RETURN NEW;
  ELSE
    IF NEW.organization_id <> OLD.organization_id OR NEW.active <> OLD.active THEN
      PERFORM public.refresh_active_seat_count(NEW.organization_id);
      IF NEW.organization_id <> OLD.organization_id THEN
        PERFORM public.refresh_active_seat_count(OLD.organization_id);
      END IF;
    END IF;
    RETURN NEW;
  END IF;
END;
$fn$;

DROP TRIGGER IF EXISTS staff_maintain_seat_count ON public.staff;
CREATE TRIGGER staff_maintain_seat_count
  AFTER INSERT OR UPDATE OR DELETE ON public.staff
  FOR EACH ROW EXECUTE FUNCTION public.tg_staff_maintain_seat_count();

CREATE OR REPLACE FUNCTION public.org_can_add_client(_org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT CASE
    WHEN o.plan_status IN ('active', 'past_due') THEN true
    WHEN o.plan_status = 'trialing' AND (o.trial_ends_at IS NULL OR o.trial_ends_at > now()) THEN true
    WHEN o.plan_status = 'free' THEN true
    ELSE false
  END
  FROM public.organizations o WHERE o.id = _org_id;
$fn$;

CREATE OR REPLACE FUNCTION public.tg_clients_enforce_plan_limit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE _ok boolean;
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.active)
     OR (TG_OP = 'UPDATE' AND NEW.active AND NOT OLD.active) THEN
    SELECT public.org_can_add_client(NEW.organization_id) INTO _ok;
    IF NOT _ok THEN
      RAISE EXCEPTION 'Your free trial has ended. Choose a plan to keep adding customers.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

UPDATE public.organizations o
   SET active_seat_count = (SELECT COUNT(*) FROM public.staff s WHERE s.organization_id = o.id AND s.active = true);

SELECT public.assign_billing_tier_for_org(id) FROM public.organizations WHERE deleted_at IS NULL;

UPDATE public.organizations
   SET plan_status = 'trialing',
       trial_ends_at = COALESCE(trial_ends_at, now() + interval '14 days')
 WHERE deleted_at IS NULL
   AND stripe_subscription_id IS NULL
   AND plan_status = 'free';
