
CREATE TYPE public.import_source AS ENUM ('generic_csv','sweepgo','jobber','housecall_pro','time_to_pet','gorilla_desk','quoteiq_family');
CREATE TYPE public.import_status AS ENUM ('draft','previewing','committed','failed','cancelled');
CREATE TYPE public.import_row_action AS ENUM ('create','update','skip','error');

CREATE TABLE public.import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES auth.users(id),
  source public.import_source NOT NULL,
  entity TEXT NOT NULL DEFAULT 'clients',
  filename TEXT,
  status public.import_status NOT NULL DEFAULT 'draft',
  mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  committed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.import_batches TO authenticated;
GRANT ALL ON public.import_batches TO service_role;
ALTER TABLE public.import_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org read import_batches" ON public.import_batches FOR SELECT TO authenticated USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "org write import_batches" ON public.import_batches FOR ALL TO authenticated USING (public.can_write_org(auth.uid(), organization_id)) WITH CHECK (public.can_write_org(auth.uid(), organization_id));
CREATE TRIGGER trg_import_batches_updated BEFORE UPDATE ON public.import_batches FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

CREATE TABLE public.import_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES public.import_batches(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  row_num INT NOT NULL,
  raw JSONB NOT NULL,
  mapped JSONB,
  action public.import_row_action NOT NULL DEFAULT 'create',
  target_id UUID,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_import_rows_batch ON public.import_rows(batch_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.import_rows TO authenticated;
GRANT ALL ON public.import_rows TO service_role;
ALTER TABLE public.import_rows ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org read import_rows" ON public.import_rows FOR SELECT TO authenticated USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "org write import_rows" ON public.import_rows FOR ALL TO authenticated USING (public.can_write_org(auth.uid(), organization_id)) WITH CHECK (public.can_write_org(auth.uid(), organization_id));

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS import_source public.import_source,
  ADD COLUMN IF NOT EXISTS import_external_id TEXT,
  ADD COLUMN IF NOT EXISTS import_batch_id UUID REFERENCES public.import_batches(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_import_dedupe
  ON public.clients(organization_id, import_source, import_external_id)
  WHERE import_source IS NOT NULL AND import_external_id IS NOT NULL;
