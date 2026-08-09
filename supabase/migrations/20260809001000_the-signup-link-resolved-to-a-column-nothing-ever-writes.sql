-- The public homeowner signup flow at /signup/{slug} has never been reachable
-- by a tenant who did not have a row hand-edited by us, and the same defect is
-- silently answering the phone wrong today.
--
-- ── TWO GATES, ONE OF WHICH NOTHING EVER OPENS ────────────────────────────
--
-- `public_get_org_by_slug` and `public_quote` both resolve the tenant with
--
--     WHERE slug = _slug AND public_signup_enabled = true
--
-- which is two gates, not one. `public_signup_enabled` has a settings surface
-- now and an owner can turn it on. `organizations.slug` does not: it is
-- nullable, and `bootstrap_organization` — the ONLY path that creates a tenant
-- — inserts (name, plan_status, billing_status, trial_ends_at) and nothing
-- else. Verified against the live database before writing this: the function
-- body contains no assignment to `slug`, and the only three organizations that
-- carry one are the seeded demo tenants, whose slugs were written by hand.
--
-- So for every tenant that has ever signed itself up, `slug` is NULL, the
-- comparison is NULL = 'whatever' → NULL, no row is returned, and
-- /signup/{anything} renders "This company isn't taking online signups right
-- now." An owner who finds the toggle, turns it on, and pastes the link into
-- their website gets exactly the same page they got before. There is no error
-- anywhere: a filter that matches nothing is a successful filter.
--
-- Meanwhile `portal_slug` is the column the product actually maintains. Every
-- tenant has one or can mint one from Settings → Preferences, `ensureOrgSlug`
-- backfills it, and the portal and lead form are both addressed by it.
--
-- This is the third time this shape has been fixed. 20260711120000 hit it on
-- the lead form and introduced `public_get_org_for_lead_form`, resolving
-- `portal_slug OR slug`. Its header says `public_get_org_by_slug` was "left
-- untouched for the signup flow, where the gate is correct" — and the
-- signup-enabled gate IS correct. The slug half was never the gate anybody
-- meant; it was a second, invisible one. This migration gives signup the same
-- resolution the lead form already has, and keeps the boolean gate that
-- distinguishes "collect a lead" from "take this person's card".
--
-- ── THE SAME NULL IS ANSWERING THE PHONE ──────────────────────────────────
--
-- This is not a dormant defect. `src/lib/ai-receptionist.server.ts` exposes a
-- `get_pricing_quote` tool that calls `public_quote` with the org's slug, and
-- both Twilio webhooks fill that in as `(org as any).slug ?? ""` — the voice
-- hook at routes/api/public/hooks/twilio-voice.ts and the SMS hook at
-- routes/api/public/hooks/twilio.ts. With `slug` NULL that argument is the
-- empty string, `public_quote` returns no rows, and the tool hands the model
-- `{ available: false, reason: "No service in that zip." }`.
--
-- The receptionist therefore tells EVERY caller, in every ZIP the tenant
-- actually serves, that the business does not serve them. It is confident,
-- immediate, and wrong, and it is the first impression of every inbound lead
-- the tenant paid to receive. Resolving on `portal_slug` fixes those two
-- callers with the rest.
--
-- ── BRANDING CARRIED BY THE LOOKUP ────────────────────────────────────────
--
-- `public_get_org_by_slug` returns the tenant's name and currency, so
-- /signup/{slug} rendered inside HoundStack's own marketing shell: HoundStack's
-- wordmark at the top, a link to houndstack.com in the footer. A tenant's
-- prospect, mid-purchase, was being shown their supplier's brand and offered a
-- link away to it. The lead form does not have this problem because
-- `getPublicLeadForm` reads `lead_form_config` for logo and colour. Signup has
-- no such config, so the org's own `logo_url` and `brand_color` are added to
-- this function's result — they are already public-safe (the portal shell shows
-- both to anyone holding a portal link) and this is the only lookup the signup
-- page gets to make.
--
-- Adding columns changes the return type, which CREATE OR REPLACE cannot do, so
-- this one is dropped and recreated. The grants are re-stated below because a
-- DROP takes them with it, and losing the `anon` grant would break the flow in
-- the same silent way — the anon client would get "permission denied for
-- function", surfaced to a prospect as the same unavailable page.
--
-- `resolved_slug` comes back too, so a caller can tell WHICH address answered
-- and build canonical links with it instead of echoing whatever was typed.
--
-- ── AND A PLACE TO RECORD THE MONEY GOING BACK ────────────────────────────
--
-- Once the flow is reachable it can take a card, and `provisionSignup` in the
-- Connect webhook can still fail after the charge settles — a seat limit, a
-- canceled plan, a constraint. Until now that path wrote status 'failed' and
-- kept the money, and the success page told the prospect "we got your payment,
-- but hit a snag" and nothing else. The webhook now refunds the charge in that
-- catch, and a refund that is not recorded is a refund the next redelivery
-- issues again, so `signup_requests` gains the three columns that make it
-- idempotent and make the page's apology accurate: which refund, when, and for
-- how much.
--
-- Nothing to repair: 0 signup_requests rows exist at all, so no historical
-- charge is stranded by this.

