-- Pass-through processing fees: the tenant chooses whether they absorb Stripe's
-- cost of acceptance or hand it to the homeowner.
--
-- FOUR COLUMNS, AND THE REASONS THEY ARE SEPARATE COLUMNS
--
--   payment_fee_pass_through     the tenant's choice. Theirs to set, so it is
--                                deliberately NOT added to the platform-column
--                                guard below.
--
--   card_surcharge_attested_at   when the tenant confirmed they gave the card
--                                networks and their acquirer the 30 days'
--                                notice that Visa and Mastercard require before
--                                surcharging.
--
--                                This is a SECOND flag and not a second meaning
--                                for the first, because ACH needs no notice at
--                                all: a bank debit is not a card, so no network
--                                rule, no state ban, no registration. A tenant
--                                who flips pass-through on and never attests
--                                gets ACH pass-through and no card surcharge,
--                                which is the correct and legal default.
--
--                                Nullable on purpose. A boolean would record
--                                THAT they attested; the timestamp records WHEN,
--                                which is the part that matters if a network
--                                ever asks.
--
--   stripe_merchant_region       two-letter state of the connected account, as
--                                Stripe holds it. Surcharging is banned outright
--                                in CT, MA and PR, and we had nowhere to read a
--                                merchant's state from: `organizations` has no
--                                address, and never has. The connected account
--                                is the authoritative source — it is the address
--                                the merchant registered with their acquirer,
--                                which is the address the ban is written about.
--
--                                Platform-written, synced from `account.updated`,
--                                so it IS added to the guard: a tenant who could
--                                edit this could type "TX" from Boston and
--                                surcharge illegally.
--
--   payments.surcharge_cents     THE BUG THIS PREVENTS. Every reconcile path
--                                takes the charge amount as the amount paid
--                                toward the invoice — `markInvoicePaidFromStripe`
--                                is handed `pi.amount` directly, and the payments
--                                row stores `amount_cents = pi.amount`. Once a
--                                charge is base + surcharge those stop being the
--                                same number, and folding the surcharge in would
--                                credit an invoice more than it was owed AND
--                                report the fee recovery as revenue, in the
--                                dashboard, /reports, /analytics and the CPA
--                                pack alike.
--
--                                So `amount_cents` keeps meaning exactly one
--                                thing — money applied to the invoice — and the
--                                surcharge sits beside it. Defaulted to 0, so
--                                every existing row keeps the meaning it already
--                                had and no revenue figure moves.

-- ── 1 ── the tenant's choice, and their attestation ────────────────────────
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS payment_fee_pass_through BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS card_surcharge_attested_at TIMESTAMPTZ;

COMMENT ON COLUMN public.organizations.payment_fee_pass_through IS
  'Tenant''s choice: pass Stripe''s cost of acceptance to the payer. Gates ACH immediately; gates card only together with card_surcharge_attested_at.';

COMMENT ON COLUMN public.organizations.card_surcharge_attested_at IS
  'When the tenant confirmed they notified the card networks and their acquirer, as Visa/Mastercard require 30 days before surcharging. NULL = no card surcharge, whatever payment_fee_pass_through says.';

-- ── 2 ── where the merchant is, per Stripe ─────────────────────────────────
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS stripe_merchant_region TEXT;

COMMENT ON COLUMN public.organizations.stripe_merchant_region IS
  'Two-letter state/territory of the connected account, synced from account.updated. Surcharging is prohibited in CT, MA and PR. Platform-written: guarded below.';

-- ── 3 ── the surcharge is not revenue ──────────────────────────────────────
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS surcharge_cents INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.payments.surcharge_cents IS
  'Processing fee recovered from the payer, included in the Stripe charge but NOT in amount_cents. amount_cents remains money applied to the invoice, so every revenue figure is unchanged by surcharging.';

-- ── 4 ── guard the platform-written column ─────────────────────────────────
-- Unchanged from 20260801053000 except for the one new line, marked. Restated in
-- full rather than patched because CREATE OR REPLACE takes the whole body and a
-- partial edit here silently drops whichever guards were left out.
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
    -- NEW: whether a card surcharge is lawful here. Tenant-editable would mean
    -- a Massachusetts business could type "TX" and surcharge illegally.
    OR NEW.stripe_merchant_region        IS DISTINCT FROM OLD.stripe_merchant_region THEN
      RAISE EXCEPTION 'These account fields can only be changed by the platform.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- ── 5 ── assert the migration did what it says ─────────────────────────────
DO $$
DECLARE
  missing TEXT;
BEGIN
  SELECT string_agg(c, ', ') INTO missing FROM (
    SELECT 'organizations.' || c AS c FROM unnest(ARRAY[
      'payment_fee_pass_through', 'card_surcharge_attested_at', 'stripe_merchant_region'
    ]) AS c
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = c
    )
    UNION ALL
    SELECT 'payments.surcharge_cents'
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'payments' AND column_name = 'surcharge_cents'
    )
  ) q;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'pass-through migration incomplete, missing: %', missing;
  END IF;

  -- The guard must actually mention the new column, or it is decorative.
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'tg_orgs_protect_platform_columns')
     NOT LIKE '%stripe_merchant_region%' THEN
    RAISE EXCEPTION 'the platform-column guard does not protect stripe_merchant_region';
  END IF;
END $$;
