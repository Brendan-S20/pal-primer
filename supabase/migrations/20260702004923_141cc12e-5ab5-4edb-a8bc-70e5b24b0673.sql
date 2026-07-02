
CREATE TYPE public.accounting_provider AS ENUM ('quickbooks', 'xero');
CREATE TYPE public.accounting_sync_direction AS ENUM ('push', 'pull');
CREATE TYPE public.accounting_sync_status AS ENUM ('pending', 'success', 'error');
CREATE TYPE public.accounting_entity_type AS ENUM ('invoice', 'payment', 'client');

CREATE TABLE public.accounting_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider public.accounting_provider NOT NULL,
  realm_id text,
  tenant_id text,
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  default_income_account text,
  default_ar_account text,
  default_payment_account text,
  auto_sync boolean NOT NULL DEFAULT false,
  connected_at timestamptz NOT NULL DEFAULT now(),
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id, provider)
);

CREATE TABLE public.accounting_sync_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES public.accounting_connections(id) ON DELETE SET NULL,
  entity_type public.accounting_entity_type NOT NULL,
  entity_id uuid NOT NULL,
  direction public.accounting_sync_direction NOT NULL,
  status public.accounting_sync_status NOT NULL,
  remote_id text,
  message text,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS accounting_remote_id text;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS accounting_remote_id text;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS accounting_remote_id text;

CREATE INDEX idx_accounting_sync_log_org ON public.accounting_sync_log(org_id, created_at DESC);
CREATE INDEX idx_accounting_sync_log_entity ON public.accounting_sync_log(entity_type, entity_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.accounting_connections TO authenticated;
GRANT ALL ON public.accounting_connections TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.accounting_sync_log TO authenticated;
GRANT ALL ON public.accounting_sync_log TO service_role;

ALTER TABLE public.accounting_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_sync_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Managers read connections" ON public.accounting_connections
  FOR SELECT TO authenticated
  USING (public.can_write_org(auth.uid(), org_id));
CREATE POLICY "Managers write connections" ON public.accounting_connections
  FOR ALL TO authenticated
  USING (public.can_write_org(auth.uid(), org_id))
  WITH CHECK (public.can_write_org(auth.uid(), org_id));

CREATE POLICY "Managers read sync log" ON public.accounting_sync_log
  FOR SELECT TO authenticated
  USING (public.can_write_org(auth.uid(), org_id));
CREATE POLICY "Managers write sync log" ON public.accounting_sync_log
  FOR ALL TO authenticated
  USING (public.can_write_org(auth.uid(), org_id))
  WITH CHECK (public.can_write_org(auth.uid(), org_id));

CREATE TRIGGER trg_accounting_connections_updated
  BEFORE UPDATE ON public.accounting_connections
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();
