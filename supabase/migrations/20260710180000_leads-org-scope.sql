-- Finding #25: per-tenant embeddable lead form. Add organization_id to leads
-- and scope RLS to the owning org. Applied to live via Supabase MCP 2026-07-10.
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE;

UPDATE public.leads
   SET organization_id = (SELECT id FROM public.organizations WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL;

CREATE INDEX IF NOT EXISTS leads_organization_id_idx ON public.leads (organization_id);

DROP POLICY IF EXISTS "Managers can read leads" ON public.leads;
CREATE POLICY "Managers can read leads" ON public.leads FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = auth.uid()
    AND ur.role = ANY (ARRAY['owner'::app_role, 'office_manager'::app_role]) AND ur.organization_id = leads.organization_id));

DROP POLICY IF EXISTS "Managers can update leads" ON public.leads;
CREATE POLICY "Managers can update leads" ON public.leads FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = auth.uid()
    AND ur.role = ANY (ARRAY['owner'::app_role, 'office_manager'::app_role]) AND ur.organization_id = leads.organization_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = auth.uid()
    AND ur.role = ANY (ARRAY['owner'::app_role, 'office_manager'::app_role]) AND ur.organization_id = leads.organization_id));

DROP POLICY IF EXISTS "Managers can delete leads" ON public.leads;
CREATE POLICY "Managers can delete leads" ON public.leads FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = auth.uid()
    AND ur.role = ANY (ARRAY['owner'::app_role, 'office_manager'::app_role]) AND ur.organization_id = leads.organization_id));
