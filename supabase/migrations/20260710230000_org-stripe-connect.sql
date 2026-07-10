-- Tenant Stripe via Connect (OAuth). Each org authorizes its own Stripe
-- account; HoundStack (the Connect platform) makes tenant->client charges on
-- that connected account and never stores the tenant's secret key. Distinct
-- from the platform's SaaS-billing Stripe (organizations.stripe_customer_id /
-- stripe_subscription_id) which is untouched by this.
-- Applied to live via Supabase MCP 2026-07-10.
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS stripe_connect_account_id text,
  ADD COLUMN IF NOT EXISTS stripe_connect_status text,          -- pending | active | restricted | disconnected
  ADD COLUMN IF NOT EXISTS stripe_connect_charges_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_connect_connected_at timestamptz;
