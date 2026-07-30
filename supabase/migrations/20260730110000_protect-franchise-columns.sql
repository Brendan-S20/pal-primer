-- BUG-19: a tenant owner could enroll themselves into someone else's franchise,
-- and a franchisee could set their own royalty rate to zero.
--
-- tg_orgs_protect_platform_columns guards thirteen columns that only the
-- platform may change. Three franchise columns were never added to that list,
-- while the "Owners update own org" RLS policy lets an owner UPDATE their own
-- row. Via direct PostgREST — no UI needed — an owner could:
--
--   * SET parent_organization_id = '<any org uuid>' and unilaterally declare
--     themselves a child of an organization that never agreed to it. Today that
--     only feeds the nightly royalty cron; under a working BUILD-6 it is
--     self-enrollment into another tenant's rollup and books.
--   * SET is_franchise_parent = true, same shape.
--   * SET franchise_royalty_percent = 0 — a franchisee zeroing out the royalty
--     they owe their parent. That one is money, and it was reachable by anyone
--     who had read the schema.
--
-- No organization currently has a parent, a child, or a non-zero royalty
-- percent, so nothing legitimate is being taken away here.
--
-- WHAT THIS DELIBERATELY DOES NOT BREAK. setChildRoyaltyRate is the one product
-- path that writes franchise_royalty_percent. It is ALREADY broken — it reads
-- and writes the CHILD org through the caller's own RLS-bound client, and
-- "Members read own org" / "Owners update own org" both refuse, so the read
-- returns null and the function always throws "That location isn't part of your
-- franchise." Protecting the column therefore disables nothing that works. The
-- second half of this migration repairs it properly, reusing the escape hatch
-- the trigger already provides (set_config('app.allow_protected_org_write'))
-- rather than inventing a second mechanism.
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
    -- BUG-19: the franchise relationship is not a self-service field. Who your
    -- parent is, whether you are a parent, and what you owe them are all facts
    -- about a relationship BETWEEN two organizations — one of them cannot
    -- declare them alone.
    OR NEW.parent_organization_id IS DISTINCT FROM OLD.parent_organization_id
    OR NEW.is_franchise_parent    IS DISTINCT FROM OLD.is_franchise_parent
    OR NEW.franchise_royalty_percent IS DISTINCT FROM OLD.franchise_royalty_percent THEN
      RAISE EXCEPTION 'These account fields can only be changed by the platform.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ── Repairing setChildRoyaltyRate ───────────────────────────────────────────
--
-- A parent setting a child's royalty rate is inherently a CROSS-org write, and
-- the caller's own client can never do it — that is why the existing
-- implementation silently never worked. It belongs in a SECURITY DEFINER
-- function that does its own authorization, which is the same shape
-- franchise_rollup() already uses.
--
-- Authorization is deliberately stricter than the app layer's: owner of the
-- parent (not office_manager, matching manage_franchise being owner-only), AND
-- the child must genuinely point at the caller's org. Both are checked here
-- rather than trusted from the caller.

CREATE OR REPLACE FUNCTION public.set_child_royalty_percent(
  _child_org_id uuid,
  _percent numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _parent_org uuid;
BEGIN
  IF _percent IS NULL OR _percent < 0 OR _percent > 100 THEN
    RAISE EXCEPTION 'Royalty percent must be between 0 and 100.';
  END IF;

  SELECT parent_organization_id INTO _parent_org
  FROM public.organizations WHERE id = _child_org_id;

  IF _parent_org IS NULL THEN
    RAISE EXCEPTION 'That location is not part of any franchise.';
  END IF;

  -- The caller must own the PARENT. Checked against the parent we just read
  -- from the child's own row, so a caller cannot name a parent they prefer.
  IF NOT public.has_role(auth.uid(), _parent_org, 'owner'::public.app_role) THEN
    RAISE EXCEPTION 'Only the franchise parent''s owner can set a royalty rate.';
  END IF;

  -- Reuse the trigger's existing escape hatch rather than adding a second way
  -- to bypass it. Transaction-local (the `true` third argument), so it cannot
  -- leak into a later statement on a pooled connection.
  PERFORM set_config('app.allow_protected_org_write', '1', true);

  UPDATE public.organizations
     SET franchise_royalty_percent = _percent
   WHERE id = _child_org_id;
END;
$$;

COMMENT ON FUNCTION public.set_child_royalty_percent(uuid, numeric) IS
  'BUG-19: sets a franchise child''s royalty rate. Cross-org by nature, so it authorizes here (owner of the child''s actual parent) rather than relying on the caller''s RLS, which could never perform this write. Replaces the silently-broken client-side update in setChildRoyaltyRate.';

REVOKE ALL ON FUNCTION public.set_child_royalty_percent(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_child_royalty_percent(uuid, numeric) TO authenticated, service_role;
