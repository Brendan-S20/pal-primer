
-- =========================================================================
-- 1. Enum for organization billing_status
-- =========================================================================
DO $$ BEGIN
  CREATE TYPE public.org_billing_status AS ENUM
    ('free','active','past_due','grace','suspended','canceled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =========================================================================
-- 2. platform_plans (client-band pricing; NO seat_limit)
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.platform_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text,
  client_limit_min integer NOT NULL,
  client_limit_max integer,  -- NULL = unbounded top tier
  price_per_client_cents integer,  -- either per-client pricing…
  price_cents integer,              -- …or a flat price for the band
  currency text NOT NULL DEFAULT 'usd',
  interval text NOT NULL DEFAULT 'month' CHECK (interval IN ('month','year')),
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  stripe_product_id text,
  stripe_price_id text,
  is_active boolean NOT NULL DEFAULT true,
  is_free boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT band_range_valid CHECK (client_limit_max IS NULL OR client_limit_max >= client_limit_min),
  CONSTRAINT price_shape_present CHECK (
    is_free OR price_per_client_cents IS NOT NULL OR price_cents IS NOT NULL
  )
);
GRANT SELECT ON public.platform_plans TO authenticated;
GRANT ALL   ON public.platform_plans TO service_role;
ALTER TABLE public.platform_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Any auth user reads active plans" ON public.platform_plans
  FOR SELECT TO authenticated USING (is_active);
CREATE POLICY "Platform admins manage plans" ON public.platform_plans
  FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

-- Seed the non-deletable Free plan (0–3 clients, $0)
INSERT INTO public.platform_plans (name, slug, description, client_limit_min, client_limit_max, price_cents, is_free, sort_order)
VALUES ('Free', 'free', 'Up to 3 active clients. Unlimited staff. Free forever.', 0, 3, 0, true, 0)
ON CONFLICT (slug) DO NOTHING;

-- =========================================================================
-- 3. organizations — new billing/lifecycle columns
-- =========================================================================
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS plan_id uuid REFERENCES public.platform_plans(id),
  ADD COLUMN IF NOT EXISTS billing_status public.org_billing_status NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS grace_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_reason text,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Backfill: point every existing org at the Free plan if unset
UPDATE public.organizations
  SET plan_id = (SELECT id FROM public.platform_plans WHERE slug = 'free')
  WHERE plan_id IS NULL;

CREATE INDEX IF NOT EXISTS organizations_billing_status_idx
  ON public.organizations(billing_status) WHERE deleted_at IS NULL;

-- =========================================================================
-- 4. platform_coupons
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.platform_coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  stripe_coupon_id text,
  percent_off numeric(5,2) CHECK (percent_off IS NULL OR (percent_off > 0 AND percent_off <= 100)),
  amount_off_cents integer CHECK (amount_off_cents IS NULL OR amount_off_cents > 0),
  currency text NOT NULL DEFAULT 'usd',
  duration text NOT NULL DEFAULT 'once' CHECK (duration IN ('once','repeating','forever')),
  duration_in_months integer,
  max_redemptions integer,
  times_redeemed integer NOT NULL DEFAULT 0,
  expires_at timestamptz,
  applies_to_plan_ids uuid[] NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coupon_has_a_discount CHECK (percent_off IS NOT NULL OR amount_off_cents IS NOT NULL)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_coupons TO authenticated;
GRANT ALL ON public.platform_coupons TO service_role;
ALTER TABLE public.platform_coupons ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Platform admins manage coupons" ON public.platform_coupons
  FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

-- =========================================================================
-- 5. platform_invoices (SaaS invoices to tenants)
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.platform_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  stripe_invoice_id text UNIQUE,
  number text,
  amount_due_cents integer NOT NULL DEFAULT 0,
  amount_paid_cents integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'usd',
  status text NOT NULL DEFAULT 'draft',
  hosted_invoice_url text,
  invoice_pdf text,
  period_start timestamptz,
  period_end timestamptz,
  issued_at timestamptz,
  due_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_invoices TO authenticated;
GRANT ALL ON public.platform_invoices TO service_role;
ALTER TABLE public.platform_invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Platform admins manage SaaS invoices" ON public.platform_invoices
  FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));
CREATE INDEX IF NOT EXISTS platform_invoices_org_idx ON public.platform_invoices(organization_id, issued_at DESC);

-- =========================================================================
-- 6. platform_invites
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.platform_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  organization_name text,
  role text NOT NULL DEFAULT 'owner',
  token text NOT NULL UNIQUE,
  invited_by uuid REFERENCES auth.users(id),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_at timestamptz,
  accepted_by uuid REFERENCES auth.users(id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invite_target_present CHECK (organization_id IS NOT NULL OR organization_name IS NOT NULL)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_invites TO authenticated;
GRANT ALL ON public.platform_invites TO service_role;
ALTER TABLE public.platform_invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Platform admins manage invites" ON public.platform_invites
  FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));
CREATE INDEX IF NOT EXISTS platform_invites_email_idx ON public.platform_invites(lower(email));

-- =========================================================================
-- 7. Feature flags (catalog + per-org overrides)
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.platform_feature_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  label text NOT NULL,
  description text,
  default_value boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.platform_feature_flags TO authenticated;
