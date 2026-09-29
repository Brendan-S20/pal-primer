-- The campaign rules, proved against a real Postgres rather than read off the
-- migration's text. Run by
-- tests/an-unsubscribe-reaches-one-client-in-one-business.test.ts, which
-- passes the migration's path as :migration.
--
-- One transaction, ROLLED BACK at the end with the migration inside it, so a
-- shared local stack is left exactly as it was. Each group prints
-- "ok: ..." or raises "PROOF FAILED [...]"; ON_ERROR_STOP makes the first
-- failure the exit code.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

BEGIN;

\i :migration

-- ── Fixture ─────────────────────────────────────────────────────────────────
-- Business A has a postal address; business B does not. Pat is a client of
-- both, and of A twice (two rows, one inbox).
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('b0000000-0000-4000-8000-00000000b001', 'owner-a@campaigns.proof.invalid'),
  ('b0000000-0000-4000-8000-00000000b002', 'tech-a@campaigns.proof.invalid'),
  ('b0000000-0000-4000-8000-00000000b003', 'owner-b@campaigns.proof.invalid');

INSERT INTO public.organizations (id, name, timezone, contact_address) VALUES
  ('0c000000-0000-4000-8000-0000000000aa', 'Campaign Proof A', 'America/Chicago',
   '1200 W Wilson Ave, Chicago, IL 60640');
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0d000000-0000-4000-8000-0000000000bb', 'Campaign Proof B', 'America/Chicago');

INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('b0000000-0000-4000-8000-00000000b001', '0c000000-0000-4000-8000-0000000000aa', 'owner'),
  ('b0000000-0000-4000-8000-00000000b002', '0c000000-0000-4000-8000-0000000000aa', 'tech'),
  ('b0000000-0000-4000-8000-00000000b003', '0d000000-0000-4000-8000-0000000000bb', 'owner');

INSERT INTO public.clients (id, organization_id, account_type, display_name, primary_email,
                            email_opt_out, comms_paused) VALUES
  ('ca000000-0000-4000-8000-0000000000a1', '0c000000-0000-4000-8000-0000000000aa', 'residential',
   'Pat A', 'pat@campaigns.proof.invalid', false, false),
  ('ca000000-0000-4000-8000-0000000000a2', '0c000000-0000-4000-8000-0000000000aa', 'residential',
   'Opted Out A', 'out@campaigns.proof.invalid', true, false),
  ('ca000000-0000-4000-8000-0000000000a3', '0c000000-0000-4000-8000-0000000000aa', 'residential',
   'Held A', 'held@campaigns.proof.invalid', false, true),
  ('ca000000-0000-4000-8000-0000000000a4', '0c000000-0000-4000-8000-0000000000aa', 'residential',
   'No Email A', NULL, false, false),
  ('ca000000-0000-4000-8000-0000000000a5', '0c000000-0000-4000-8000-0000000000aa', 'residential',
   'Pat A Second House', 'PAT@campaigns.proof.invalid', false, false),
  ('cb000000-0000-4000-8000-0000000000b1', '0d000000-0000-4000-8000-0000000000bb', 'residential',
   'Pat B', 'pat@campaigns.proof.invalid', false, false);
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.email_campaigns (id, organization_id, subject, heading, body) VALUES
  ('e0000000-0000-4000-8000-0000000000a1', '0c000000-0000-4000-8000-0000000000aa',
   'Spring deep clean', 'Spring', 'Twenty dollars off.'),
  ('e0000000-0000-4000-8000-0000000000a2', '0c000000-0000-4000-8000-0000000000aa',
   'Holiday schedule', '', 'No visits on the 25th.'),
  ('e0000000-0000-4000-8000-0000000000b1', '0d000000-0000-4000-8000-0000000000bb',
   'We now serve Oak Park', '', 'Tell your neighbours.');

