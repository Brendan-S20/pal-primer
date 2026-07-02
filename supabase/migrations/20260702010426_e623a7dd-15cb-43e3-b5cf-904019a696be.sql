
CREATE TABLE IF NOT EXISTS public.oauth_states (
  state text PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('quickbooks','xero')),
  redirect_to text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes')
);
GRANT ALL ON public.oauth_states TO service_role;
ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;
-- No user-facing policies; only the service role (used by public OAuth callback) touches this table.

CREATE INDEX IF NOT EXISTS oauth_states_expires_idx ON public.oauth_states(expires_at);
