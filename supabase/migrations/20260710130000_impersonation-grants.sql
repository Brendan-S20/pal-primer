-- Finding #5: one-time impersonation grant (applied to live via Supabase MCP
-- apply_migration on 2026-07-10 as `impersonation_grants`). Idempotent.
--
-- Impersonation no longer opens a Supabase hosted magic link in a new tab
-- (which established the tenant session in the browser's SHARED localStorage,
-- silently hijacking the admin's own session in every tab). Instead an admin
-- mints a single-use, short-lived grant here; the new (tab-scoped) window
-- exchanges the grant's token for a session that it stores only in its own
-- sessionStorage. The token itself is never stored in cleartext — only its
-- SHA-256 hash — and possession of the token in the opening admin's hands is
-- the authorization to redeem it.
CREATE TABLE IF NOT EXISTS public.impersonation_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  target_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE INDEX IF NOT EXISTS impersonation_grants_token_hash_idx
  ON public.impersonation_grants (token_hash);

ALTER TABLE public.impersonation_grants ENABLE ROW LEVEL SECURITY;
