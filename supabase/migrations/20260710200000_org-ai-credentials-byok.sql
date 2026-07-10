-- Bring-your-own-key for AI Tools: per-org Anthropic/OpenAI provider + key.
-- Service-role only (RLS enabled, no policies) — read solely by server
-- functions, never selected into a client query. Applied to live via Supabase
-- MCP 2026-07-10.
CREATE TABLE IF NOT EXISTS public.org_ai_credentials (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('anthropic', 'openai')),
  api_key text NOT NULL,
  model text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
ALTER TABLE public.org_ai_credentials ENABLE ROW LEVEL SECURITY;
