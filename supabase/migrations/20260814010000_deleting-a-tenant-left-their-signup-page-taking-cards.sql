-- Soft-deleting a tenant stopped them receiving a free lead and left their
-- signup page able to charge a homeowner's card.
--
-- ── HOW IT WAS FOUND ──────────────────────────────────────────────────────
--
-- Walking the six SECURITY DEFINER functions that `anon` may execute, since
-- those are the whole unauthenticated, RLS-bypassing surface of the product.
-- All six pin `search_path`, all six return narrow explicit column lists, and
-- five of the six gate on something. The interesting part was WHICH gates.
--
-- ── WHAT `deleted_at` MEANT, IN PRACTICE ──────────────────────────────────
--
-- `softDeleteTenant` is the only delete the platform has, and there is no
-- undelete. It patches exactly one column:
--
--     const patch = { deleted_at: new Date().toISOString() };
--
-- It does not touch `plan_status`, which stays `active`, and it does not touch
-- `public_signup_enabled`, which stays true.
--
-- Before this migration `deleted_at` was honoured in exactly two kinds of
-- place: nine platform-side reporting reads in `src/` (metrics, overview,
-- referrals, onboarding, signup codes), and ONE database function —
-- `org_accepts_public_leads`, the predicate on the anon INSERT policy for
-- `leads`. So a deleted tenant vanished from every admin report and could not
-- receive a lead.
--
-- Nothing on the money path looked at it at all:
--
--   public_get_org_by_slug        gated on public_signup_enabled only
--   public_quote                  gated on public_signup_enabled only
--   org_can_add_client            gated on plan_status only
--
-- which is the whole chain behind `createSignupPaymentIntent`. For a deleted
-- tenant every link still said yes: the page rendered with their name and
-- logo, the quote priced the yard, the entitlement gate passed on
-- `plan_status = 'active'`, a `signup_requests` row was written, and a
-- PaymentIntent was created against their still-connected Stripe account with
-- our 50bps application fee on it.
--
-- Stated at its sharpest: the free thing was gated and the paid thing was not.
-- A member of the public could hand a card to a business the platform had
-- deleted, and the platform would take its cut of the charge.
--
-- ── SEVERITY, HONESTLY ────────────────────────────────────────────────────
--
-- Latent, not live. `select count(*) from organizations where deleted_at is
-- not null` is 0 — no tenant has ever been soft-deleted, so nobody has been
-- charged this way and this migration changes the answer for zero existing
-- rows. It is a loaded gun rather than a fired one, and the trigger is a
-- support action a platform admin can take on any evening.
--
-- ── WHY ALL FOUR, RATHER THAN THE ONE THAT STOPS THE CHARGE ───────────────
--
-- Closing `public_quote` alone would do it, because `createSignupPaymentIntent`
-- calls it first and throws when it returns nothing. The others are not
-- decoration:
--
--   * `public_get_org_by_slug` — without it the signup page still renders the
--     deleted business's name, logo and brand colour, and only fails at the
--     quote. A dead end dressed as a live storefront.
--
--   * `public_get_org_for_lead_form` — the lead INSERT is already blocked by
--     the policy, so this one is not a hole. But the endpoint resolves the org
--     through it and then inserts, so the block arrives as an RLS error and
--     `/api/public/leads` returns 500 with a Postgres message. With the filter
--     the org does not resolve and the caller gets the 404 "Unknown business"
--     that was always meant for this case. Matching its sibling also removes
--     the question of why two functions that answer the same question about
--     the same org disagreed about whether it exists.
--
--   * `org_can_add_client` — the one that matters if a tenant is deleted
--     BETWEEN the PaymentIntent and the webhook. `provisionSignup` runs in the
--     webhook and inserts the client there; the gate in front of the card is
--     a different moment from the insert behind it. This is the layer that
--     makes "deleted" mean "no new clients" by every path, including the
--     `tg_clients_enforce_plan_limit` trigger that calls it.
--
-- ── AND THE TRIGGER'S MESSAGE, WHICH WOULD HAVE LIED ──────────────────────
--
-- `tg_clients_enforce_plan_limit` explains a refusal by re-reading
-- `plan_status`. A deleted tenant's status is still `active`, so adding the
-- check to `org_can_add_client` without touching the trigger would have
-- produced "Your current plan status (active) doesn't allow adding customers.
-- Visit Settings → Billing to update your plan." — an error naming a healthy
-- plan, pointing at a page that cannot fix it. That is a support ticket
-- manufactured by an error message, so the trigger gets its own branch.