-- ── Starting: the audience is frozen, and only this tenant's sendable clients ─
DO $$
DECLARE _out text; _ids uuid[]; _c record;
BEGIN
  _out := public.start_email_campaign(
    'e0000000-0000-4000-8000-0000000000a1', '0c000000-0000-4000-8000-0000000000aa',
    'b0000000-0000-4000-8000-00000000b001',
    '[{"client_id":"ca000000-0000-4000-8000-0000000000a1"},
      {"client_id":"ca000000-0000-4000-8000-0000000000a2"},
      {"client_id":"ca000000-0000-4000-8000-0000000000a3"},
      {"client_id":"ca000000-0000-4000-8000-0000000000a4"},
      {"client_id":"ca000000-0000-4000-8000-0000000000a5"},
      {"client_id":"cb000000-0000-4000-8000-0000000000b1"},
      {"client_id":"ca000000-0000-4000-8000-0000000000a1"}]'::jsonb);
  IF _out <> 'started' THEN
    RAISE EXCEPTION 'PROOF FAILED [start]: %', _out;
  END IF;
  SELECT array_agg(client_id ORDER BY client_id) INTO _ids
    FROM public.email_campaign_recipients WHERE campaign_id = 'e0000000-0000-4000-8000-0000000000a1';
  IF _ids <> ARRAY['ca000000-0000-4000-8000-0000000000a1', 'ca000000-0000-4000-8000-0000000000a5']::uuid[] THEN
    RAISE EXCEPTION 'PROOF FAILED [audience]: froze %; expected only A''s two sendable rows, once each', _ids;
  END IF;
  SELECT * INTO _c FROM public.email_campaigns WHERE id = 'e0000000-0000-4000-8000-0000000000a1';
  IF _c.status <> 'sending' OR _c.recipient_count <> 2 OR _c.sent_at IS NULL
     OR _c.sent_by <> 'b0000000-0000-4000-8000-00000000b001' THEN
    RAISE EXCEPTION 'PROOF FAILED [start state]: %', row_to_json(_c);
  END IF;
  RAISE NOTICE 'ok: Send freezes one row per client, never an opted-out, held, address-less or other tenant''s one';
END $$;

-- ── A second press sends nothing ────────────────────────────────────────────
DO $$
DECLARE _out text; _n int;
BEGIN
  _out := public.start_email_campaign(
    'e0000000-0000-4000-8000-0000000000a1', '0c000000-0000-4000-8000-0000000000aa',
    'b0000000-0000-4000-8000-00000000b001',
    '[{"client_id":"ca000000-0000-4000-8000-0000000000a1"}]'::jsonb);
  SELECT count(*) INTO _n FROM public.email_campaign_recipients
   WHERE campaign_id = 'e0000000-0000-4000-8000-0000000000a1';
  IF _out <> 'already_started' OR _n <> 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [double press]: % with % recipients', _out, _n;
  END IF;
  BEGIN
    INSERT INTO public.email_campaign_recipients (campaign_id, organization_id, client_id, email)
    VALUES ('e0000000-0000-4000-8000-0000000000a1', '0c000000-0000-4000-8000-0000000000aa',
            'ca000000-0000-4000-8000-0000000000a1', 'pat@campaigns.proof.invalid');
    RAISE EXCEPTION 'PROOF FAILED [unique]: a client was added to the same campaign twice';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  RAISE NOTICE 'ok: a second press is answered "already started" and a client cannot be a recipient twice';
END $$;

-- ── No postal address, no send ──────────────────────────────────────────────
DO $$
DECLARE _out text; _n int; _s text;
BEGIN
  _out := public.start_email_campaign(
    'e0000000-0000-4000-8000-0000000000b1', '0d000000-0000-4000-8000-0000000000bb',
    'b0000000-0000-4000-8000-00000000b003',
    '[{"client_id":"cb000000-0000-4000-8000-0000000000b1"}]'::jsonb);
  SELECT count(*) INTO _n FROM public.email_campaign_recipients
   WHERE campaign_id = 'e0000000-0000-4000-8000-0000000000b1';
  SELECT status INTO _s FROM public.email_campaigns WHERE id = 'e0000000-0000-4000-8000-0000000000b1';
  IF _out <> 'no_address' OR _n <> 0 OR _s <> 'draft' THEN
    RAISE EXCEPTION 'PROOF FAILED [no address]: %, % recipients, status %', _out, _n, _s;
  END IF;
  RAISE NOTICE 'ok: a business with no postal address cannot start a campaign';
END $$;

