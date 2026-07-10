-- Review-request emails: fallback channel when a tenant hasn't connected its
-- own Twilio for the conversational SMS number. Default on.
-- Applied to live via Supabase MCP 2026-07-10.
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS notify_email_review_request boolean NOT NULL DEFAULT true;
