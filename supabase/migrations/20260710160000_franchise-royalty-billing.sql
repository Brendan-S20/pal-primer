-- Finding #16: real franchise royalty billing (per-child rate + generated
-- royalty invoices against rolled-up revenue). Applied to live via Supabase MCP
-- on 2026-07-10. Idempotent.
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS franchise_royalty_percent numeric(5,2) NOT NULL DEFAULT 0
  CONSTRAINT franchise_royalty_percent_range CHECK (franchise_royalty_percent >= 0 AND franchise_royalty_percent <= 100);

CREATE TABLE IF NOT EXISTS public.franchise_royalty_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  child_organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  revenue_cents bigint NOT NULL DEFAULT 0,
  royalty_percent numeric(5,2) NOT NULL DEFAULT 0,
  amount_cents bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (child_organization_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS franchise_royalty_invoices_parent_idx
  ON public.franchise_royalty_invoices (parent_organization_id, period_start);

ALTER TABLE public.franchise_royalty_invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS franchise_royalty_parent_all ON public.franchise_royalty_invoices;
CREATE POLICY franchise_royalty_parent_all ON public.franchise_royalty_invoices
  FOR ALL
  USING (public.can_write_org(auth.uid(), parent_organization_id))
  WITH CHECK (public.can_write_org(auth.uid(), parent_organization_id));
