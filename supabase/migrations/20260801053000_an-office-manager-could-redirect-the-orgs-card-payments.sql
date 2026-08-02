-- An office manager could redirect the organization's card payments, and
-- rewrite the revenue a franchise royalty is computed from.
--
-- Two separate holes, both proven live as an office_manager in a transaction
-- that rolled itself back:
--
--     rewrite_stripe_connect = ALLOWED  (acct now 'acct_ATTACKER')
--     rewrite_payment_status = ALLOWED  (status now 'pending')
--
-- ── 1. THE CONNECT COLUMNS WERE NOT PROTECTED ──────────────────────────────
--
-- tg_orgs_protect_platform_columns guards sixteen columns, including every
-- franchise one — parent_organization_id, franchise_royalty_percent,
-- payments_collected_by_parent, chargeback_responsibility. It does NOT guard
-- the four stripe_connect_* columns, and the organizations UPDATE policy is
-- has_permission(..., 'manage_settings') — owner AND office_manager.
--
-- resolveOrgStripeAccount (src/lib/stripe-connect.server.ts) reads
-- stripe_connect_account_id to decide which Connect account receives every
-- customer charge. So an office manager — not the owner — could point the
-- organization's collections at an account they control. Charging an arbitrary
-- acct_ id fails at Stripe, which bounds the damage to denial-of-service; but
-- pointing at a REAL connected account on this platform does not fail, and
-- that is the embezzlement case.
--
-- It also defeated the franchise routing guard. set_location_payment_routing
-- refuses to turn on parent collection unless the parent's account can accept
-- charges — and the parent could satisfy that check by writing
-- stripe_connect_charges_enabled = true on its own row, then route every
-- location's customer money into an unverified account.
--
-- The migration that widened the UPDATE policy to office managers wrote:
-- "Widening who may UPDATE the row does not widen which columns can be
-- written." That was true only of the sixteen columns already enumerated.
--
-- ── 2. PAYMENTS WERE WRITABLE BY THE PARTY BEING BILLED ────────────────────
--
-- `payments writable by billing managers` covered ALL commands under
-- has_permission(..., 'manage_client_billing') = owner and office_manager.
--
-- generate_franchise_settlements computes a location's royalty by summing
-- `payments` for the period. So a franchise LOCATION's office manager could
-- flip its own payments to a non-counted status and take the royalty base —
-- and therefore the royalty — to zero. The settlement function is correct and
-- SECURITY DEFINER; it reads a table the counterparty owns.
--
-- The blast radius is wider than the franchise: payments feed AR, the revenue
-- figures, and the CPA pack.
--
-- WHO ACTUALLY NEEDS TO WRITE payments:
--   INSERT — yes, from the app: invoices.functions.ts records a manual
--            payment (cash, cheque, terminal) on the caller's client.
--   UPDATE — no. Every status transition in the product is written by the
--            Stripe webhook through supabaseAdmin, which is service_role and
--            bypasses RLS entirely. Checked: the only .from("payments")
--            .update() call sites are in routes/api/public/hooks/stripe.ts.
--   DELETE — no. Nothing deletes a payment; a reversal is a new row.
--
-- So INSERT keeps its permission and UPDATE/DELETE lose theirs. A recorded
-- payment becomes an append-only fact for tenant users, which is what a
-- payment is.

-- ── 1 ──────────────────────────────────────────────────────────────────────
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
    -- NEW: where customer card money lands. Written by the Connect OAuth
    -- callback through service_role, never by a tenant user.
    OR NEW.stripe_connect_account_id     IS DISTINCT FROM OLD.stripe_connect_account_id
    OR NEW.stripe_connect_charges_enabled IS DISTINCT FROM OLD.stripe_connect_charges_enabled
    OR NEW.stripe_connect_status         IS DISTINCT FROM OLD.stripe_connect_status
    OR NEW.stripe_connect_connected_at   IS DISTINCT FROM OLD.stripe_connect_connected_at THEN
      RAISE EXCEPTION 'These account fields can only be changed by the platform.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- ── 2 ──────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "payments writable by billing managers" ON public.payments;

CREATE POLICY "payments recorded by billing managers"
  ON public.payments
  FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), organization_id, 'manage_client_billing'));

DO $$
DECLARE _cmds text;
BEGIN
  SELECT string_agg(DISTINCT polcmd::text, ',' ORDER BY polcmd::text) INTO _cmds
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relname = 'payments';
  -- 'r' = SELECT, 'a' = INSERT. No 'w' (UPDATE) and no 'd' (DELETE): the
  -- Stripe webhook writes those as service_role, which bypasses RLS.
  IF _cmds IS DISTINCT FROM 'a,r' THEN
    RAISE EXCEPTION 'expected exactly SELECT and INSERT policies on payments, found: %', _cmds;
  END IF;
  IF (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.payments'::regclass) THEN
    RAISE EXCEPTION 'FORCE ROW LEVEL SECURITY would block the Stripe webhook';
  END IF;
END $$;
