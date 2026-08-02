-- BUILD-6: the franchise collects the money and carries the HoundStack bill.
-- Owner decisions, 2026-07-30.
--
--   1. A location's customers pay into the PARENT's Stripe account. The parent
--      keeps the royalty and remits the rest to the franchisee.
--   2. HoundStack bills the PARENT for all locations on one invoice. A location
--      never sees a plan picker or a HoundStack bill.
--
-- Two flags rather than inferring both from parent_organization_id, because
-- they are genuinely separable: an acquired operator already collecting into
-- their own Stripe may keep doing so while still being billed through the
-- franchise. Forcing them to move payment processing on day one of an
-- acquisition would break live autopay for their existing customers.
--
-- Both are protected columns (BUG-19). Whose account collects a location's
-- money, and who pays for it, are exactly the kind of facts one side must not
-- be able to set unilaterally. Verified in an isolated transaction: a tenant
-- writing either column directly is blocked.
--
-- A NOTE ON THE ESCAPE HATCH, learned the hard way while testing this.
-- set_config('app.allow_protected_org_write', '1', true) is TRANSACTION-local,
-- not statement-local. Once any sanctioned function opens it, every later write
-- in that same transaction bypasses the trigger. In the app that is harmless —
-- each server function is its own transaction — but a multi-step SQL test in
-- one transaction will show the protection "failing" when it is not. Test
-- protection in its own transaction or the result is meaningless.
--
-- Idempotent.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS payments_collected_by_parent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS billed_through_parent boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.organizations.payments_collected_by_parent IS
  'BUILD-6: when true, this location''s customer charges are made on the PARENT franchise''s Stripe Connect account rather than its own. The parent is then merchant of record for those charges and owes the location its share. Resolved in resolveOrgStripeAccount().';

COMMENT ON COLUMN public.organizations.billed_through_parent IS
  'BUILD-6: when true, HoundStack invoices the parent franchise for this location instead of the location itself. The location has no plan of its own to manage and must not be dunned or suspended for non-payment — that is the parent''s account standing, not theirs.';

-- Add both to the protected set.
CREATE OR REPLACE FUNCTION public.tg_orgs_protect_platform_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
    OR NEW.billed_through_parent        IS DISTINCT FROM OLD.billed_through_parent THEN
      RAISE EXCEPTION 'These account fields can only be changed by the platform.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- The parent decides, per location, whether it collects that location's money.
CREATE OR REPLACE FUNCTION public.set_location_payment_routing(
  _child_org_id uuid,
  _collected_by_parent boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _parent uuid;
  _parent_acct text;
  _charges_ok boolean;
BEGIN
  SELECT parent_organization_id INTO _parent
    FROM public.organizations WHERE id = _child_org_id;
  IF _parent IS NULL THEN
    RAISE EXCEPTION 'That organization is not part of a franchise.';
  END IF;
  IF NOT public.has_role(auth.uid(), _parent, 'owner'::public.app_role) THEN
    RAISE EXCEPTION 'Only the franchise owner can change how a location collects payment.';
  END IF;

  -- Refuse to point a location at an account that cannot actually charge.
  -- Silently routing a live location's customers at a half-onboarded Stripe
  -- account would fail every payment attempt with no obvious cause.
  IF _collected_by_parent THEN
    SELECT stripe_connect_account_id, stripe_connect_charges_enabled
      INTO _parent_acct, _charges_ok
      FROM public.organizations WHERE id = _parent;
    IF _parent_acct IS NULL THEN
      RAISE EXCEPTION 'Connect the franchise''s own Stripe account first — locations cannot collect into an account that does not exist.';
    END IF;
    IF NOT coalesce(_charges_ok, false) THEN
      RAISE EXCEPTION 'The franchise''s Stripe account cannot accept charges yet. Finish Stripe onboarding before routing a location to it.';
    END IF;
  END IF;

  PERFORM set_config('app.allow_protected_org_write', '1', true);
  UPDATE public.organizations
     SET payments_collected_by_parent = _collected_by_parent
   WHERE id = _child_org_id;
END;
$$;

COMMENT ON FUNCTION public.set_location_payment_routing(uuid, boolean) IS
  'BUILD-6: the franchise owner chooses whether a location''s customer charges are collected into the franchise''s Stripe account. Refuses if the parent has no charge-ready account, because routing live customers at a broken account fails every payment with no visible cause.';

REVOKE ALL ON FUNCTION public.set_location_payment_routing(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_location_payment_routing(uuid, boolean) TO authenticated, service_role;
