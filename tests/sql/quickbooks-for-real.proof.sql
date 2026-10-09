-- A business's QuickBooks data is that business's alone, proved against a
-- real Postgres. Run by tests/quickbooks-data-stays-with-its-business.test.ts
-- with :migration. One transaction, ROLLED BACK at the end, the migration
-- included.
--
-- Two businesses, each connected, each with a sync-log row. An owner of the
-- first, and a tech of the first, are tried as the API would see them.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :migration

INSERT INTO auth.users (id, email) VALUES
  ('a0000000-0000-4000-8000-0000000000a1', 'owner@qbo-a.proof.invalid'),
  ('a0000000-0000-4000-8000-0000000000a2', 'tech@qbo-a.proof.invalid'),
  ('a0000000-0000-4000-8000-0000000000b1', 'owner@qbo-b.proof.invalid');
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a000000-0000-4000-8000-0000000000a0', 'QBO Proof A', 'America/Chicago'),
  ('0a000000-0000-4000-8000-0000000000b0', 'QBO Proof B', 'America/Chicago');
SET LOCAL app.allow_protected_org_write = '';
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a0000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-0000000000a0', 'owner'),
  ('a0000000-0000-4000-8000-0000000000a2', '0a000000-0000-4000-8000-0000000000a0', 'tech'),
  ('a0000000-0000-4000-8000-0000000000b1', '0a000000-0000-4000-8000-0000000000b0', 'owner');

-- As the server writes them, on the service role.
INSERT INTO public.accounting_connections (id, org_id, provider, realm_id, access_token, refresh_token, status) VALUES
  ('c0000000-0000-4000-8000-0000000000a0', '0a000000-0000-4000-8000-0000000000a0', 'quickbooks', '111', 'v1.a.b.c', 'v1.a.b.c', 'connected'),
  ('c0000000-0000-4000-8000-0000000000b0', '0a000000-0000-4000-8000-0000000000b0', 'quickbooks', '222', 'v1.a.b.c', 'v1.a.b.c', 'connected');
INSERT INTO public.accounting_sync_log (org_id, connection_id, entity_type, entity_id, direction, status, intuit_tid) VALUES
  ('0a000000-0000-4000-8000-0000000000a0', 'c0000000-0000-4000-8000-0000000000a0', 'invoice', 'c0000000-0000-4000-8000-0000000000a0', 'push', 'error', 'proof-tid-a'),
  ('0a000000-0000-4000-8000-0000000000b0', 'c0000000-0000-4000-8000-0000000000b0', 'invoice', 'c0000000-0000-4000-8000-0000000000b0', 'push', 'error', 'proof-tid-b');
INSERT INTO public.oauth_states (state, org_id, provider) VALUES
  ('proof-state', '0a000000-0000-4000-8000-0000000000a0', 'quickbooks');

CREATE FUNCTION pg_temp.as_user(_uid text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
           json_build_object('sub', _uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
$$;

-- ── The owner of A ──────────────────────────────────────────────────────────
SELECT pg_temp.as_user('a0000000-0000-4000-8000-0000000000a1');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _n integer;
BEGIN
  SELECT count(*) INTO _n FROM public.accounting_sync_log WHERE intuit_tid LIKE 'proof-tid-%';
  IF _n <> 1 OR NOT EXISTS (SELECT 1 FROM public.accounting_sync_log WHERE intuit_tid = 'proof-tid-a') THEN
    RAISE EXCEPTION 'PROOF FAILED [isolation]: the owner of A sees % sync-log rows, expected only A''s', _n;
  END IF;
  SELECT count(*) INTO _n FROM public.accounting_connections WHERE realm_id IN ('111', '222');
  IF _n <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [isolation]: the owner of A sees % connections, expected only A''s', _n;
  END IF;
  RAISE NOTICE 'ok: the owner of A sees A''s QuickBooks connection and log, and nothing of B''s';

  UPDATE public.accounting_connections SET service_item_id = '9' WHERE org_id = '0a000000-0000-4000-8000-0000000000b0';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [isolation]: the owner of A changed B''s mapping';
  END IF;
  UPDATE public.accounting_connections SET service_item_id = '9' WHERE org_id = '0a000000-0000-4000-8000-0000000000a0';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [mapping]: the owner of A cannot save A''s own mapping';
  END IF;
  RAISE NOTICE 'ok: the owner of A saves A''s mapping and cannot touch B''s';

  BEGIN
    PERFORM access_token FROM public.accounting_connections;
    RAISE EXCEPTION 'PROOF FAILED [tokens]: a browser session read the token column';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.accounting_connections SET realm_id = '333';
    RAISE EXCEPTION 'PROOF FAILED [tokens]: a browser session rewrote the realm';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.accounting_sync_log (org_id, entity_type, entity_id, direction, status)
    VALUES ('0a000000-0000-4000-8000-0000000000a0', 'invoice', gen_random_uuid(), 'push', 'success');
    RAISE EXCEPTION 'PROOF FAILED [log]: a browser session forged a sync-log row';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.oauth_states;
    RAISE EXCEPTION 'PROOF FAILED [csrf]: a browser session read the OAuth states';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok: a browser session cannot read a token, move the realm, forge a log row or read a CSRF state';
END $$;
RESET ROLE;

-- ── A tech of A ─────────────────────────────────────────────────────────────
SELECT pg_temp.as_user('a0000000-0000-4000-8000-0000000000a2');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.accounting_sync_log)
     OR EXISTS (SELECT 1 FROM public.accounting_connections) THEN
    RAISE EXCEPTION 'PROOF FAILED [office only]: a tech reads the QuickBooks connection or log';
  END IF;
  RAISE NOTICE 'ok: a tech in the same business sees neither';
END $$;
RESET ROLE;

ROLLBACK;
\echo ALL QUICKBOOKS PROOFS PASSED