-- ── Every other refusal ─────────────────────────────────────────────────────
DO $$
DECLARE _out text; _many jsonb; _s text;
BEGIN
  _out := public.start_email_campaign('e0000000-0000-4000-8000-0000000000a2',
    '0c000000-0000-4000-8000-0000000000aa', 'b0000000-0000-4000-8000-00000000b001', '[]'::jsonb);
  IF _out <> 'no_recipients' THEN RAISE EXCEPTION 'PROOF FAILED [empty]: %', _out; END IF;

  -- Only another tenant's client: joined away to nothing.
  _out := public.start_email_campaign('e0000000-0000-4000-8000-0000000000a2',
    '0c000000-0000-4000-8000-0000000000aa', 'b0000000-0000-4000-8000-00000000b001',
    '[{"client_id":"cb000000-0000-4000-8000-0000000000b1"}]'::jsonb);
  IF _out <> 'no_recipients' THEN RAISE EXCEPTION 'PROOF FAILED [cross-tenant only]: %', _out; END IF;

  SELECT jsonb_agg(jsonb_build_object('client_id', gen_random_uuid())) INTO _many
    FROM generate_series(1, 5001);
  _out := public.start_email_campaign('e0000000-0000-4000-8000-0000000000a2',
    '0c000000-0000-4000-8000-0000000000aa', 'b0000000-0000-4000-8000-00000000b001', _many);
  IF _out <> 'too_many' THEN RAISE EXCEPTION 'PROOF FAILED [cap]: %', _out; END IF;

  -- The right campaign under the wrong organization is not found.
  _out := public.start_email_campaign('e0000000-0000-4000-8000-0000000000a2',
    '0d000000-0000-4000-8000-0000000000bb', 'b0000000-0000-4000-8000-00000000b003',
    '[{"client_id":"cb000000-0000-4000-8000-0000000000b1"}]'::jsonb);
  IF _out <> 'not_found' THEN RAISE EXCEPTION 'PROOF FAILED [wrong org]: %', _out; END IF;

  SELECT status INTO _s FROM public.email_campaigns WHERE id = 'e0000000-0000-4000-8000-0000000000a2';
  IF _s <> 'draft' THEN RAISE EXCEPTION 'PROOF FAILED [refusals]: a refused campaign is %', _s; END IF;
  RAISE NOTICE 'ok: an empty, cross-tenant, over-5,000 or misaddressed start is refused and stays a draft';
END $$;

-- ── The lane is fed a batch at a time, and the campaign settles ─────────────
DO $$
DECLARE _a int; _b int; _c int; _settled int; _s text;
BEGIN
  SELECT count(*) INTO _a FROM public.claim_email_campaign_recipients(1);
  SELECT count(*) INTO _b FROM public.claim_email_campaign_recipients(10);
  SELECT count(*) INTO _c FROM public.claim_email_campaign_recipients(10);
  IF (_a, _b, _c) <> (1, 1, 0) THEN
    RAISE EXCEPTION 'PROOF FAILED [claim]: took %, %, % (a claimed row must not be taken again at once)', _a, _b, _c;
  END IF;
  _settled := public.settle_email_campaigns();
  IF _settled <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [settle early]: a campaign with claimed rows was settled';
  END IF;
  UPDATE public.email_campaign_recipients
     SET status = 'queued', queued_at = now(),
         message_id = CASE client_id WHEN 'ca000000-0000-4000-8000-0000000000a1' THEN 'proof-m-1' ELSE 'proof-m-5' END
   WHERE campaign_id = 'e0000000-0000-4000-8000-0000000000a1';
  _settled := public.settle_email_campaigns();
  SELECT status INTO _s FROM public.email_campaigns WHERE id = 'e0000000-0000-4000-8000-0000000000a1';
  IF _settled <> 1 OR _s <> 'sent' THEN
    RAISE EXCEPTION 'PROOF FAILED [settle]: settled %, status %', _settled, _s;
  END IF;
  RAISE NOTICE 'ok: recipients are claimed a batch at a time and the campaign is sent when none are left';
END $$;

-- ── What happened, from the send log ────────────────────────────────────────
INSERT INTO public.email_send_log (message_id, template_name, recipient_email, status, metadata) VALUES
  ('proof-m-1', 'campaign', 'pat@campaigns.proof.invalid', 'pending', NULL),
  ('proof-m-1', 'campaign', 'pat@campaigns.proof.invalid', 'sent',
   '{"provider":"resend","provider_message_id":"proof-p-1"}'),
  ('proof-p-1', 'resend-webhook', 'pat@campaigns.proof.invalid', 'bounced', NULL),
  ('proof-m-5', 'campaign', 'pat@campaigns.proof.invalid', 'failed', NULL),
  ('proof-m-5', 'campaign', 'pat@campaigns.proof.invalid', 'dlq', NULL);

DO $$
DECLARE _s record;
BEGIN
  SELECT * INTO _s FROM public.email_campaign_stats('0c000000-0000-4000-8000-0000000000aa')
   WHERE campaign_id = 'e0000000-0000-4000-8000-0000000000a1';
  IF _s.recipients <> 2 OR _s.sent <> 1 OR _s.failed <> 1 OR _s.bounced <> 1
     OR _s.waiting <> 0 OR _s.in_queue <> 0 OR _s.skipped <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [stats]: %', row_to_json(_s);
  END IF;
  IF EXISTS (SELECT 1 FROM public.email_campaign_stats('0d000000-0000-4000-8000-0000000000bb')
              WHERE campaign_id = 'e0000000-0000-4000-8000-0000000000a1') THEN
    RAISE EXCEPTION 'PROOF FAILED [stats tenancy]: B can see A''s campaign';
  END IF;
  RAISE NOTICE 'ok: sent, failed and bounced are read from the send log, per organization';
