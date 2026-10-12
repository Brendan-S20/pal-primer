-- Website form submissions from houndstack.com.
--
-- The public route writes with the service role after validation, spam checks
-- and a per-address rate limit. There is deliberately no anon or authenticated
-- insert policy. Platform admins can read and mark rows handled.

CREATE TABLE IF NOT EXISTS public.website_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  form text NOT NULL CHECK (form IN ('contact', 'early_access')),
  name text NOT NULL CHECK (char_length(name) <= 120),
  email text NOT NULL CHECK (char_length(email) <= 254),
  business_name text CHECK (business_name IS NULL OR char_length(business_name) <= 160),
  phone text CHECK (phone IS NULL OR char_length(phone) <= 50),
  message text CHECK (message IS NULL OR char_length(message) <= 4000),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_page text CHECK (source_page IS NULL OR char_length(source_page) <= 500),
  ip_hash text,
  user_agent text CHECK (user_agent IS NULL OR char_length(user_agent) <= 500),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'handled', 'spam')),
  handled_at timestamptz,
  handled_by uuid
);

COMMENT ON TABLE public.website_submissions IS
  'Contact and early-access form submissions from houndstack.com. Written only by the service-role public endpoint.';
COMMENT ON COLUMN public.website_submissions.payload IS
  'Extra marketing-site fields not promoted to first-class columns.';
COMMENT ON COLUMN public.website_submissions.ip_hash IS
  'Salted hash of the caller address, used for rate limiting without storing the address itself.';

CREATE INDEX IF NOT EXISTS website_submissions_created_idx
  ON public.website_submissions (created_at DESC);
CREATE INDEX IF NOT EXISTS website_submissions_form_created_idx
  ON public.website_submissions (form, created_at DESC);
CREATE INDEX IF NOT EXISTS website_submissions_status_created_idx
  ON public.website_submissions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS website_submissions_ip_created_idx
  ON public.website_submissions (ip_hash, created_at DESC);

REVOKE ALL ON public.website_submissions FROM anon, authenticated;
GRANT SELECT, UPDATE ON public.website_submissions TO authenticated;
GRANT ALL ON public.website_submissions TO service_role;

ALTER TABLE public.website_submissions ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.website_submissions');

DROP POLICY IF EXISTS "platform admins read website submissions" ON public.website_submissions;
CREATE POLICY "platform admins read website submissions"
  ON public.website_submissions FOR SELECT TO authenticated
  USING (public.is_platform_admin((SELECT auth.uid())));

DROP POLICY IF EXISTS "platform admins update website submissions" ON public.website_submissions;
CREATE POLICY "platform admins update website submissions"
  ON public.website_submissions FOR UPDATE TO authenticated
  USING (public.is_platform_admin((SELECT auth.uid())))
  WITH CHECK (public.is_platform_admin((SELECT auth.uid())));

DO $check$
BEGIN
  IF has_table_privilege('anon', 'public.website_submissions', 'INSERT')
     OR has_table_privilege('authenticated', 'public.website_submissions', 'INSERT') THEN
    RAISE EXCEPTION 'public roles can insert website_submissions';
  END IF;

  IF has_table_privilege('anon', 'public.website_submissions', 'SELECT') THEN
    RAISE EXCEPTION 'anon can read website_submissions';
  END IF;
END
$check$;