GRANT ALL ON public.platform_feature_flags TO service_role;
ALTER TABLE public.platform_feature_flags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Any auth user reads flag catalog" ON public.platform_feature_flags
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Platform admins manage flag catalog" ON public.platform_feature_flags
  FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

CREATE TABLE IF NOT EXISTS public.platform_org_feature_flags (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key text NOT NULL REFERENCES public.platform_feature_flags(key) ON UPDATE CASCADE ON DELETE CASCADE,
  value boolean NOT NULL,
  justification text,
  updated_by uuid REFERENCES auth.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, key)
);
GRANT SELECT ON public.platform_org_feature_flags TO authenticated;
GRANT ALL ON public.platform_org_feature_flags TO service_role;
ALTER TABLE public.platform_org_feature_flags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members read own org flags" ON public.platform_org_feature_flags
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur
                  WHERE ur.user_id = auth.uid()
                    AND ur.organization_id = platform_org_feature_flags.organization_id));
CREATE POLICY "Platform admins manage org flags" ON public.platform_org_feature_flags
  FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

-- =========================================================================
-- 8. platform_support_notes
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.platform_support_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  author_user_id uuid REFERENCES auth.users(id),
  body text NOT NULL,
  kind text NOT NULL DEFAULT 'note' CHECK (kind IN ('note','call','email','ticket')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_support_notes TO authenticated;
GRANT ALL ON public.platform_support_notes TO service_role;
ALTER TABLE public.platform_support_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Platform admins manage support notes" ON public.platform_support_notes
  FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));
CREATE INDEX IF NOT EXISTS platform_support_notes_org_idx ON public.platform_support_notes(organization_id, created_at DESC);

-- =========================================================================
-- 9. Announcements + read tracking
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.platform_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  body text NOT NULL,
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warn','critical')),
  audience text NOT NULL DEFAULT 'all',  -- 'all' or 'plan:<slug>'
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  send_email boolean NOT NULL DEFAULT false,
  email_sent_at timestamptz,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.platform_announcements TO authenticated;
GRANT ALL ON public.platform_announcements TO service_role;
ALTER TABLE public.platform_announcements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Any auth user reads active announcements" ON public.platform_announcements
  FOR SELECT TO authenticated
  USING (starts_at <= now() AND (ends_at IS NULL OR ends_at > now()));
CREATE POLICY "Platform admins manage announcements" ON public.platform_announcements
  FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

CREATE TABLE IF NOT EXISTS public.platform_announcement_reads (
  announcement_id uuid NOT NULL REFERENCES public.platform_announcements(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id)
);
GRANT SELECT, INSERT, DELETE ON public.platform_announcement_reads TO authenticated;
GRANT ALL ON public.platform_announcement_reads TO service_role;
ALTER TABLE public.platform_announcement_reads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own reads" ON public.platform_announcement_reads
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
CREATE POLICY "Platform admins read all reads" ON public.platform_announcement_reads
  FOR SELECT TO authenticated
  USING (public.is_platform_admin(auth.uid()));

-- =========================================================================
-- 10. platform_stripe_events (webhook idempotency)
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.platform_stripe_events (
  id text PRIMARY KEY,  -- Stripe event id (evt_…)
  type text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error text
);
GRANT SELECT ON public.platform_stripe_events TO authenticated;
GRANT ALL ON public.platform_stripe_events TO service_role;
ALTER TABLE public.platform_stripe_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Platform admins read Stripe events" ON public.platform_stripe_events
  FOR SELECT TO authenticated
  USING (public.is_platform_admin(auth.uid()));

-- =========================================================================
-- 11. updated_at trigger (reuse shared helper if present, otherwise create)
-- =========================================================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'platform_plans','platform_coupons','platform_invoices','platform_invites',
    'platform_feature_flags','platform_support_notes','platform_announcements'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()',
      t
    );
  END LOOP;
END $$;

-- =========================================================================
-- 12. Fix platform_org_stats: c.is_active -> c.active; exclude soft-deleted orgs
-- =========================================================================
CREATE OR REPLACE FUNCTION public.platform_org_stats()
RETURNS TABLE(
  organization_id uuid, organization_name text,
  billing_tier text, plan_status text,
  active_clients bigint, users_count bigint,
  revenue_mtd_cents bigint, ar_open_cents bigint,
  created_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT
    o.id,
    o.name,
    o.billing_tier,
    o.plan_status::text,
    COALESCE((SELECT COUNT(*) FROM public.clients c
              WHERE c.organization_id = o.id AND c.active), 0),
    COALESCE((SELECT COUNT(DISTINCT ur.user_id) FROM public.user_roles ur
              WHERE ur.organization_id = o.id), 0),
    COALESCE((SELECT SUM(i.total_cents)::bigint FROM public.invoices i
              WHERE i.organization_id = o.id AND i.status = 'paid'
                AND i.issued_at >= date_trunc('month', now())), 0),
    COALESCE((SELECT SUM(i.total_cents - COALESCE(i.amount_paid_cents, 0))::bigint FROM public.invoices i
              WHERE i.organization_id = o.id AND i.status IN ('open','overdue')), 0),
    o.created_at
  FROM public.organizations o
  WHERE o.deleted_at IS NULL
  ORDER BY o.created_at DESC;
END;
$$;