-- ── The version this was written against ──────────────────────────────────
DO $pre$
DECLARE _byslug text; _quote text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO _byslug
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'public_get_org_by_slug';
  IF _byslug IS NULL THEN
    RAISE EXCEPTION 'public_get_org_by_slug does not exist';
  END IF;
  IF _byslug LIKE '%portal_slug%' THEN
    RAISE EXCEPTION 'public_get_org_by_slug already resolves portal_slug — read it before replacing it';
  END IF;
  IF _byslug NOT LIKE '%o.slug = _slug AND o.public_signup_enabled = true%' THEN
    RAISE EXCEPTION 'not the version this migration was written against (public_get_org_by_slug)';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO _quote
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'public_quote';
  IF _quote IS NULL THEN
    RAISE EXCEPTION 'public_quote does not exist';
  END IF;
  IF _quote LIKE '%portal_slug%' THEN
    RAISE EXCEPTION 'public_quote already resolves portal_slug — read it before replacing it';
  END IF;
  IF _quote NOT LIKE '%WHERE slug = _slug AND public_signup_enabled = true%' THEN
    RAISE EXCEPTION 'not the version this migration was written against (public_quote)';
  END IF;
  -- The ZIP normalization from 20260717140000 must survive this rewrite; it is
  -- what makes the AI receptionist's untrimmed ZIP match a zone at all.
  IF _quote NOT LIKE '%btrim(coalesce(_postal_code%' THEN
    RAISE EXCEPTION 'public_quote has lost its ZIP normalization — reconcile before replacing';
  END IF;

  -- The premise of the whole migration. If a future bootstrap starts writing
  -- `slug`, the fix is still correct but the story above is not, and whoever
  -- reads it next deserves to be told.
  IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'bootstrap_organization') LIKE '%slug%' THEN
    RAISE WARNING 'bootstrap_organization now mentions slug — re-read this migration''s header, its premise may have changed';
  END IF;
END
$pre$;

-- ── Resolution, and the branding the page needs to not look like ours ─────
--
-- `portal_slug` first, `slug` second, and the ORDER BY makes that preference
-- deterministic rather than whatever the planner returns: one tenant's legacy
-- `slug` could equal another's `portal_slug`, and the address a tenant is
-- actually handed out today is the portal one.
DROP FUNCTION IF EXISTS public.public_get_org_by_slug(text);

