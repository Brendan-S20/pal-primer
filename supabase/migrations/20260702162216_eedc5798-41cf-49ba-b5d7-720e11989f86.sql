
CREATE TABLE public.qc_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  visit_id uuid REFERENCES public.visits(id) ON DELETE SET NULL,
  category text NOT NULL CHECK (category IN ('missed_spot','gate_left_open','damage','wrong_yard','other')),
  message text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES auth.users(id),
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.qc_tickets TO authenticated;
GRANT ALL ON public.qc_tickets TO service_role;
ALTER TABLE public.qc_tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "qc read" ON public.qc_tickets FOR SELECT TO authenticated
USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "qc write" ON public.qc_tickets FOR ALL TO authenticated
USING (public.can_write_org(auth.uid(), organization_id))
WITH CHECK (public.can_write_org(auth.uid(), organization_id));
CREATE INDEX qc_tickets_org_status_idx ON public.qc_tickets(organization_id, status, created_at DESC);
CREATE INDEX qc_tickets_client_idx ON public.qc_tickets(client_id, created_at DESC);
CREATE TRIGGER qc_tickets_updated_at BEFORE UPDATE ON public.qc_tickets
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.platform_admin_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  action text NOT NULL,
  before_json jsonb,
  after_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.platform_admin_audit TO authenticated;
GRANT ALL ON public.platform_admin_audit TO service_role;
ALTER TABLE public.platform_admin_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "audit read" ON public.platform_admin_audit FOR SELECT TO authenticated
USING (public.is_platform_admin(auth.uid()));
CREATE POLICY "audit insert" ON public.platform_admin_audit FOR INSERT TO authenticated
WITH CHECK (public.is_platform_admin(auth.uid()) AND actor_user_id = auth.uid());
CREATE INDEX platform_admin_audit_created_idx ON public.platform_admin_audit(created_at DESC);
