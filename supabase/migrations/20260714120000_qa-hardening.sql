-- QA-review hardening (adversarial review of the referral program, platform
-- add-ons, and signup attribution).
--
-- Finding 1 (HIGH): organizations is owner-updatable with no column
-- restriction, so a referred org's owner could set plan_status='active' +
-- a fake stripe_subscription_id via direct PostgREST and self-convert a
-- referral into a cash payout (and, generally, bypass the entitlement gate).
-- Fix: a BEFORE UPDATE trigger blocks changes to billing/attribution columns
-- unless the write comes from the service role or from one of our
-- SECURITY DEFINER functions (which set a transaction-local flag).
CREATE OR REPLACE FUNCTION public.tg_orgs_protect_platform_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND COALESCE(current_setting('app.allow_protected_org_write', true), '') <> '1' THEN
    IF NEW.plan_status        IS DISTINCT FROM OLD.plan_status
    OR NEW.billing_status     IS DISTINCT FROM OLD.billing_status
    OR NEW.plan_id            IS DISTINCT FROM OLD.plan_id
    OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id
    OR NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id
    OR NEW.grace_expires_at   IS DISTINCT FROM OLD.grace_expires_at
    OR NEW.trial_ends_at      IS DISTINCT FROM OLD.trial_ends_at
    OR NEW.suspended_at       IS DISTINCT FROM OLD.suspended_at
    OR NEW.deleted_at         IS DISTINCT FROM OLD.deleted_at
    OR NEW.referral_code      IS DISTINCT FROM OLD.referral_code
    OR NEW.referred_by_org_id IS DISTINCT FROM OLD.referred_by_org_id
    OR NEW.signup_ref_code    IS DISTINCT FROM OLD.signup_ref_code
    OR NEW.ai_receptionist_enabled IS DISTINCT FROM OLD.ai_receptionist_enabled THEN
      RAISE EXCEPTION 'These account fields can only be changed by the platform.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

-- Named to sort (and therefore run) before the other BEFORE UPDATE triggers,
-- so it inspects the caller's values, not values other triggers derive.
DROP TRIGGER IF EXISTS aa_orgs_protect_platform_columns ON public.organizations;
CREATE TRIGGER aa_orgs_protect_platform_columns
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.tg_orgs_protect_platform_columns();

