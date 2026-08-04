-- `organizations.billed_through_parent` is dropped.
--
-- ── WHAT IT CLAIMED ───────────────────────────────────────────────────────
--
-- Its own comment:
--
--   "BUILD-6: when true, HoundStack invoices the parent franchise for this
--    location instead of the location itself. The location has no plan of its
--    own to manage and must not be dunned or suspended for non-payment — that
--    is the parent's account standing, not theirs."
--
-- That is a specific, checkable promise about billing, dunning and suspension.
-- Nothing implements any part of it.
--
-- ── WHAT WAS ACTUALLY THERE ───────────────────────────────────────────────
--
--   * No reader. `grep billed_through_parent src/` finds nothing outside the
--     generated types file.
--   * No writer. There is no setting, no admin control, no provisioning path.
--     Every row in the database is false and always has been.
--   * Its SIBLING from the same migration, `payments_collected_by_parent`, is
--     fully wired — resolveOrgStripeAccount, the CPA pack, franchise routing —
--     which is what makes this one easy to read as working too. Two columns
--     added together, one built, one not, and only the comments to tell them
--     apart.
--
-- A location provisioned by `provision_franchise_location` gets its own plan
-- and is billed and dunned in its own right, exactly as the comment says it
-- must not be. So the column does not merely do nothing: it describes the
-- OPPOSITE of the system's actual behaviour, in the schema, where the next
-- person to design franchise billing will read it and believe it.
--
-- ── WHY DROP RATHER THAN IMPLEMENT ────────────────────────────────────────
--
-- Consolidated parent billing is a feature — one plan on the parent, seat and
-- location rollup, one invoice, dunning that suspends a whole franchise — not
-- a flag someone forgot to check. Building it during a cleanup pass would be
-- inventing a billing model nobody has specified. Leaving the column is worse
-- than either: it is a false claim with a `NOT NULL DEFAULT false` next to it,
-- which reads like a working control that simply nobody has turned on.
--
-- Dropping is safe and reversible: zero rows have ever been true, so nothing
-- is lost, and if consolidated billing is built the column comes back WITH its
-- implementation, which is the only time it should have existed.

ALTER TABLE public.organizations DROP COLUMN IF EXISTS billed_through_parent;

-- Out of the protected set too, or the trigger references a column that no
-- longer exists and every organizations UPDATE fails.
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
    OR NEW.chargeback_responsibility IS DISTINCT FROM OLD.chargeback_responsibility
    OR NEW.stripe_connect_account_id     IS DISTINCT FROM OLD.stripe_connect_account_id
    OR NEW.stripe_connect_charges_enabled IS DISTINCT FROM OLD.stripe_connect_charges_enabled
    OR NEW.stripe_connect_status         IS DISTINCT FROM OLD.stripe_connect_status
    OR NEW.stripe_connect_connected_at   IS DISTINCT FROM OLD.stripe_connect_connected_at
    -- Whether a card surcharge is lawful here. Tenant-editable would mean a
    -- Massachusetts business could type "TX" and surcharge illegally.
    OR NEW.stripe_merchant_region        IS DISTINCT FROM OLD.stripe_merchant_region
    -- Free use is a platform decision, never a self-service one.
    OR NEW.is_comped                     IS DISTINCT FROM OLD.is_comped THEN
      RAISE EXCEPTION 'These account fields can only be changed by the platform.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