CREATE FUNCTION public.public_get_org_by_slug(_slug text)
RETURNS TABLE (
  id uuid, name text, currency text, public_signup_enabled boolean,
  resolved_slug text, logo_url text, brand_color text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT o.id, o.name, o.currency, o.public_signup_enabled,
         COALESCE(o.portal_slug, o.slug), o.logo_url, o.brand_color
  FROM public.organizations o
  WHERE (o.portal_slug = _slug OR o.slug = _slug)
    AND o.public_signup_enabled = true
  ORDER BY (o.portal_slug = _slug) DESC NULLS LAST
  LIMIT 1;
$$;

-- Re-stated because DROP took them. anon is the caller that matters: the signup
-- page reads this from an anonymous Supabase client (signup.functions.ts), and
-- 20260731190000 lists this function among the five deliberately left public.
REVOKE ALL ON FUNCTION public.public_get_org_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_get_org_by_slug(text) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.public_get_org_by_slug(text) IS
  'Public signup lookup. Resolves portal_slug first, then the legacy slug, and still requires public_signup_enabled — that boolean is the tenant''s decision to sell online and is the only gate here that was ever meant to be one.';

-- ── The quote, resolving the same way ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.public_quote(
  _slug text, _postal_code text, _dog_count integer, _frequency text
)
RETURNS TABLE (
  organization_id uuid, zone_id uuid, zone_name text,
  base_price_cents integer, per_dog_addl_cents integer,
  recurring_price_cents integer, initial_cleanup_cents integer, currency text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org public.organizations;
  _zone public.zones;
  _mult numeric;
  _base_visit_cents integer;
  _recurring integer;
  _zip text := btrim(coalesce(_postal_code, ''));
BEGIN
  -- Same resolution and the same preference as public_get_org_by_slug above.
  -- SELECT INTO takes the first row whether or not you order it, so the ORDER
  -- BY is what stops "which tenant answers" from depending on the plan.
  SELECT * INTO _org FROM public.organizations o
    WHERE (o.portal_slug = _slug OR o.slug = _slug)
      AND o.public_signup_enabled = true
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

GRANT EXECUTE ON FUNCTION public.public_quote(text, text, integer, text) TO anon, authenticated, service_role;

-- ── Where a refunded signup is written down ───────────────────────────────
--
-- Three columns rather than a status value, because 'failed' still has to mean
-- "no account exists" for the office, and whether the money went back is a
-- separate fact from whether provisioning worked. `stripe_refund_id` is the
-- idempotency key in practice: the webhook checks it before calling Stripe, so
-- a redelivered payment_intent.succeeded cannot refund the same charge twice.
ALTER TABLE public.signup_requests
  ADD COLUMN IF NOT EXISTS stripe_refund_id text,
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz,
  ADD COLUMN IF NOT EXISTS refunded_amount_cents integer;

COMMENT ON COLUMN public.signup_requests.stripe_refund_id IS
  'Set when provisioning failed after the charge settled and the webhook refunded it. Non-null means the prospect''s money has been returned, and is what stops a webhook redelivery from refunding twice.';

DO $post$
DECLARE _byslug text; _quote text; _cols integer;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO _byslug
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'public_get_org_by_slug';
  IF _byslug NOT LIKE '%o.portal_slug = _slug OR o.slug = _slug%' THEN
    RAISE EXCEPTION 'public_get_org_by_slug still resolves slug only';
  END IF;
  IF _byslug NOT LIKE '%public_signup_enabled = true%' THEN
    RAISE EXCEPTION 'public_get_org_by_slug lost the signup gate — that one was correct';
  END IF;
  IF _byslug NOT LIKE '%brand_color%' THEN
    RAISE EXCEPTION 'public_get_org_by_slug does not return the tenant branding the signup page needs';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO _quote
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'public_quote';
  IF _quote NOT LIKE '%o.portal_slug = _slug OR o.slug = _slug%' THEN
    RAISE EXCEPTION 'public_quote still resolves slug only — the AI receptionist is still saying "no service" to everyone';
  END IF;
  IF _quote NOT LIKE '%public_signup_enabled = true%' THEN
    RAISE EXCEPTION 'public_quote lost the signup gate';
  END IF;
  IF _quote NOT LIKE '%btrim(coalesce(_postal_code%' THEN
    RAISE EXCEPTION 'public_quote lost its ZIP normalization';
  END IF;

  -- The anon grant is the difference between "reachable" and the same blank
  -- page by another route, so it is asserted rather than assumed.
  IF NOT has_function_privilege('anon', 'public.public_get_org_by_slug(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon cannot execute public_get_org_by_slug — the DROP took the grant with it';
  END IF;
  IF NOT has_function_privilege('anon', 'public.public_quote(text, text, integer, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon cannot execute public_quote';
  END IF;

  SELECT count(*) INTO _cols FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'signup_requests'
     AND column_name IN ('stripe_refund_id', 'refunded_at', 'refunded_amount_cents');
  IF _cols <> 3 THEN
    RAISE EXCEPTION 'signup_requests is missing the refund columns (% of 3)', _cols;
  END IF;
END
$post$;
