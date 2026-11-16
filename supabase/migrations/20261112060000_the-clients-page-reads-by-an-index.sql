CREATE INDEX IF NOT EXISTS clients_organization_id_created_at_id_idx
  ON public.clients (organization_id, created_at DESC, id);