-- ── 1. the signup page ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.public_get_org_by_slug(_slug text)
RETURNS TABLE(id uuid, name text, currency text, public_signup_enabled boolean,
              resolved_slug text, logo_url text, brand_color text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id, o.name, o.currency, o.public_signup_enabled,
         COALESCE(o.portal_slug, o.slug), o.logo_url, o.brand_color
  FROM public.organizations o
  WHERE (o.portal_slug = _slug OR o.slug = _slug)
    AND o.public_signup_enabled = true
    AND o.deleted_at IS NULL
  ORDER BY (o.portal_slug = _slug) DESC NULLS LAST
  LIMIT 1;
$$;

-- ── 2. the quote, which is the gate the money actually passes through ─────
CREATE OR REPLACE FUNCTION public.public_quote(
  _slug text, _postal_code text, _dog_count integer, _frequency text)
RETURNS TABLE(organization_id uuid, zone_id uuid, zone_name text,
              base_price_cents integer, per_dog_addl_cents integer,
              recurring_price_cents integer, initial_cleanup_cents integer,
              currency text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org public.organizations;
  _zone public.zones;
  _mult numeric;
  _base_visit_cents integer;
  _recurring integer;
  _zip text := btrim(coalesce(_postal_code, ''));
BEGIN
  SELECT * INTO _org FROM public.organizations o
    WHERE (o.portal_slug = _slug OR o.slug = _slug)
      AND o.public_signup_enabled = true
      AND o.deleted_at IS NULL
    ORDER BY (o.portal_slug = _slug) DESC NULLS LAST
    LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT z.* INTO _zone FROM public.zones z
    WHERE z.organization_id = _org.id
      AND (_zip = ANY(z.zip_codes)
           OR (z.postal_prefix IS NOT NULL AND _zip LIKE z.postal_prefix || '%'))
    ORDER BY (CASE WHEN _zip = ANY(z.zip_codes) THEN 0 ELSE 1 END),
             z.priority DESC,
             (CASE WHEN z.account_type = 'residential' THEN 0
                   WHEN z.account_type IS NULL THEN 1
                   ELSE 2 END),
             length(coalesce(z.postal_prefix,'')) DESC,
             z.id
    LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  _mult := COALESCE((_org.frequency_multipliers ->> _frequency)::numeric, 1.0);
  _base_visit_cents := _zone.base_price_cents + GREATEST(_dog_count - 1, 0) * _zone.per_dog_addl_cents;
  _recurring := round(_base_visit_cents * _mult)::integer;

  organization_id := _org.id;
  zone_id := _zone.id;
  zone_name := _zone.name;
  base_price_cents := _base_visit_cents;
  per_dog_addl_cents := _zone.per_dog_addl_cents;
  recurring_price_cents := _recurring;
  initial_cleanup_cents := _zone.initial_cleanup_cents;
  currency := _org.currency;
  RETURN NEXT;
END;
$$;

-- ── 3. the lead form, so a blocked insert becomes a clean 404 ─────────────
-- NOTE the added parentheses. The original read `where o.portal_slug = _slug
-- or o.slug = _slug`, and AND binds tighter than OR, so appending the filter
-- without them would have produced
--     portal_slug = _slug OR (slug = _slug AND deleted_at IS NULL)
-- which leaves a deleted org matching on portal_slug — the exact case this is
-- for, silently still open.
CREATE OR REPLACE FUNCTION public.public_get_org_for_lead_form(_slug text)
RETURNS TABLE(id uuid, name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id, o.name
  FROM public.organizations o
  WHERE (o.portal_slug = _slug OR o.slug = _slug)
    AND o.deleted_at IS NULL
  ORDER BY (o.portal_slug = _slug) DESC NULLS LAST
  LIMIT 1;
$$;

-- ── 4. the entitlement gate, and the trigger that reports it ─────────────
-- `deleted_at` is the FIRST branch so it beats a plan_status the delete never
-- touched.
CREATE OR REPLACE FUNCTION public.org_can_add_client(_org_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_org_member(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN (
    SELECT CASE
      -- A closed account takes no new customers, whatever its plan says. The
      -- soft delete leaves plan_status alone, so without this a deleted tenant
      -- reads as 'active' here for ever.
      WHEN o.deleted_at IS NOT NULL THEN false
      WHEN o.plan_status IN ('active', 'past_due') THEN true
      WHEN o.plan_status = 'trialing' AND (o.trial_ends_at IS NULL OR o.trial_ends_at > now()) THEN true
      WHEN o.plan_status = 'free' THEN true
      -- Admin-granted grace window: lets a canceled/lapsed tenant keep working
      -- long enough to reach their own Billing settings and reactivate.
      WHEN o.grace_expires_at IS NOT NULL AND o.grace_expires_at > now() THEN true
      ELSE false
    END
    FROM public.organizations o WHERE o.id = _org_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.tg_clients_enforce_plan_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _ok boolean;
  _status text;
  _deleted boolean;
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.active)
     OR (TG_OP = 'UPDATE' AND NEW.active AND NOT OLD.active) THEN
    SELECT public.org_can_add_client(NEW.organization_id) INTO _ok;
    IF NOT _ok THEN
      SELECT o.plan_status::text, (o.deleted_at IS NOT NULL)
        INTO _status, _deleted
        FROM public.organizations o WHERE o.id = NEW.organization_id;
      -- Checked FIRST, because a soft-deleted tenant's plan_status is
      -- untouched and usually still 'active'. Reporting the plan here would
      -- name a healthy plan and send them to a Billing page that cannot fix
      -- it.
      IF _deleted THEN
        RAISE EXCEPTION 'This business account has been closed, so no new customers can be added.'
          USING ERRCODE = 'check_violation';
      ELSIF _status = 'canceled' THEN
        RAISE EXCEPTION 'Your subscription is canceled. Reactivate a plan in Settings → Billing to keep adding customers.'
          USING ERRCODE = 'check_violation';
      ELSIF _status = 'trialing' THEN
        RAISE EXCEPTION 'Your free trial has ended. Choose a plan to keep adding customers.'
          USING ERRCODE = 'check_violation';
      ELSE
        RAISE EXCEPTION 'Your current plan status (%) doesn''t allow adding customers. Visit Settings → Billing to update your plan.', COALESCE(_status, 'unknown')
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.org_can_add_client(uuid) IS
  'True when the org may take on another client. Checks deleted_at FIRST — the '
  'soft delete leaves plan_status alone, so a closed account otherwise reads as '
  'active here for ever. Called by tg_clients_enforce_plan_limit and by the '
  'signup entitlement gate.';

-- Grants are unchanged by CREATE OR REPLACE, but restated so this file is a
-- complete statement of who may call these rather than something you have to
-- read an earlier migration to be sure about. 20260809180000 is the file that
-- established the anon surface deliberately.
GRANT EXECUTE ON FUNCTION public.public_get_org_by_slug(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.public_get_org_for_lead_form(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.public_quote(text, text, integer, text) TO anon, authenticated, service_role;

-- `org_can_add_client` is NOT part of the anonymous surface, and this REVOKE is
-- not ceremony: `tests/the-lockdown-that-only-held-for-the-functions-that-
-- existed-that-day.test.ts` failed this file until it was here, which is the
-- guard working. CREATE OR REPLACE of an existing function inherits its ACL, so
-- live was never exposed — but a signature change is a new object with a fresh
-- PUBLIC grant, and the two cannot be told apart from the text of a migration.
-- Requiring the REVOKE either way is why the rule holds. Verified against the
-- live database after applying: has_function_privilege('anon', …) is false.
REVOKE ALL ON FUNCTION public.org_can_add_client(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_can_add_client(uuid) TO authenticated, service_role;

-- `tg_clients_enforce_plan_limit` is a trigger function and must NOT be
-- callable as an RPC — see 20260810140000, which revoked exactly this class.
REVOKE ALL ON FUNCTION public.tg_clients_enforce_plan_limit() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tg_clients_enforce_plan_limit() FROM anon, authenticated;
