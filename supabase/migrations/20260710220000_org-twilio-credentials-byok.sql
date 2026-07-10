-- Bring-your-own-Twilio for the tenant<->client CONVERSATION channel.
-- Service-role only (RLS enabled, no policies) — read solely by server
-- functions, never selected into a client query; the auth token never leaves
-- the server and the settings endpoint returns only a masked last-4.
-- The platform keeps its own Twilio for OTP + automated notifications.
-- Applied to live via Supabase MCP 2026-07-10.
CREATE TABLE IF NOT EXISTS public.org_twilio_credentials (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  account_sid text NOT NULL,
  auth_token text NOT NULL,
  sms_from_number text,            -- the org's conversational sender number
  messaging_service_sid text,      -- optional; where A2P 10DLC attaches
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
ALTER TABLE public.org_twilio_credentials ENABLE ROW LEVEL SECURITY;
