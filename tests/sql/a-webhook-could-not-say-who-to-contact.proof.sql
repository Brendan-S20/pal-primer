-- A webhook's contact details, proved against a real Postgres. Run by
-- tests/a-webhook-could-not-say-who-to-contact.test.ts, which passes this
-- change's migration as :migration and the webhooks migration it builds on
-- as :base.
--
-- One transaction, ROLLED BACK at the end, the migrations included. Each
-- check prints "ok: ..." or raises "PROOF FAILED [...]".

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

-- A stack built before the webhooks migration has no webhook_endpoints to
-- add a column to; apply that one first, inside the same transaction.
SELECT to_regclass('public.webhook_endpoints') IS NULL AS need_base \gset
\if :need_base
\i :base
\endif
\i :migration

SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a000000-0000-4000-8000-0000000000da', 'Contact Proof A', 'America/Chicago'),
  ('0b000000-0000-4000-8000-0000000000db', 'Contact Proof B', 'America/Chicago');
SET LOCAL app.allow_protected_org_write = '';

-- A new endpoint says nothing, without anybody having to decide that.
INSERT INTO public.webhook_endpoints (id, organization_id, url, events) VALUES
  ('e0000000-0000-4000-8000-0000000000d1', '0a000000-0000-4000-8000-0000000000da', 'https://hooks.example.com/a', ARRAY['client.created']),
  ('e0000000-0000-4000-8000-0000000000d2', '0b000000-0000-4000-8000-0000000000db', 'https://hooks.example.com/b', ARRAY['client.created']);

INSERT INTO public.clients (id, organization_id, account_type, display_name, primary_email, primary_phone) VALUES
  ('c0000000-0000-4000-8000-0000000000d1', '0a000000-0000-4000-8000-0000000000da', 'residential', 'Contact A',
   'client-a@contact.proof.invalid', '+15555550301'),
  ('c0000000-0000-4000-8000-0000000000d2', '0b000000-0000-4000-8000-0000000000db', 'residential', 'Contact B',
   'client-b@contact.proof.invalid', '+15555550302');
INSERT INTO public.leads (id, organization_id, name, email, phone, source, status) VALUES
  ('40000000-0000-4000-8000-0000000000d1', '0a000000-0000-4000-8000-0000000000da', 'Lead A',
   'lead-a@contact.proof.invalid', '+15555550303', 'website', 'new');

DO $$
BEGIN
  IF (SELECT include_contact FROM public.webhook_endpoints WHERE id = 'e0000000-0000-4000-8000-0000000000d1') THEN
    RAISE EXCEPTION 'PROOF FAILED [default]: a new endpoint sends contact details';
  END IF;
  IF public.webhook_contact_for('e0000000-0000-4000-8000-0000000000d1', 'c0000000-0000-4000-8000-0000000000d1', NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [default]: contact details returned for an endpoint that did not opt in';
  END IF;
  RAISE NOTICE 'ok: off by default';
END $$;

UPDATE public.webhook_endpoints SET include_contact = true
 WHERE id IN ('e0000000-0000-4000-8000-0000000000d1', 'e0000000-0000-4000-8000-0000000000d2');

DO $$
DECLARE _c jsonb;
BEGIN
  _c := public.webhook_contact_for('e0000000-0000-4000-8000-0000000000d1', 'c0000000-0000-4000-8000-0000000000d1', NULL);
  IF _c IS DISTINCT FROM '{"email": "client-a@contact.proof.invalid", "phone": "+15555550301"}'::jsonb THEN
    RAISE EXCEPTION 'PROOF FAILED [client]: %', _c;
  END IF;
  _c := public.webhook_contact_for('e0000000-0000-4000-8000-0000000000d1', NULL, '40000000-0000-4000-8000-0000000000d1');
  IF _c IS DISTINCT FROM '{"email": "lead-a@contact.proof.invalid", "phone": "+15555550303"}'::jsonb THEN
    RAISE EXCEPTION 'PROOF FAILED [lead]: %', _c;
  END IF;
  RAISE NOTICE 'ok: an endpoint that opted in gets its own client''s and lead''s details';
END $$;

DO $$
BEGIN
  -- B's endpoint asking about A's client, and A's about B's: nothing.
  IF public.webhook_contact_for('e0000000-0000-4000-8000-0000000000d2', 'c0000000-0000-4000-8000-0000000000d1', NULL) IS NOT NULL
     OR public.webhook_contact_for('e0000000-0000-4000-8000-0000000000d1', 'c0000000-0000-4000-8000-0000000000d2', NULL) IS NOT NULL
     OR public.webhook_contact_for('e0000000-0000-4000-8000-0000000000d2', NULL, '40000000-0000-4000-8000-0000000000d1') IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [tenancy]: one business''s endpoint read another''s contact details';
  END IF;
  IF public.webhook_contact_for(gen_random_uuid(), 'c0000000-0000-4000-8000-0000000000d1', NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [tenancy]: an unknown endpoint got an answer';
  END IF;
  RAISE NOTICE 'ok: never across businesses';
END $$;

UPDATE public.webhook_endpoints SET include_contact = false WHERE id = 'e0000000-0000-4000-8000-0000000000d1';
DO $$
BEGIN
  IF public.webhook_contact_for('e0000000-0000-4000-8000-0000000000d1', 'c0000000-0000-4000-8000-0000000000d1', NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [switch off]: still returned after the owner switched it off';
  END IF;
  RAISE NOTICE 'ok: switching it off stops it';
END $$;

SET LOCAL ROLE anon;
DO $$
BEGIN
  PERFORM public.webhook_contact_for('e0000000-0000-4000-8000-0000000000d1', 'c0000000-0000-4000-8000-0000000000d1', NULL);
  RAISE EXCEPTION 'PROOF FAILED [grants]: anon can call webhook_contact_for';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
RESET ROLE;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM public.webhook_contact_for('e0000000-0000-4000-8000-0000000000d1', 'c0000000-0000-4000-8000-0000000000d1', NULL);
  RAISE EXCEPTION 'PROOF FAILED [grants]: a signed-in user can call webhook_contact_for';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
RESET ROLE;
DO $$ BEGIN RAISE NOTICE 'ok: only the service role can ask'; END $$;

ROLLBACK;
\echo ALL CONTACT PROOFS PASSED
