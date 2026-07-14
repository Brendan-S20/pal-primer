-- Platform -> tenant software add-ons (per Brendan, 2026-07-14): upsells like
-- the AI Receptionist that bolt onto a tenant's HoundStack subscription.
-- Catalog rows are managed by the platform; tenants subscribe from
-- Settings -> Billing and the charge lands as a Stripe subscription item on
-- their existing plan subscription.

CREATE TABLE public.platform_addons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  description text,
  price_cents integer NOT NULL,
  billing_interval text NOT NULL DEFAULT 'month' CHECK (billing_interval IN ('month', 'year')),
  -- Lazily minted on first subscribe if absent.
  stripe_product_id text,
  stripe_price_id text,
  -- Optional org feature flag flipped on subscribe/cancel (e.g. the
  -- ai-receptionist add-on toggles organizations.ai_receptionist_enabled).
  feature_flag text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.platform_addons ENABLE ROW LEVEL SECURITY;

-- Tenants browse the catalog; only platform admins manage it.
CREATE POLICY "authenticated read active platform addons"
  ON public.platform_addons FOR SELECT TO authenticated USING (true);
CREATE POLICY "platform admins manage platform addons"
  ON public.platform_addons FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

CREATE TABLE public.org_platform_addons (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  addon_id uuid NOT NULL REFERENCES public.platform_addons(id) ON DELETE CASCADE,
  stripe_subscription_item_id text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'canceled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  canceled_at timestamptz,
  PRIMARY KEY (organization_id, addon_id)
);

ALTER TABLE public.org_platform_addons ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members read own platform addons"
  ON public.org_platform_addons FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "billing managers manage own platform addons"
  ON public.org_platform_addons FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), organization_id, 'manage_org_billing'))
  WITH CHECK (public.has_permission(auth.uid(), organization_id, 'manage_org_billing'));
CREATE POLICY "platform admins manage org platform addons"
  ON public.org_platform_addons FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

-- Flagship upsell: the AI Receptionist is fully built (per-org enable flag,
-- FAQ/persona config, logs) and previously just a free settings toggle.
INSERT INTO public.platform_addons (slug, name, description, price_cents, feature_flag, sort_order)
VALUES (
  'ai-receptionist',
  'AI Receptionist',
  'Answers client texts for you day and night: FAQs, scheduling questions, and escalations to your team when a human is needed. Configure its persona and knowledge in Settings.',
  4900,
  'ai_receptionist',
  1
);
