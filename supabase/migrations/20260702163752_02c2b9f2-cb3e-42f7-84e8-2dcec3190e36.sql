
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS dunning_retry_days integer[] NOT NULL DEFAULT ARRAY[1,3,7],
  ADD COLUMN IF NOT EXISTS dunning_pause_after_failures integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS seasonal_deepclean_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS seasonal_deepclean_months integer[] NOT NULL DEFAULT ARRAY[3,10];

CREATE TABLE IF NOT EXISTS public.neighbor_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  seed_client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  address_line text NOT NULL,
  latitude double precision,
  longitude double precision,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','interested','converted','not_interested')),
  notes text,
  contacted_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.neighbor_leads TO authenticated;
GRANT ALL ON public.neighbor_leads TO service_role;

ALTER TABLE public.neighbor_leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members read neighbor leads" ON public.neighbor_leads
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()));

CREATE POLICY "org staff write neighbor leads" ON public.neighbor_leads
  FOR ALL TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()))
  WITH CHECK (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()));

CREATE TRIGGER trg_neighbor_leads_updated
  BEFORE UPDATE ON public.neighbor_leads
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS idx_neighbor_leads_org_status ON public.neighbor_leads(organization_id, status);

ALTER TABLE public.dogs
  ADD COLUMN IF NOT EXISTS dna_registered boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dna_registry_id text;

CREATE OR REPLACE FUNCTION public.mark_franchise_parent(_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'owner'::app_role)
     AND NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'Only owners or admins can mark franchise parent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND organization_id = _org_id
  ) THEN
    RAISE EXCEPTION 'Not a member of this organization';
  END IF;
  UPDATE public.organizations SET is_franchise_parent = true WHERE id = _org_id;
END;
$$;
