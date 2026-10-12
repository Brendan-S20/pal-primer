-- A stranger can see what is for sale: the service catalog, phase 5, the
-- public paths.
--
-- Phase 5 (20261011100000) taught public_quote to price a service, and
-- nothing public called it that way: the signup page, the lead form and the
-- AI receptionist all quoted the yard, because none of them could see the
-- business's services. `services` is read by members (RLS) and the
-- publishable key holds no privilege on it at all (20261009200000), which is
-- right, and it means a visitor on /signup/{slug} cannot ask "what does this
-- business sell?" This file gives them exactly that question and nothing
-- else, and gives a lead and a signup somewhere to write the answer.
--
-- ── 1. public_services(_slug) ────────────────────────────────────────────
--
-- What a prospective client needs to pick a service and be quoted for it: the
-- id, the name, the line, how it is priced, the base and extra-pet prices and
-- the usual duration. No organization internals: the function returns rows
-- of `services` columns and never a column of `organizations`. The id is
-- returned so the same visitor can hand it back to public_quote; the prices
-- are the ones public_quote will say out loud anyway.
--
-- Which services: ACTIVE, and either PRICED (base_price_cents set) or the
-- business's pet-waste service, which is priced by its zones and so carries a
-- NULL base on purpose. A service nobody has priced yet is not for sale
-- online: public_quote would answer it with NULL prices that nothing may
-- charge, so it is not offered in the first place. A deactivated one is not
-- for sale at all.
--
-- Which business: the same resolution as public_quote, line for line.
-- portal_slug or slug, public_signup_enabled, not deleted, portal_slug
-- preferred when both match. A business that only wants leads (switch off)
-- lists nothing here, exactly as it prices nothing through public_quote: the
-- two are one gate, and the picker on its page stays hidden.
--
-- Order: the Services page's order (by line, pet waste first, then by name),
-- so the picker reads the way the owner's own screen does.
--
-- SECURITY DEFINER and STABLE, like public_quote. The fresh object inherits
-- the schema's PUBLIC grant, so it is REVOKED from PUBLIC and then GRANTED to
-- anon, authenticated and service_role, in that order
-- (tests/the-lockdown-that-only-held-for-the-functions-that-existed-that-day
-- names it in the anon allowlist with its caller).
--
-- ── 2. leads.service_id and signup_requests.service_id ────────────────────
--
-- Nullable, ON DELETE SET NULL. NULL is every row before this file and every
-- row a business that sells one thing writes: the form shows no picker when
-- there is nothing to pick, so a pet-waste-only business's leads and signups
-- read exactly as they always did. When the business offers more than one
-- service the picked one is recorded, pet waste included, so the office sees
-- what was asked for rather than inferring it. The Stripe webhook copies
-- signup_requests.service_id onto the plan it provisions; absent, the plan
-- gets the business's default from tg_subscriptions_service, as today.
--
-- Partial indexes on both: the FK side needs one so a services row can be
-- checked without a scan, and NULL rows (the great majority) need no entry.
--
-- Replays into an empty database: one function over tables that exist, two
-- columns, two indexes. No row is needed and no number is asserted.

-- ── 1. The public list ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.public_services(_slug text)
RETURNS TABLE(
  id uuid,
  name text,
  service_line text,
  price_unit text,
  base_price_cents integer,
  extra_pet_cents integer,
  default_duration_min integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _org public.organizations;
BEGIN
  -- The same business public_quote would price for, resolved the same way.
  SELECT * INTO _org FROM public.organizations o
    WHERE (o.portal_slug = _slug OR o.slug = _slug)
      AND o.public_signup_enabled = true
      AND o.deleted_at IS NULL
    ORDER BY (o.portal_slug = _slug) DESC NULLS LAST
    LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY
    SELECT s.id, s.name, s.service_line, s.price_unit,
           s.base_price_cents, s.extra_pet_cents, s.default_duration_min::integer
      FROM public.services s
     WHERE s.organization_id = _org.id
       AND s.active
       AND (s.service_line = 'pet_waste' OR s.base_price_cents IS NOT NULL)
     ORDER BY array_position(ARRAY['pet_waste','dog_walking','pet_sitting','mobile_grooming','other'], s.service_line),
              lower(s.name),
              s.id;
END;
$$;

COMMENT ON FUNCTION public.public_services(text) IS
  'What a business sells, for a visitor who has no account: its active services that are priced, plus its zone-priced pet-waste service. Same slug resolution and the same gate (public_signup_enabled, not deleted) as public_quote. Anon-callable; returns no organization column. Migration 20261011150000.';

REVOKE ALL ON FUNCTION public.public_services(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_services(text) TO anon, authenticated, service_role;

-- ── 2. Where a lead and a signup write the answer ─────────────────────────

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS service_id uuid REFERENCES public.services(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.leads.service_id IS
  'The service the visitor asked about, when the business offers more than one. NULL for every lead before 20261011150000 and for a business that sells one thing.';
CREATE INDEX IF NOT EXISTS leads_service_id_idx ON public.leads (service_id)
  WHERE service_id IS NOT NULL;

ALTER TABLE public.signup_requests
  ADD COLUMN IF NOT EXISTS service_id uuid REFERENCES public.services(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.signup_requests.service_id IS
  'The service the visitor signed up for, when the business offers more than one; the webhook puts it on the plan. NULL: the business''s default service, as every signup before 20261011150000.';
CREATE INDEX IF NOT EXISTS signup_requests_service_id_idx ON public.signup_requests (service_id)
  WHERE service_id IS NOT NULL;

-- ── What this file establishes, checked from any starting state ───────────
DO $post$
DECLARE
  _args text;
  _ret text;
BEGIN
  IF to_regprocedure('public.public_services(text)') IS NULL THEN
    RAISE EXCEPTION 'public_services(text) was not created';
  END IF;
  IF NOT has_function_privilege('anon', 'public.public_services(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon lost EXECUTE on public_services; the signup page cannot list what is for sale';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.public_services(text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.public_services(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'public_services is not callable by the app roles';
  END IF;
  -- It takes a slug and nothing a caller could price with.
  _args := pg_get_function_arguments('public.public_services(text)'::regprocedure);
  IF _args ~* 'cents|price|org|uuid' THEN
    RAISE EXCEPTION 'public_services takes more than a slug: %', _args;
  END IF;
  -- And returns service columns only: no organization id, slug, key or setting.
  _ret := pg_get_function_result('public.public_services(text)'::regprocedure);
  IF _ret ~* 'organization|slug|stripe|key|email|phone|enabled|config' THEN
    RAISE EXCEPTION 'public_services returns an organization column: %', _ret;
  END IF;
  -- The table itself stays closed to the browser key: the function is the
  -- one door, and it says only what public_quote would say.
  IF has_table_privilege('anon', 'public.services', 'SELECT') THEN
    RAISE EXCEPTION 'anon can read public.services directly';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'service_id'
       AND is_nullable = 'YES' AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'leads.service_id is missing, required, or defaulted';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'signup_requests' AND column_name = 'service_id'
       AND is_nullable = 'YES' AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'signup_requests.service_id is missing, required, or defaulted';
  END IF;
  IF to_regclass('public.leads_service_id_idx') IS NULL
     OR to_regclass('public.signup_requests_service_id_idx') IS NULL THEN
    RAISE EXCEPTION 'a service_id index is missing';
  END IF;
END
$post$;
