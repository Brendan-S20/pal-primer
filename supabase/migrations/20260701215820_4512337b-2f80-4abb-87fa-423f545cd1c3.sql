
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS slug text UNIQUE,
  ADD COLUMN IF NOT EXISTS public_signup_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS frequency_multipliers jsonb NOT NULL DEFAULT '{"weekly":1.0,"biweekly":1.7,"twice_weekly":1.8,"monthly":3.2}'::jsonb,
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'usd';

ALTER TABLE public.zones
  ADD COLUMN IF NOT EXISTS base_price_cents integer NOT NULL DEFAULT 2000,
  ADD COLUMN IF NOT EXISTS per_dog_addl_cents integer NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS initial_cleanup_cents integer NOT NULL DEFAULT 7500,
  ADD COLUMN IF NOT EXISTS zip_codes text[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS public.signup_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  zone_id uuid REFERENCES public.zones(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','provisioned','failed','canceled')),
  name text NOT NULL,
  email text NOT NULL,
  phone text,
  street text NOT NULL,
  city text,
  region text,
  postal_code text NOT NULL,
  dog_count integer NOT NULL CHECK (dog_count BETWEEN 1 AND 20),
  frequency text NOT NULL CHECK (frequency IN ('weekly','biweekly','twice_weekly','monthly')),
  recurring_price_cents integer NOT NULL,
  initial_cleanup_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'usd',
  stripe_checkout_session_id text UNIQUE,
  provisioned_client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.signup_requests TO authenticated;
GRANT ALL ON public.signup_requests TO service_role;
ALTER TABLE public.signup_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members read signup_requests"
  ON public.signup_requests FOR SELECT TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()));

CREATE TRIGGER trg_signup_requests_updated_at
  BEFORE UPDATE ON public.signup_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.public_get_org_by_slug(_slug text)
RETURNS TABLE (id uuid, name text, currency text, public_signup_enabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT o.id, o.name, o.currency, o.public_signup_enabled
  FROM public.organizations o
  WHERE o.slug = _slug AND o.public_signup_enabled = true
  LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.public_get_org_by_slug(text) TO anon, authenticated;

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
BEGIN
  SELECT * INTO _org FROM public.organizations WHERE slug = _slug AND public_signup_enabled = true;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT * INTO _zone FROM public.zones
    WHERE organization_id = _org.id
      AND (_postal_code = ANY(zip_codes)
           OR (postal_prefix IS NOT NULL AND _postal_code LIKE postal_prefix || '%'))
    ORDER BY (CASE WHEN _postal_code = ANY(zip_codes) THEN 0 ELSE 1 END),
             length(coalesce(postal_prefix,'')) DESC
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
GRANT EXECUTE ON FUNCTION public.public_quote(text, text, integer, text) TO anon, authenticated;

UPDATE public.organizations
  SET slug = 'demo', public_signup_enabled = true
  WHERE name = 'Demo Pet Waste Co' AND slug IS NULL;