END $$;

-- ── Unsubscribe: one client, one business ───────────────────────────────────
INSERT INTO public.client_unsubscribe_tokens (token, organization_id, client_id) VALUES
  (repeat('a1', 32), '0c000000-0000-4000-8000-0000000000aa', 'ca000000-0000-4000-8000-0000000000a1'),
  (repeat('b1', 32), '0d000000-0000-4000-8000-0000000000bb', 'cb000000-0000-4000-8000-0000000000b1'),
  -- Forged: A's client under B's organization. Must change nothing.
  (repeat('ff', 32), '0d000000-0000-4000-8000-0000000000bb', 'ca000000-0000-4000-8000-0000000000a5');

DO $$
DECLARE _state text; _out text; _a1 bool; _a5 bool; _b1 bool;
BEGIN
  _state := public.client_unsubscribe_token_state(repeat('a1', 32));
  IF _state <> 'ready' THEN RAISE EXCEPTION 'PROOF FAILED [state before]: %', _state; END IF;

  _out := public.redeem_client_unsubscribe_token(repeat('a1', 32));
  SELECT email_opt_out INTO _a1 FROM public.clients WHERE id = 'ca000000-0000-4000-8000-0000000000a1';
  SELECT email_opt_out INTO _a5 FROM public.clients WHERE id = 'ca000000-0000-4000-8000-0000000000a5';
  SELECT email_opt_out INTO _b1 FROM public.clients WHERE id = 'cb000000-0000-4000-8000-0000000000b1';
  IF _out <> 'unsubscribed' OR NOT _a1 THEN
    RAISE EXCEPTION 'PROOF FAILED [unsubscribe]: %, opted out %', _out, _a1;
  END IF;
  IF _b1 THEN
    RAISE EXCEPTION 'PROOF FAILED [scope: org]: unsubscribing from A opted Pat out of B';
  END IF;
  IF _a5 THEN
    RAISE EXCEPTION 'PROOF FAILED [scope: client]: the token opted out a client it was not minted for';
  END IF;
  IF EXISTS (SELECT 1 FROM public.suppressed_emails WHERE email = 'pat@campaigns.proof.invalid') THEN
    RAISE EXCEPTION 'PROOF FAILED [scope: platform]: the address went on the platform-wide suppression list';
  END IF;

  _state := public.client_unsubscribe_token_state(repeat('a1', 32));
  _out := public.redeem_client_unsubscribe_token(repeat('a1', 32));
  IF _state <> 'already' OR _out <> 'already' THEN
    RAISE EXCEPTION 'PROOF FAILED [twice]: state %, redeem %', _state, _out;
  END IF;

  _out := public.redeem_client_unsubscribe_token(repeat('ff', 32));
  SELECT email_opt_out INTO _a5 FROM public.clients WHERE id = 'ca000000-0000-4000-8000-0000000000a5';
  IF _out <> 'invalid' OR _a5 THEN
    RAISE EXCEPTION 'PROOF FAILED [forged]: %, a token naming another business opted its client out %', _out, _a5;
  END IF;
  IF public.client_unsubscribe_token_state(repeat('ff', 32)) <> 'invalid'
     OR public.redeem_client_unsubscribe_token('not-a-token') <> 'invalid'
     OR public.client_unsubscribe_token_state('not-a-token') <> 'invalid' THEN
    RAISE EXCEPTION 'PROOF FAILED [unknown]: an unknown or forged token was not invalid';
  END IF;
  RAISE NOTICE 'ok: an unsubscribe opts out exactly one client in exactly one business, once';
END $$;