-- get_or_create_org_referral_code legitimately writes referral_code from an
-- authenticated session: mark its transaction as platform-approved.
CREATE OR REPLACE FUNCTION public.get_or_create_org_referral_code(_org_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  _code text;
  _try int := 0;
BEGIN
  IF NOT public.is_org_member(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM set_config('app.allow_protected_org_write', '1', true);

  SELECT referral_code INTO _code FROM public.organizations WHERE id = _org_id;
  IF _code IS NOT NULL THEN RETURN _code; END IF;

  LOOP
    _try := _try + 1;
    SELECT string_agg(substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', (floor(random() * 31) + 1)::int, 1), '')
      INTO _code FROM generate_series(1, 8);
    BEGIN
      UPDATE public.organizations SET referral_code = _code, updated_at = now()
       WHERE id = _org_id AND referral_code IS NULL;
      RETURN (SELECT referral_code FROM public.organizations WHERE id = _org_id);
    EXCEPTION WHEN unique_violation THEN
      IF _try > 5 THEN RAISE; END IF;
    END;
  END LOOP;
END;
$fn$;

-- bootstrap_organization also writes attribution columns, and picks up the
-- volume-flag off-by-one from the review (finding 9: flag should fire ON the
-- Nth referral, counting this one).
CREATE OR REPLACE FUNCTION public.bootstrap_organization(
  _org_name text,
  _display_name text,
  _ref_code text DEFAULT NULL,
  _utm jsonb DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _org_id uuid;
  _existing uuid;
  _referrer_org uuid;
  _new_email text;
  _flag_reason text := NULL;
  _recent_count int;
  _threshold int;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF public.is_platform_admin(_uid) THEN
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('bootstrap_organization:' || _uid::text, 0));

  SELECT organization_id INTO _existing FROM public.user_roles WHERE user_id = _uid LIMIT 1;
  IF _existing IS NOT NULL THEN
    RETURN _existing;
  END IF;

  PERFORM set_config('app.allow_protected_org_write', '1', true);

  INSERT INTO public.organizations(name) VALUES (_org_name) RETURNING id INTO _org_id;
  INSERT INTO public.user_roles(user_id, organization_id, role) VALUES (_uid, _org_id, 'owner');
  INSERT INTO public.staff(organization_id, user_id, role, display_name, active)
    VALUES (_org_id, _uid, 'owner', _display_name, true);

  IF _ref_code IS NOT NULL AND length(trim(_ref_code)) > 0 THEN
    SELECT id INTO _referrer_org FROM public.organizations
     WHERE lower(referral_code) = lower(trim(_ref_code)) AND id <> _org_id
       AND deleted_at IS NULL;

    UPDATE public.organizations
       SET signup_ref_code = trim(_ref_code),
           signup_utm = _utm,
           referred_by_org_id = _referrer_org,
           updated_at = now()
     WHERE id = _org_id;

    IF _referrer_org IS NOT NULL THEN
      SELECT email INTO _new_email FROM auth.users WHERE id = _uid;

      IF EXISTS (
        SELECT 1 FROM public.user_roles ur JOIN auth.users u ON u.id = ur.user_id
        WHERE ur.organization_id = _referrer_org AND lower(u.email) = lower(_new_email)
      ) THEN
        _flag_reason := 'Self-referral suspected: signup email belongs to the referring business';
      END IF;

      SELECT volume_flag_threshold INTO _threshold FROM public.platform_referral_settings LIMIT 1;
      SELECT count(*) INTO _recent_count FROM public.tenant_referrals
       WHERE referrer_org_id = _referrer_org AND created_at > now() - interval '30 days';
      IF _flag_reason IS NULL AND (_recent_count + 1) >= COALESCE(_threshold, 5) THEN
        _flag_reason := 'High referral volume from this tenant in the last 30 days (' || (_recent_count + 1)::text || '): review for fraud';
      END IF;

      INSERT INTO public.tenant_referrals (referrer_org_id, referred_org_id, code_used, flagged, flag_reason)
      VALUES (_referrer_org, _org_id, trim(_ref_code), _flag_reason IS NOT NULL, _flag_reason);
    END IF;
  ELSIF _utm IS NOT NULL THEN
    UPDATE public.organizations SET signup_utm = _utm, updated_at = now() WHERE id = _org_id;
  END IF;

  RETURN _org_id;
END;
$function$;

-- Finding 6: don't let a trial (plan_status='active' but billing_status
-- 'trialing') convert a referral before any real payment. billing_status
-- carries Stripe's actual status; require it to be truly active.
CREATE OR REPLACE FUNCTION public.tg_org_referral_conversion()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  _settings record;
  _payment_cents integer;
BEGIN
  IF NEW.plan_status = 'active'
     AND NEW.billing_status = 'active'
     AND (OLD.plan_status IS DISTINCT FROM NEW.plan_status OR OLD.billing_status IS DISTINCT FROM NEW.billing_status)
     AND NEW.stripe_subscription_id IS NOT NULL THEN

    SELECT reward_percent, holding_days INTO _settings
      FROM public.platform_referral_settings LIMIT 1;

    SELECT COALESCE(p.price_cents, 0)
           + GREATEST(0, COALESCE(NEW.active_seat_count, 1) - COALESCE(p.included_seats, 1))
             * COALESCE(p.price_per_seat_cents, 0)
      INTO _payment_cents
      FROM public.platform_plans p WHERE p.id = NEW.plan_id;

    UPDATE public.tenant_referrals tr
       SET status = 'converted',
           converted_at = now(),
           first_payment_cents = COALESCE(_payment_cents, 0),
           reward_percent = COALESCE(_settings.reward_percent, 20),
           reward_cents = round(COALESCE(_payment_cents, 0) * COALESCE(_settings.reward_percent, 20) / 100.0)::int,
           eligible_at = now() + make_interval(days => COALESCE(_settings.holding_days, 45)),
           updated_at = now()
     WHERE tr.referred_org_id = NEW.id AND tr.status = 'pending';
  END IF;
  RETURN NEW;
END;
$fn$;

-- The conversion trigger must also fire on billing_status transitions now.
DROP TRIGGER IF EXISTS org_referral_conversion ON public.organizations;
CREATE TRIGGER org_referral_conversion
  AFTER UPDATE OF plan_status, billing_status ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.tg_org_referral_conversion();

-- Finding 8: the table-level SELECT policy exposed admin-only columns
-- (first_payment_cents, flag_reason, paid_note) to every member of the
-- referring org via direct PostgREST. The get_my_tenant_referrals RPC already
-- provides the tenant-safe projection; drop the broad policy.
DROP POLICY "referrer reads own referrals" ON public.tenant_referrals;
