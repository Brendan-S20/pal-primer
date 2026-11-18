-- Proof for 20261118050000 (#900): the clients page read is served by clients_org_newest_idx.
-- One transaction, ROLLED BACK.
\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;
BEGIN;
INSERT INTO public.organizations (id, name, timezone)
VALUES ('0a000000-0000-4000-8000-000000900a0a', 'Index Proof', 'America/Detroit');
INSERT INTO public.clients (organization_id, account_type, display_name, created_at)
SELECT '0a000000-0000-4000-8000-000000900a0a', 'residential', 'Client ' || n, now() - (n || ' minutes')::interval
  FROM generate_series(1, 5000) n;
ANALYZE public.clients;

DO $proof$
DECLARE _plan text := '';
        _row text;
BEGIN
  IF pg_get_indexdef('public.clients_org_newest_idx'::regclass) NOT LIKE '%(organization_id, created_at DESC, id)%' THEN
    RAISE EXCEPTION 'PROOF FAILED: index definition is %', pg_get_indexdef('public.clients_org_newest_idx'::regclass);
  END IF;
  RAISE NOTICE 'ok: clients_org_newest_idx is (organization_id, created_at DESC, id)';
  FOR _row IN EXECUTE $q$EXPLAIN SELECT id FROM public.clients
       WHERE organization_id = '0a000000-0000-4000-8000-000000900a0a'
       ORDER BY created_at DESC, id LIMIT 50 OFFSET 50$q$ LOOP
    _plan := _plan || _row || E'\n';
  END LOOP;
  IF _plan NOT LIKE '%clients_org_newest_idx%' OR _plan ~ 'Sort' THEN
    RAISE EXCEPTION 'PROOF FAILED: page read does not walk the index in order:%', E'\n' || _plan;
  END IF;
  RAISE NOTICE 'ok: the page read walks the index in order, with no sort, at 5,000 clients';
  RAISE NOTICE 'ALL CLIENTS-INDEX PROOFS PASSED';
END
$proof$;
ROLLBACK;
