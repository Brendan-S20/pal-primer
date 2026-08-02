-- BUILD-6: the franchise owner's payment-routing SETUP screen — the read side,
-- plus the hole the screen exposed.
--
-- Owner: "The parent should be able to control the percentages, which stripe
-- accounts are attached to each child."
--
-- The WRITE side already exists and is reused unchanged:
--   set_child_royalty_percent(child, percent)          — 20260730190000
--   set_location_payment_routing(child, boolean)       — 20260730190000
--   set_chargeback_responsibility(child, mode)         — 20260730200000
--
-- All three were built with the money plumbing and have never been reachable
-- from the product: the behaviour was enforced by the charge funnel and the
-- settlement routine, and settable only by editing the database by hand. What
-- was missing was a way to SEE the current arrangement, because a parent is not
-- a member of its locations and every read of them under RLS comes back empty
-- — the same wall that made the whole franchise surface silently blank before
-- the BUILD-6 repair. Hence one new reader and no new writers.
--
-- ── BUG-22, found while wiring the screen up ───────────────────────────────
--
-- `chargeback_responsibility` was NOT in tg_orgs_protect_platform_columns.
-- Exactly the BUG-19 shape, reachable the same way: a LOCATION's own owner
-- could set their organization to 'franchise' and push every future chargeback
-- onto their parent, in a column record_franchise_adjustment reads to decide
-- who eats the loss. Nobody would notice until a dispute arrived and the money
-- came off the wrong balance sheet.
--
-- Adding it here is safe for the legitimate path: set_chargeback_responsibility
-- already opens app.allow_protected_org_write before its UPDATE, so the
-- franchise owner's route through the product is unaffected and only the direct
-- table write is closed.
--
-- Idempotent.

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
    OR NEW.billed_through_parent        IS DISTINCT FROM OLD.billed_through_parent
    -- BUG-22: decides who eats a chargeback. A location must not be able to
    -- move that onto its franchise.
    OR NEW.chargeback_responsibility IS DISTINCT FROM OLD.chargeback_responsibility THEN
      RAISE EXCEPTION 'These account fields can only be changed by the platform.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- The whole arrangement for every location, in one row each: what they owe,
-- who collects, who bears a reversal, and whether their own Stripe account is
-- actually usable. One call rather than four, because the screen's job is to
-- show these together — a routing decision made without seeing the royalty rate
-- and the account state next to it is a decision made blind.
CREATE OR REPLACE FUNCTION public.franchise_payment_routing()
RETURNS TABLE(
  child_organization_id uuid,
  child_name text,
  royalty_percent numeric,
  payments_collected_by_parent boolean,
  chargeback_responsibility text,
  child_account_id text,
  child_charges_enabled boolean
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _parent uuid;
BEGIN
  SELECT organization_id INTO _parent FROM public.user_roles
   WHERE user_id = auth.uid() LIMIT 1;
  IF _parent IS NULL THEN
    RAISE EXCEPTION 'No organization for this account.';
  END IF;
  -- Owner-only, matching the three setters. Routing decides whose bank account
  -- receives customer money; it is not an office-manager setting.
  IF NOT public.has_role(auth.uid(), _parent, 'owner'::public.app_role) THEN
    RAISE EXCEPTION 'Only the franchise owner can see payment routing.';
  END IF;

  RETURN QUERY
  SELECT o.id, o.name, coalesce(o.franchise_royalty_percent, 0),
         coalesce(o.payments_collected_by_parent, false),
         coalesce(o.chargeback_responsibility, 'location'),
         o.stripe_connect_account_id,
         coalesce(o.stripe_connect_charges_enabled, false)
  FROM public.organizations o
  WHERE o.parent_organization_id = _parent
  ORDER BY o.name;
END;
$$;

COMMENT ON FUNCTION public.franchise_payment_routing() IS
  'BUILD-6: how each location''s money is routed — royalty rate, who collects, who bears a chargeback, and the location''s own Stripe readiness. For the franchise owner''s setup screen. Owner-only; SECURITY DEFINER because a parent cannot read its locations under RLS.';

REVOKE ALL ON FUNCTION public.franchise_payment_routing() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.franchise_payment_routing() TO authenticated, service_role;
