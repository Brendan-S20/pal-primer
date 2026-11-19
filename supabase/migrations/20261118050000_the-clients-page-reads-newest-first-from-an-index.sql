-- The /clients page reads newest-first from an index (Refs #900, follow-up 1 of #643).
--
-- listClientsPage orders by created_at DESC, id and keeps one page. With only
-- idx_clients_org(organization_id) the planner finds every client of the org,
-- builds the embeds for all of them and top-N sorts: 74-109 ms at 5,000 clients
-- on the #643 run, growing linearly. This index lets it walk the first page in
-- order. Additive: no table, column or policy changes; the app is untouched.
--
-- A plain CREATE INDEX, as 20260809210000 explains: CONCURRENTLY cannot run in
-- a migration's transaction. It takes a short write lock on clients while it
-- builds; run it outside business hours on a very large book.
CREATE INDEX IF NOT EXISTS clients_org_newest_idx
  ON public.clients (organization_id, created_at DESC, id);

DO $verify$
BEGIN
  IF pg_get_indexdef('public.clients_org_newest_idx'::regclass)
       NOT LIKE '%(organization_id, created_at DESC, id)%' THEN
    RAISE EXCEPTION 'clients_org_newest_idx has the wrong definition';
  END IF;
END
$verify$;
