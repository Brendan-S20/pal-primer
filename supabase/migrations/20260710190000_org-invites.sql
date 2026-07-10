-- Finding #40: tenant teammate-invite flow. Applied to live via Supabase MCP
-- apply_migration on 2026-07-10. Idempotent.
CREATE TABLE IF NOT EXISTS public.org_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  role public.app_role NOT NULL,
  token text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending',
  invited_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '14 days',
  accepted_at timestamptz,
  CONSTRAINT org_invites_role_not_platform CHECK (role <> 'platform_admin')
);
CREATE INDEX IF NOT EXISTS org_invites_org_idx ON public.org_invites (organization_id, status);
CREATE INDEX IF NOT EXISTS org_invites_email_idx ON public.org_invites (lower(email), status);
ALTER TABLE public.org_invites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_invites_manage ON public.org_invites;
CREATE POLICY org_invites_manage ON public.org_invites FOR ALL
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = auth.uid()
    AND ur.role = ANY (ARRAY['owner'::app_role, 'office_manager'::app_role]) AND ur.organization_id = org_invites.organization_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = auth.uid()
    AND ur.role = ANY (ARRAY['owner'::app_role, 'office_manager'::app_role]) AND ur.organization_id = org_invites.organization_id));
CREATE OR REPLACE FUNCTION public.accept_org_invite_for_current_user()
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE _uid uuid := auth.uid(); _email text; _inv public.org_invites;
BEGIN
  IF _uid IS NULL THEN RETURN NULL; END IF;
  SELECT email INTO _email FROM auth.users WHERE id = _uid;
  IF _email IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO _inv FROM public.org_invites
   WHERE lower(email) = lower(_email) AND status = 'pending' AND expires_at > now()
   ORDER BY created_at DESC LIMIT 1;
  IF _inv.id IS NULL THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _uid AND organization_id = _inv.organization_id) THEN
    UPDATE public.org_invites SET status = 'accepted', accepted_at = now() WHERE id = _inv.id;
    RETURN _inv.organization_id;
  END IF;
  INSERT INTO public.user_roles(user_id, organization_id, role) VALUES (_uid, _inv.organization_id, _inv.role);
  INSERT INTO public.staff(organization_id, user_id, role, display_name, active)
    VALUES (_inv.organization_id, _uid, _inv.role, split_part(_email, '@', 1), _inv.role = 'tech');
  UPDATE public.org_invites SET status = 'accepted', accepted_at = now() WHERE id = _inv.id;
  RETURN _inv.organization_id;
END;
$fn$;