-- ── The office, through RLS ─────────────────────────────────────────────────
SET LOCAL request.jwt.claims = '{"sub":"b0000000-0000-4000-8000-00000000b001","role":"authenticated"}';
SET ROLE authenticated;
DO $$
DECLARE _n int; _denied bool;
BEGIN
  SELECT count(*) INTO _n FROM public.email_campaigns;
  IF _n <> 2 THEN RAISE EXCEPTION 'PROOF FAILED [read]: owner A sees % campaigns, expected A''s 2', _n; END IF;

  INSERT INTO public.email_campaigns (organization_id, subject, body)
  VALUES ('0c000000-0000-4000-8000-0000000000aa', 'A new draft', 'Body');

  BEGIN
    INSERT INTO public.email_campaigns (organization_id, subject, body, status, sent_at, sent_by, recipient_count)
    VALUES ('0c000000-0000-4000-8000-0000000000aa', 'Sneaky', 'Body', 'sending', now(),
            'b0000000-0000-4000-8000-00000000b001', 1);
    RAISE EXCEPTION 'PROOF FAILED [insert sending]: the office inserted a campaign already sending';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  UPDATE public.email_campaigns SET subject = 'Rewritten after sending'
   WHERE id = 'e0000000-0000-4000-8000-0000000000a1';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [edit sent]: a sent campaign was edited'; END IF;

  BEGIN
    UPDATE public.email_campaigns SET status = 'sending'
     WHERE id = 'e0000000-0000-4000-8000-0000000000a2';
    RAISE EXCEPTION 'PROOF FAILED [self-start]: the office flipped a draft to sending without start_email_campaign';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL;
  END;

  DELETE FROM public.email_campaigns WHERE id = 'e0000000-0000-4000-8000-0000000000a1';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [delete sent]: a sent campaign was deleted'; END IF;

  UPDATE public.email_campaigns SET subject = 'Holiday hours'
   WHERE id = 'e0000000-0000-4000-8000-0000000000b1';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [cross-tenant edit]: A edited B''s draft'; END IF;

  _denied := false;
  BEGIN PERFORM 1 FROM public.email_campaign_recipients; EXCEPTION WHEN insufficient_privilege THEN _denied := true; END;
  IF NOT _denied THEN RAISE EXCEPTION 'PROOF FAILED [recipients]: authenticated can read recipients'; END IF;
  _denied := false;
  BEGIN PERFORM 1 FROM public.client_unsubscribe_tokens; EXCEPTION WHEN insufficient_privilege THEN _denied := true; END;
  IF NOT _denied THEN RAISE EXCEPTION 'PROOF FAILED [tokens]: authenticated can read unsubscribe tokens'; END IF;
  _denied := false;
  BEGIN
    PERFORM public.start_email_campaign('e0000000-0000-4000-8000-0000000000a2',
      '0c000000-0000-4000-8000-0000000000aa', 'b0000000-0000-4000-8000-00000000b001', '[]'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN _denied := true;
  END;
  IF NOT _denied THEN RAISE EXCEPTION 'PROOF FAILED [start]: authenticated can call start_email_campaign'; END IF;
  _denied := false;
  BEGIN PERFORM public.redeem_client_unsubscribe_token(repeat('b1', 32));
  EXCEPTION WHEN insufficient_privilege THEN _denied := true; END;
  IF NOT _denied THEN RAISE EXCEPTION 'PROOF FAILED [redeem]: authenticated can redeem a token directly'; END IF;
  RAISE NOTICE 'ok: the office writes its own drafts and nothing else, and cannot reach recipients, tokens or the send';
END $$;
RESET ROLE;

-- A technician has no campaigns at all.
SET LOCAL request.jwt.claims = '{"sub":"b0000000-0000-4000-8000-00000000b002","role":"authenticated"}';
SET ROLE authenticated;
DO $$
DECLARE _n int;
BEGIN
  SELECT count(*) INTO _n FROM public.email_campaigns;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [tech read]: a technician sees % campaigns', _n; END IF;
  BEGIN
    INSERT INTO public.email_campaigns (organization_id, subject, body)
    VALUES ('0c000000-0000-4000-8000-0000000000aa', 'From the truck', 'Body');
    RAISE EXCEPTION 'PROOF FAILED [tech write]: a technician wrote a campaign';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok: a technician can neither read nor write a campaign';
END $$;
RESET ROLE;

SET ROLE anon;
DO $$
DECLARE _denied bool := false;
BEGIN
  BEGIN PERFORM 1 FROM public.email_campaigns; EXCEPTION WHEN insufficient_privilege THEN _denied := true; END;
  IF NOT _denied THEN RAISE EXCEPTION 'PROOF FAILED [anon]: anon can read campaigns'; END IF;
  _denied := false;
  BEGIN PERFORM public.client_unsubscribe_token_state(repeat('b1', 32));
  EXCEPTION WHEN insufficient_privilege THEN _denied := true; END;
  IF NOT _denied THEN RAISE EXCEPTION 'PROOF FAILED [anon]: anon can probe unsubscribe tokens'; END IF;
  RAISE NOTICE 'ok: anon reaches nothing; the unsubscribe page goes through the server';
END $$;
RESET ROLE;

\echo ALL CAMPAIGN PROOFS PASSED
ROLLBACK;
