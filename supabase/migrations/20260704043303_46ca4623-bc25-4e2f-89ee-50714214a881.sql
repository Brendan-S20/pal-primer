
CREATE TABLE public.platform_signup_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  contact_phone TEXT,
  website TEXT,
  approx_client_count INTEGER,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  denial_reason TEXT,
  created_invite_id UUID REFERENCES public.platform_invites(id) ON DELETE SET NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_signup_requests TO authenticated;
GRANT ALL ON public.platform_signup_requests TO service_role;

ALTER TABLE public.platform_signup_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Platform admins manage signup requests"
  ON public.platform_signup_requests
  FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

CREATE INDEX platform_signup_requests_status_idx
  ON public.platform_signup_requests (status, created_at DESC);

CREATE TRIGGER trg_platform_signup_requests_updated_at
  BEFORE UPDATE ON public.platform_signup_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
