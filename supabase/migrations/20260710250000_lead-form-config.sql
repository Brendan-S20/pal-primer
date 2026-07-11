-- Per-tenant lead form customization (#25): branding + which optional fields
-- to collect + custom copy. name/email are always required; the rest are
-- toggleable. Stored as a jsonb blob on the org.
-- Applied to live via Supabase MCP 2026-07-10.
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS lead_form_config jsonb NOT NULL DEFAULT '{}'::jsonb;
