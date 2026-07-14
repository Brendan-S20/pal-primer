-- New Features 1 + 2: dedicated /sign-up path with attribution capture, and
-- the tenant-to-tenant referral program (Phase 1: tracking, conversion
-- detection, reward calculation, manual payout bookkeeping).

-- ── Attribution columns on organizations ────────────────────────────────────
ALTER TABLE public.organizations
  ADD COLUMN referral_code text,
  ADD COLUMN referred_by_org_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  ADD COLUMN signup_ref_code text,
  ADD COLUMN signup_utm jsonb;

-- Codes are matched case-insensitively.
CREATE UNIQUE INDEX organizations_referral_code_key
  ON public.organizations (lower(referral_code)) WHERE referral_code IS NOT NULL;

-- ── Referral ledger ──────────────────────────────────────────────────────────
-- One row per referred org, written at signup (the only moment attribution can
-- be captured reliably). status: pending → converted (auto, on first paid
-- subscription) → paid (manual, Platform Admin marks payout done) | rejected.
-- "Eligible for payout" is derived: converted + eligible_at reached + not flagged.
CREATE TABLE public.tenant_referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  referred_org_id uuid NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  code_used text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','converted','paid','rejected')),
  flagged boolean NOT NULL DEFAULT false,
  flag_reason text,
  converted_at timestamptz,
  first_payment_cents integer,
  reward_percent numeric,
  reward_cents integer,
  eligible_at timestamptz,
  paid_at timestamptz,
  paid_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_referrals_referrer_idx ON public.tenant_referrals (referrer_org_id);

ALTER TABLE public.tenant_referrals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "platform admins manage tenant referrals"
  ON public.tenant_referrals FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

-- Referrers may watch their own referrals' progress (read-only).
CREATE POLICY "referrer reads own referrals"
  ON public.tenant_referrals FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), referrer_org_id));

-- ── Platform-level program settings (single row) ─────────────────────────────
CREATE TABLE public.platform_referral_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  reward_percent numeric NOT NULL DEFAULT 20,
  holding_days integer NOT NULL DEFAULT 45,
  volume_flag_threshold integer NOT NULL DEFAULT 5,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.platform_referral_settings (id) VALUES (true);

ALTER TABLE public.platform_referral_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "platform admins manage referral settings"
  ON public.platform_referral_settings FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

-- Tenants need the percentage to show "earn N%" on their Refer-a-business card.
CREATE POLICY "authenticated read referral settings"
  ON public.platform_referral_settings FOR SELECT TO authenticated USING (true);

-- ── Org referral code (lazy, collision-safe) ─────────────────────────────────
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

  SELECT referral_code INTO _code FROM public.organizations WHERE id = _org_id;
  IF _code IS NOT NULL THEN RETURN _code; END IF;

  LOOP
    _try := _try + 1;
    -- 8 chars, unambiguous alphabet (no 0/O/1/I)
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

-- ── bootstrap_organization: capture ref + UTM at org creation ────────────────
-- Replaces the 2-arg version (dropped so PostgREST named-arg dispatch stays
-- unambiguous; 2-arg callers resolve to this one via the defaults).
DROP FUNCTION IF EXISTS public.bootstrap_organization(text, text);

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

  INSERT INTO public.organizations(name) VALUES (_org_name) RETURNING id INTO _org_id;
  INSERT INTO public.user_roles(user_id, organization_id, role) VALUES (_uid, _org_id, 'owner');
  INSERT INTO public.staff(organization_id, user_id, role, display_name, active)
    VALUES (_org_id, _uid, 'owner', _display_name, true);

  -- Attribution: recorded only here, at creation time. Referral rows are
  -- flagged (not blocked) on abuse signals so a human reviews edge cases
  -- instead of the signup failing.
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

      -- Self-referral signal: the new owner's email already belongs to a
      -- member of the referring org.
      IF EXISTS (
        SELECT 1 FROM public.user_roles ur JOIN auth.users u ON u.id = ur.user_id
        WHERE ur.organization_id = _referrer_org AND lower(u.email) = lower(_new_email)
      ) THEN
        _flag_reason := 'Self-referral suspected: signup email belongs to the referring business';
      END IF;

      -- Volume signal: unusually many referrals from one tenant in 30 days.
      SELECT volume_flag_threshold INTO _threshold FROM public.platform_referral_settings LIMIT 1;
      SELECT count(*) INTO _recent_count FROM public.tenant_referrals
       WHERE referrer_org_id = _referrer_org AND created_at > now() - interval '30 days';
      IF _flag_reason IS NULL AND _recent_count >= COALESCE(_threshold, 5) THEN
        _flag_reason := 'High referral volume from this tenant in the last 30 days (' || (_recent_count + 1)::text || ') — review for fraud';
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

-- ── Conversion detection ─────────────────────────────────────────────────────
-- A referral converts when the referred org's subscription first transitions
-- to a paid active state — plan_status is the same field the entitlement gate
-- reads, so it is the source of truth for "now paying". Reward = configured
-- percentage of the first payment (estimated from the plan catalog: base price
-- + seat overage), held for holding_days before payout eligibility.
CREATE OR REPLACE FUNCTION public.tg_org_referral_conversion()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  _settings record;
  _payment_cents integer;
BEGIN
  IF NEW.plan_status = 'active'
     AND (OLD.plan_status IS DISTINCT FROM NEW.plan_status)
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

CREATE TRIGGER org_referral_conversion
  AFTER UPDATE OF plan_status ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.tg_org_referral_conversion();
