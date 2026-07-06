
CREATE TABLE IF NOT EXISTS public.platform_admins (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

GRANT SELECT ON public.platform_admins TO authenticated;
GRANT ALL ON public.platform_admins TO service_role;

ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "platform admins can read admins" ON public.platform_admins;
DROP POLICY IF EXISTS "authenticated can read admins bootstrap" ON public.platform_admins;
CREATE POLICY "authenticated can read admins bootstrap"
  ON public.platform_admins FOR SELECT TO authenticated USING (true);

INSERT INTO public.platform_admins (user_id)
SELECT DISTINCT user_id FROM public.user_roles WHERE role = 'platform_admin'
ON CONFLICT (user_id) DO NOTHING;

DELETE FROM public.user_roles WHERE role = 'platform_admin';

CREATE OR REPLACE FUNCTION public.is_platform_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = _user_id)
$$;

DROP POLICY IF EXISTS "authenticated can read admins bootstrap" ON public.platform_admins;
CREATE POLICY "platform admins can read admins"
  ON public.platform_admins FOR SELECT TO authenticated
  USING (public.is_platform_admin(auth.uid()));

-- Cannot drop 'platform_admin' from app_role enum because policies elsewhere
-- reference the column type. Enforce via CHECK constraint instead so no new
-- rows can be inserted with that value.
ALTER TABLE public.user_roles
  DROP CONSTRAINT IF EXISTS user_roles_no_platform_admin;
ALTER TABLE public.user_roles
  ADD CONSTRAINT user_roles_no_platform_admin
  CHECK (role <> 'platform_admin');
