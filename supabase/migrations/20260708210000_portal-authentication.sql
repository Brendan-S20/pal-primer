-- Client portal authentication (QA finding #4).
--
-- Before: /portal/{uuid} was a bare, permanently-valid URL — anyone holding it
-- reached payment-method entry, autopay, invoices, and property/schedule
-- details with no auth. Every portal_* RPC was granted to `anon`, so the token
-- in the URL was the only gate.
--
-- After: the token identifies WHICH client the portal is for, but unlocking it
-- requires a one-time code sent to the phone/email on file, which mints a
-- short-lived (30-day) session. All portal_* RPCs are revoked from anon and
-- run only through the server (service_role) after a session check.
--
-- Paired rollback: supabase/rollback/20260708210000_portal-authentication.down.sql
-- Written convergently; safe to re-apply.

-- ── 1. Session + OTP tables ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.portal_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- SHA-256 of the opaque cookie value; the raw secret is never stored.
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip inet,
  user_agent text
);
CREATE INDEX IF NOT EXISTS portal_sessions_client_idx ON public.portal_sessions(client_id);
CREATE INDEX IF NOT EXISTS portal_sessions_expiry_idx ON public.portal_sessions(expires_at);
ALTER TABLE public.portal_sessions ENABLE ROW LEVEL SECURITY;
-- No policies: only service_role (bypasses RLS) touches this table. anon/authenticated get nothing.
GRANT ALL ON public.portal_sessions TO service_role;

CREATE TABLE IF NOT EXISTS public.portal_otps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('sms', 'email')),
  destination_hint text,           -- masked, e.g. "•••• 4821" — safe to show
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  request_ip inet
);
CREATE INDEX IF NOT EXISTS portal_otps_client_idx ON public.portal_otps(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS portal_otps_ip_idx ON public.portal_otps(request_ip, created_at DESC);
ALTER TABLE public.portal_otps ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.portal_otps TO service_role;

-- ── 2. Revoke anon access to every portal_* RPC ──────────────────────────────
-- These were the entire attack surface: callable by anyone with the token.
-- The server now calls them via service_role after verifying a session.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE 'portal\_%'
  LOOP
    -- PUBLIC is critical: Postgres grants EXECUTE to PUBLIC by default on every
    -- function, and anon inherits through it. Revoking only anon leaves the
    -- hole open.
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated;', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role;', r.sig);
  END LOOP;
END $$;

-- ── 3. Contact-on-file lookup for OTP delivery (service_role only) ───────────
-- Returns the real phone/email plus a masked hint. SECURITY DEFINER so the
-- server can resolve a token→contact without a broad grant; never exposed to anon.
CREATE OR REPLACE FUNCTION public.portal_resolve_contact(_token uuid)
RETURNS TABLE(client_id uuid, organization_id uuid, display_name text,
              primary_phone text, primary_email text, org_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.organization_id, c.display_name, c.primary_phone, c.primary_email, o.name
    FROM public.clients c JOIN public.organizations o ON o.id = c.organization_id
   WHERE c.portal_token = _token AND c.active = true
$$;
REVOKE ALL ON FUNCTION public.portal_resolve_contact(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_resolve_contact(uuid) TO service_role;

-- ── 4. Regenerate a client's portal token (invalidate the old link) ──────────
-- Owner/office action: rotates the token AND revokes every live session, so a
-- leaked link + any device it minted are both cut off at once.
CREATE OR REPLACE FUNCTION public.regenerate_portal_token(_client_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid; _new uuid;
BEGIN
  SELECT organization_id INTO _org FROM public.clients WHERE id = _client_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Client not found'; END IF;
  IF NOT public.has_permission(auth.uid(), _org, 'manage_settings') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  _new := gen_random_uuid();
  UPDATE public.clients SET portal_token = _new WHERE id = _client_id;
  UPDATE public.portal_sessions
     SET revoked_at = now()
   WHERE client_id = _client_id AND revoked_at IS NULL;
  RETURN _new;
END;
$$;
REVOKE ALL ON FUNCTION public.regenerate_portal_token(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.regenerate_portal_token(uuid) TO authenticated, service_role;
