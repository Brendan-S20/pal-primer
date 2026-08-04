-- Demo Pet Waste Co is the account the product is sold from: the sandbox a
-- prospect is dropped into, the org every marketing screenshot is captured
-- against. It needs every plan feature and every add-on, and it must never be
-- billed, dunned or suspended.
--
-- ── WHY THIS NEEDS A COLUMN AND NOT JUST A ROW UPDATE ─────────────────────
--
-- The obvious move is to attach the top plan, insert the add-on rows and stop.
-- That would put $126/month of add-on revenue into platform MRR that nobody
-- pays. `addonMonthlyEquivalentCents` counts every org_platform_addons row with
-- status='active' whenever the org is in a paying status, and Demo is
-- billing_status='active'. The plan side happens to escape — `enterprise` has
-- price_cents NULL, which monthlyEquivalentCents already reads as
-- "negotiated off-catalog, cannot be derived" and returns 0 for — but that is
-- luck, not a rule, and it stops being true the moment anyone prices the tier.
--
-- BUG-11 was this defect in the other direction: add-ons were not counted, and
-- the console reported $449 for a tenant paying $527. Understating and
-- overstating are the same bug. A metric that includes free accounts is not a
-- revenue metric.
--
-- Flipping billing_status to 'free' would also zero the MRR, and it is the
-- wrong answer: 'free' is the freemium client-count tier, it gates client
-- creation at 3 and drives the "convert" funnel on the platform overview. Demo
-- is not a prospect who hasn't paid. It is an account we decided not to charge.
-- Those are different facts and they need different fields.
--
-- So: `is_comped`. One column, one meaning — "uses the product by our decision,
-- is not revenue" — and it generalizes past this org to design partners and
-- internal accounts without another special case.
--
-- ── WHAT IT DELIBERATELY DOES NOT CHANGE ──────────────────────────────────
--
-- Entitlements. Those resolve from the plan slug (`planTierFromSlug`), so Demo
-- gets everything by being on `enterprise` — the same code path a real
-- Enterprise customer runs. A comped org that took a special branch through the
-- entitlement checks would be a demo of software nobody else is running.
--
-- Tenant counts, churn and cohort figures also still include Demo. It IS an
-- active organization; only the money is untrue.
--
-- ── LIMITATION, STATED ────────────────────────────────────────────────────
--
-- "Every add-on" is granted as rows, one per add-on that exists TODAY. A
-- seventh add-on added next month will not appear here on its own. The
-- alternative — teaching every add-on check to say yes for comped orgs — spreads
-- this decision across the codebase and hides it; rows keep it in one place and
-- visible in the same table everyone else's add-ons live in. Grant new ones the
-- same way.

-- ── 1. THE COLUMN ─────────────────────────────────────────────────────────
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS is_comped boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.organizations.is_comped IS
  'Platform-granted free use. Excluded from MRR/ARR; entitlements are unaffected and still resolve from plan_id. Set only by the platform — see tg_orgs_protect_platform_columns.';

-- ── 2. TENANTS CANNOT COMP THEMSELVES ─────────────────────────────────────
-- Without this an owner could UPDATE their own organizations row and stop
-- appearing in revenue while keeping every feature. It belongs in the same
-- guard as plan_id and billing_status, for exactly the same reason.
CREATE OR REPLACE FUNCTION public.tg_orgs_protect_platform_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
    OR NEW.ai_receptionist_enabled IS DISTINCT FROM OLD.ai_receptionist_enabled
    OR NEW.parent_organization_id IS DISTINCT FROM OLD.parent_organization_id
    OR NEW.is_franchise_parent    IS DISTINCT FROM OLD.is_franchise_parent
    OR NEW.franchise_royalty_percent IS DISTINCT FROM OLD.franchise_royalty_percent
    OR NEW.payments_collected_by_parent IS DISTINCT FROM OLD.payments_collected_by_parent
    OR NEW.billed_through_parent        IS DISTINCT FROM OLD.billed_through_parent
    OR NEW.chargeback_responsibility IS DISTINCT FROM OLD.chargeback_responsibility
    OR NEW.stripe_connect_account_id     IS DISTINCT FROM OLD.stripe_connect_account_id
    OR NEW.stripe_connect_charges_enabled IS DISTINCT FROM OLD.stripe_connect_charges_enabled
    OR NEW.stripe_connect_status         IS DISTINCT FROM OLD.stripe_connect_status
    OR NEW.stripe_connect_connected_at   IS DISTINCT FROM OLD.stripe_connect_connected_at
    -- Whether a card surcharge is lawful here. Tenant-editable would mean a
    -- Massachusetts business could type "TX" and surcharge illegally.
    OR NEW.stripe_merchant_region        IS DISTINCT FROM OLD.stripe_merchant_region
    -- NEW: free use is a platform decision, never a self-service one.
    OR NEW.is_comped                     IS DISTINCT FROM OLD.is_comped THEN
      RAISE EXCEPTION 'These account fields can only be changed by the platform.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- ── 3. COMP THE DEMO ORG ──────────────────────────────────────────────────
-- Keyed on the slug, not a hardcoded UUID: the id is environment-specific and a
-- migration that names one is a migration that silently does nothing anywhere
-- else. The write goes through the escape hatch the guard above provides,
-- because a migration runs as postgres and auth.role() is null here, not
-- 'service_role'.
DO $$
DECLARE
  _demo uuid;
  _enterprise uuid;
BEGIN
  SELECT id INTO _demo FROM public.organizations WHERE slug = 'demo' AND deleted_at IS NULL;
  IF _demo IS NULL THEN
    RAISE NOTICE 'no organization with slug=demo; nothing to comp';
    RETURN;
  END IF;

  SELECT id INTO _enterprise FROM public.platform_plans WHERE slug = 'enterprise';
  IF _enterprise IS NULL THEN
    RAISE EXCEPTION 'platform_plans has no enterprise row — the demo cannot be given every feature';
  END IF;

  PERFORM set_config('app.allow_protected_org_write', '1', true);

  UPDATE public.organizations SET
    is_comped = true,
    -- Enterprise, because that is the only tier holding franchise_structure
    -- (see PLAN_ENTITLEMENTS) and the demo has a franchise. price_cents is NULL
    -- on this tier, so it contributes nothing to MRR even before is_comped.
    plan_id = _enterprise,
    billing_status = 'active',
    plan_status = 'active',
    is_franchise_parent = true,
    -- The one add-on below that has a feature-flag column of its own. Granting
    -- the row without the flag would list the add-on as active in Settings
    -- while the feature stayed off — the exact "claimed vs actual" split this
    -- repo keeps finding.
    ai_receptionist_enabled = true,
    -- No Stripe customer and no subscription, on purpose. There is nothing to
    -- charge, so there is nothing to dun, fail, or suspend for.
    stripe_customer_id = NULL,
    stripe_subscription_id = NULL,
    trial_ends_at = NULL,
    grace_expires_at = NULL,
    suspended_at = NULL,
    suspended_reason = NULL
  WHERE id = _demo;

  -- Every add-on that exists, active, with no Stripe subscription item — the
  -- shape a comped grant has to take, since there is no subscription to hang an
  -- item on. cancelAddon already guards on the item being present, so the
  -- Remove button behaves for these rows too.
  INSERT INTO public.org_platform_addons (organization_id, addon_id, status, stripe_subscription_item_id)
  SELECT _demo, a.id, 'active', NULL
  FROM public.platform_addons a
  ON CONFLICT (organization_id, addon_id) DO UPDATE
    SET status = 'active', canceled_at = NULL;

  PERFORM set_config('app.allow_protected_org_write', '', true);
END $$;
