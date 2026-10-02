-- Outbound webhooks, proved against a real Postgres rather than read off the
-- migration's text. Run by tests/nothing-could-listen-for-a-completed-visit.test.ts,
-- which passes the migration's path as :migration.
--
-- Everything happens inside one transaction that is ROLLED BACK at the end,
-- the migration included, so this can be pointed at a shared local stack
-- without leaving a table, a trigger, a cron job or a row behind. Each check
-- prints "ok: ..." or raises "PROOF FAILED [...]", and ON_ERROR_STOP turns
-- the first failure into a non-zero exit.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :migration

-- ── Fixture ─────────────────────────────────────────────────────────────────
-- Two tenants. In A: an owner, a technician, and three endpoints — one on
-- every event, one on visit.completed only, one switched off. In B: one
-- endpoint on every event, which A's activity must never reach.
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('a0000000-0000-4000-8000-00000000b001', 'owner-a@webhooks.proof.invalid'),
  ('a0000000-0000-4000-8000-00000000b002', 'tech-a@webhooks.proof.invalid');

INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a000000-0000-4000-8000-0000000000ca', 'Webhook Proof A', 'America/Chicago'),
  ('0b000000-0000-4000-8000-0000000000cb', 'Webhook Proof B', 'America/Chicago');

INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a0000000-0000-4000-8000-00000000b001', '0a000000-0000-4000-8000-0000000000ca', 'owner'),
  ('a0000000-0000-4000-8000-00000000b002', '0a000000-0000-4000-8000-0000000000ca', 'tech');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.webhook_endpoints (id, organization_id, url, events, enabled) VALUES
  ('e0000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-0000000000ca', 'https://hooks.example.com/all',
   ARRAY['client.created','visit.completed','visit.skipped','invoice.created','invoice.paid',
         'payment.received','quote.accepted','quote.declined','lead.created'], true),
  ('e0000000-0000-4000-8000-0000000000a2', '0a000000-0000-4000-8000-0000000000ca', 'https://hooks.example.com/visits',
   ARRAY['visit.completed'], true),
  ('e0000000-0000-4000-8000-0000000000a3', '0a000000-0000-4000-8000-0000000000ca', 'https://hooks.example.com/off',
   ARRAY['client.created','visit.completed','invoice.paid'], false),
  ('e0000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-0000000000cb', 'https://hooks.example.com/b',
   ARRAY['client.created','visit.completed','visit.skipped','invoice.created','invoice.paid',
         'payment.received','quote.accepted','quote.declined','lead.created'], true);
INSERT INTO public.webhook_endpoint_secrets (endpoint_id, secret_ciphertext) VALUES
  ('e0000000-0000-4000-8000-0000000000a1', 'v1.aaaa.bbbb.cccc');

-- How many deliveries an endpoint has of one type.
CREATE FUNCTION pg_temp.n(_ep text, _type text) RETURNS integer LANGUAGE sql AS $$
  SELECT count(*)::integer FROM public.webhook_deliveries
   WHERE endpoint_id = ('e0000000-0000-4000-8000-0000000000' || _ep)::uuid AND event_type = _type
$$;

-- ── client.created ──────────────────────────────────────────────────────────
INSERT INTO public.clients (id, organization_id, account_type, display_name, first_name, last_name,
                            primary_email, primary_phone, notes) VALUES
  ('c0000000-0000-4000-8000-0000000000c1', '0a000000-0000-4000-8000-0000000000ca', 'residential',
   'Proof Client A', 'Proof', 'Client', 'client-a@webhooks.proof.invalid', '+15555550101',
   'SECRET-NOTE-do-not-send');
INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('c0000000-0000-4000-8000-0000000000c2', '0b000000-0000-4000-8000-0000000000cb', 'residential', 'Proof Client B');

DO $$
DECLARE _p jsonb;
BEGIN
  IF pg_temp.n('a1', 'client.created') <> 1 OR pg_temp.n('a2', 'client.created') <> 0
     OR pg_temp.n('a3', 'client.created') <> 0 OR pg_temp.n('b1', 'client.created') <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [client.created]: a1=% a2=% a3=% b1=%', pg_temp.n('a1', 'client.created'),
      pg_temp.n('a2', 'client.created'), pg_temp.n('a3', 'client.created'), pg_temp.n('b1', 'client.created');
  END IF;
  SELECT payload INTO _p FROM public.webhook_deliveries
   WHERE endpoint_id = 'e0000000-0000-4000-8000-0000000000a1' AND event_type = 'client.created';
  IF _p->>'type' <> 'client.created' OR _p->>'organization_id' <> '0a000000-0000-4000-8000-0000000000ca'
     OR _p->'data'->>'client_id' <> 'c0000000-0000-4000-8000-0000000000c1'
     OR _p->'data'->>'display_name' <> 'Proof Client A' OR NOT (_p ? 'id') OR NOT (_p ? 'created_at') THEN
    RAISE EXCEPTION 'PROOF FAILED [client payload shape]: %', _p;
  END IF;
  IF _p::text ~ '(client-a@|5555550101|SECRET-NOTE|portal_token|referral_code)' THEN
    RAISE EXCEPTION 'PROOF FAILED [client payload leaks]: %', _p;
  END IF;
  RAISE NOTICE 'ok: client.created reaches subscribed, enabled endpoints of the same organization only, and carries no email, phone or notes';
END $$;

-- ── visit.completed / visit.skipped ─────────────────────────────────────────
INSERT INTO public.properties (id, client_id, organization_id, street, city, postal_code, gate_code, access_notes) VALUES
  ('d0000000-0000-4000-8000-0000000000d1', 'c0000000-0000-4000-8000-0000000000c1',
   '0a000000-0000-4000-8000-0000000000ca', '1 Proof St', 'Proofville', '60601', 'GATE-4321', 'ACCESS-dog-bites');
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency, price_cents, dog_count) VALUES
  ('5b000000-0000-4000-8000-0000000000e1', '0a000000-0000-4000-8000-0000000000ca',
   'c0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000d1', 'residential', 'weekly', 2000, 2);
INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id, scheduled_on, status) VALUES
  ('f0000000-0000-4000-8000-0000000000f1', '0a000000-0000-4000-8000-0000000000ca', '5b000000-0000-4000-8000-0000000000e1',
   'c0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000d1', current_date, 'scheduled'),
  ('f0000000-0000-4000-8000-0000000000f2', '0a000000-0000-4000-8000-0000000000ca', '5b000000-0000-4000-8000-0000000000e1',
   'c0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000d1', current_date + 7, 'scheduled');

DO $$
DECLARE _p jsonb; _e1 uuid; _e2 uuid;
BEGIN
  -- Not transitions to completed or skipped: nothing.
  UPDATE public.visits SET sequence = 3 WHERE id = 'f0000000-0000-4000-8000-0000000000f1';
  UPDATE public.visits SET status = 'in_progress', started_at = now() WHERE id = 'f0000000-0000-4000-8000-0000000000f1';
  IF (SELECT count(*) FROM public.webhook_deliveries WHERE event_type LIKE 'visit.%') <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [visit noise]: an edit or in_progress emitted a visit event';
  END IF;

  UPDATE public.visits SET status = 'completed', completed_at = now(),
         tech_note = 'TECHNOTE-code-is-1234', gate_reply = 'enter'
   WHERE id = 'f0000000-0000-4000-8000-0000000000f1';
  IF pg_temp.n('a1', 'visit.completed') <> 1 OR pg_temp.n('a2', 'visit.completed') <> 1
     OR pg_temp.n('a3', 'visit.completed') <> 0 OR pg_temp.n('b1', 'visit.completed') <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [visit.completed fan-out]';
  END IF;
  SELECT event_id INTO _e1 FROM public.webhook_deliveries WHERE endpoint_id = 'e0000000-0000-4000-8000-0000000000a1' AND event_type = 'visit.completed';
  SELECT event_id INTO _e2 FROM public.webhook_deliveries WHERE endpoint_id = 'e0000000-0000-4000-8000-0000000000a2' AND event_type = 'visit.completed';
  IF _e1 IS DISTINCT FROM _e2 THEN
    RAISE EXCEPTION 'PROOF FAILED [event id]: one event reached two endpoints with two ids';
  END IF;

  -- Editing a completed visit, or completing it again, is not a new event.
  UPDATE public.visits SET tech_note = 'edited' WHERE id = 'f0000000-0000-4000-8000-0000000000f1';
  UPDATE public.visits SET status = 'completed' WHERE id = 'f0000000-0000-4000-8000-0000000000f1';
  IF pg_temp.n('a1', 'visit.completed') <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [visit.completed twice]: %', pg_temp.n('a1', 'visit.completed');
  END IF;

  SELECT payload INTO _p FROM public.webhook_deliveries WHERE endpoint_id = 'e0000000-0000-4000-8000-0000000000a1' AND event_type = 'visit.completed';
  IF _p->'data'->>'visit_id' <> 'f0000000-0000-4000-8000-0000000000f1' OR _p->'data'->>'client_name' <> 'Proof Client A'
     OR _p->'data'->>'status' <> 'completed' OR (_p->'data'->>'completed_at') IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [visit payload shape]: %', _p;
  END IF;
  IF _p::text ~ '(TECHNOTE|GATE-4321|ACCESS-dog|Proof St|gate_reply|"enter")' THEN
    RAISE EXCEPTION 'PROOF FAILED [visit payload leaks]: %', _p;
  END IF;

  UPDATE public.visits SET status = 'skipped', skipped_at = now(), skip_reason = 'SKIPTEXT-private'
   WHERE id = 'f0000000-0000-4000-8000-0000000000f2';
  IF pg_temp.n('a1', 'visit.skipped') <> 1 OR pg_temp.n('a2', 'visit.skipped') <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [visit.skipped]: a1=% a2=%', pg_temp.n('a1', 'visit.skipped'), pg_temp.n('a2', 'visit.skipped');
  END IF;
  IF (SELECT payload::text FROM public.webhook_deliveries WHERE event_type = 'visit.skipped') LIKE '%SKIPTEXT%' THEN
    RAISE EXCEPTION 'PROOF FAILED [skip reason leaks]';
  END IF;
  RAISE NOTICE 'ok: visits emit only on the move TO completed or skipped, once, with one event id, and no notes or gate details';
END $$;

-- ── invoice.created / invoice.paid ──────────────────────────────────────────
DO $$
BEGIN
  INSERT INTO public.invoices (id, organization_id, client_id, period_end, number, status, total_cents, subtotal_cents,
                               checkout_url)
  VALUES ('10000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-0000000000ca',
          'c0000000-0000-4000-8000-0000000000c1', current_date, 0, 'draft', 4000, 4000,
          'https://checkout.example.com/CHECKOUT-secret');
  IF pg_temp.n('a1', 'invoice.created') <> 1 OR pg_temp.n('a1', 'invoice.paid') <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [invoice.created]';
  END IF;
  UPDATE public.invoices SET status = 'open', issued_at = now() WHERE id = '10000000-0000-4000-8000-0000000000a1';
  IF pg_temp.n('a1', 'invoice.paid') <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [invoice open]: draft to open emitted invoice.paid';
  END IF;
  UPDATE public.invoices SET status = 'paid', paid_at = now() WHERE id = '10000000-0000-4000-8000-0000000000a1';
  UPDATE public.invoices SET notes = 'after' WHERE id = '10000000-0000-4000-8000-0000000000a1';
  IF pg_temp.n('a1', 'invoice.paid') <> 1 OR pg_temp.n('a3', 'invoice.paid') <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [invoice.paid]: %', pg_temp.n('a1', 'invoice.paid');
  END IF;

  -- An invoice that is born paid (a cash sale recorded after the fact) is
  -- both created and paid.
  INSERT INTO public.invoices (id, organization_id, client_id, period_end, number, status, total_cents, subtotal_cents, paid_at)
  VALUES ('10000000-0000-4000-8000-0000000000a2', '0a000000-0000-4000-8000-0000000000ca',
          'c0000000-0000-4000-8000-0000000000c1', current_date, 0, 'paid', 1500, 1500, now());
  IF pg_temp.n('a1', 'invoice.created') <> 2 OR pg_temp.n('a1', 'invoice.paid') <> 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [born paid]: created=% paid=%', pg_temp.n('a1', 'invoice.created'), pg_temp.n('a1', 'invoice.paid');
  END IF;
  IF (SELECT bool_or(payload::text ~ '(CHECKOUT-secret|public_token|stripe)') FROM public.webhook_deliveries
       WHERE event_type LIKE 'invoice.%') THEN
    RAISE EXCEPTION 'PROOF FAILED [invoice payload leaks]';
  END IF;
  RAISE NOTICE 'ok: invoice.created on insert, invoice.paid only on the move to paid (or born paid), and no checkout link or token';
END $$;

-- ── payment.received ────────────────────────────────────────────────────────
DO $$
BEGIN
  INSERT INTO public.payments (id, organization_id, invoice_id, amount_cents, status, raw_event, stripe_payment_intent_id)
  VALUES ('20000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-0000000000ca',
          '10000000-0000-4000-8000-0000000000a1', 4000, 'pending',
          '{"card":{"last4":"4242","brand":"visa"}}', 'pi_SECRET');
  IF pg_temp.n('a1', 'payment.received') <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [pending payment]: emitted payment.received';
  END IF;
  UPDATE public.payments SET status = 'succeeded', paid_at = now() WHERE id = '20000000-0000-4000-8000-0000000000a1';
  UPDATE public.payments SET currency = 'usd' WHERE id = '20000000-0000-4000-8000-0000000000a1';
  INSERT INTO public.payments (id, organization_id, invoice_id, amount_cents, status, method, reference, paid_at)
  VALUES ('20000000-0000-4000-8000-0000000000a2', '0a000000-0000-4000-8000-0000000000ca',
          '10000000-0000-4000-8000-0000000000a2', 1500, 'succeeded', 'check', 'REF-check-991', now());
  IF pg_temp.n('a1', 'payment.received') <> 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [payment.received]: %', pg_temp.n('a1', 'payment.received');
  END IF;
  IF (SELECT bool_or(payload::text ~ '(4242|visa|pi_SECRET|REF-check|raw_event)') FROM public.webhook_deliveries
       WHERE event_type = 'payment.received') THEN
    RAISE EXCEPTION 'PROOF FAILED [payment payload leaks card, Stripe or reference data]';
  END IF;
  IF (SELECT payload->'data'->>'client_id' FROM public.webhook_deliveries
       WHERE event_type = 'payment.received' AND payload->'data'->>'payment_id' = '20000000-0000-4000-8000-0000000000a1')
     <> 'c0000000-0000-4000-8000-0000000000c1' THEN
    RAISE EXCEPTION 'PROOF FAILED [payment payload]: no client_id from the invoice';
  END IF;
  RAISE NOTICE 'ok: payment.received on the move to succeeded or a succeeded insert, once, with no card, Stripe or reference data';
END $$;

-- ── quote.accepted / quote.declined ─────────────────────────────────────────
DO $$
DECLARE _t uuid;
BEGIN
  INSERT INTO public.quotes (id, organization_id, client_id, title, valid_until, number, prospect_email) VALUES
    ('30000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-0000000000ca',
     'c0000000-0000-4000-8000-0000000000c1', 'Weekly service', current_date + 30, 0, NULL);
  INSERT INTO public.quotes (id, organization_id, prospect_name, prospect_email, title, valid_until, number) VALUES
    ('30000000-0000-4000-8000-0000000000a2', '0a000000-0000-4000-8000-0000000000ca',
     'Oak HOA', 'PROSPECT@webhooks.proof.invalid', 'Common areas', current_date + 30, 0);
  INSERT INTO public.quote_line_items (quote_id, description, quantity, unit_amount_cents, amount_cents, recurring, sort) VALUES
    ('30000000-0000-4000-8000-0000000000a1', 'Initial cleanup', 1, 12000, 12000, false, 0),
    ('30000000-0000-4000-8000-0000000000a1', 'Weekly visit', 1, 2400, 2400, true, 1);
  UPDATE public.quotes SET status = 'sent', sent_at = now()
   WHERE id IN ('30000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000000a2');
  IF (SELECT count(*) FROM public.webhook_deliveries WHERE event_type LIKE 'quote.%') <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [quote sent]: sending a quote emitted an answer event';
  END IF;

  SELECT public_token INTO _t FROM public.quotes WHERE id = '30000000-0000-4000-8000-0000000000a1';
  PERFORM public.public_quote_respond(_t, true, 'Jane Customer', NULL);
  PERFORM public.public_quote_respond(_t, true, 'Jane Customer', NULL); -- the second tap
  SELECT public_token INTO _t FROM public.quotes WHERE id = '30000000-0000-4000-8000-0000000000a2';
  PERFORM public.public_quote_respond(_t, false, NULL, 'DECLINE-reason-private');

  IF pg_temp.n('a1', 'quote.accepted') <> 1 OR pg_temp.n('a1', 'quote.declined') <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [quote answers]: accepted=% declined=%',
      pg_temp.n('a1', 'quote.accepted'), pg_temp.n('a1', 'quote.declined');
  END IF;
  IF (SELECT (payload->'data'->>'one_time_cents')::int FROM public.webhook_deliveries WHERE event_type = 'quote.accepted') <> 12000
     OR (SELECT (payload->'data'->>'recurring_cents')::int FROM public.webhook_deliveries WHERE event_type = 'quote.accepted') <> 2400 THEN
    RAISE EXCEPTION 'PROOF FAILED [quote totals]';
  END IF;
  IF (SELECT bool_or(payload::text ~ '(PROSPECT@|DECLINE-reason|public_token)') FROM public.webhook_deliveries
       WHERE event_type LIKE 'quote.%') THEN
    RAISE EXCEPTION 'PROOF FAILED [quote payload leaks]';
  END IF;
  RAISE NOTICE 'ok: quote.accepted and quote.declined once each, from the customer''s own link, with totals and no email, reason or token';
END $$;

-- ── lead.created ────────────────────────────────────────────────────────────
DO $$
BEGIN
  INSERT INTO public.leads (id, organization_id, name, email, phone, location, message, source, status) VALUES
    ('40000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-0000000000ca', 'Lead Person',
     'LEAD@webhooks.proof.invalid', '+15555550199', 'LEADSTREET 9', 'LEADMESSAGE', 'website', 'new');
  INSERT INTO public.leads (name, email, source, status) VALUES ('Nobody''s lead', 'x@webhooks.proof.invalid', 'website', 'new');
  IF pg_temp.n('a1', 'lead.created') <> 1 OR pg_temp.n('b1', 'lead.created') <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [lead.created]: %', pg_temp.n('a1', 'lead.created');
  END IF;
  IF (SELECT payload::text FROM public.webhook_deliveries WHERE event_type = 'lead.created') ~ '(LEAD@|5555550199|LEADSTREET|LEADMESSAGE)' THEN
    RAISE EXCEPTION 'PROOF FAILED [lead payload leaks]';
  END IF;
  RAISE NOTICE 'ok: lead.created for a lead that belongs to an organization, with no email, phone, address or message';
END $$;

-- ── A webhook failure never blocks the business write ───────────────────────
DO $$
DECLARE _before integer;
BEGIN
  SELECT count(*) INTO _before FROM public.webhook_deliveries;
  ALTER TABLE public.webhook_deliveries ADD CONSTRAINT proof_refuse_everything CHECK (false) NOT VALID;
  INSERT INTO public.clients (organization_id, account_type, display_name)
  VALUES ('0a000000-0000-4000-8000-0000000000ca', 'residential', 'Written anyway');
  IF NOT EXISTS (SELECT 1 FROM public.clients WHERE display_name = 'Written anyway') THEN
    RAISE EXCEPTION 'PROOF FAILED [isolation]: the client write did not happen';
  END IF;
  IF (SELECT count(*) FROM public.webhook_deliveries) <> _before THEN
    RAISE EXCEPTION 'PROOF FAILED [isolation]: a delivery was written past an impossible CHECK';
  END IF;
  ALTER TABLE public.webhook_deliveries DROP CONSTRAINT proof_refuse_everything;
  RAISE NOTICE 'ok: an outbox that refuses the insert costs a WARNING, not the client';
END $$;

-- ── Claim, record, retry, switch off ────────────────────────────────────────
DO $$
DECLARE _r record; _n integer; _res jsonb; _d uuid; _i integer;
BEGIN
  -- Only the endpoint with a secret row is claimable with its secret; the
  -- switched-off endpoint has nothing queued at all.
  SELECT count(*) INTO _n FROM public.webhook_claim_deliveries(100, 120);
  IF _n <> (SELECT count(*) FROM public.webhook_deliveries d JOIN public.webhook_endpoints e ON e.id = d.endpoint_id
             WHERE e.enabled AND d.status = 'pending') THEN
    RAISE EXCEPTION 'PROOF FAILED [claim]: claimed % of the due rows', _n;
  END IF;
  IF EXISTS (SELECT 1 FROM public.webhook_deliveries WHERE status = 'pending' AND (attempts <> 1 OR next_attempt_at <= now())) THEN
    RAISE EXCEPTION 'PROOF FAILED [lease]: a claimed row has the wrong attempt count or no lease';
  END IF;
  SELECT count(*) INTO _n FROM public.webhook_claim_deliveries(100, 120);
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [lease]: % leased rows were claimed twice', _n;
  END IF;

  -- A retryable failure goes back to pending at the time it was given.
  SELECT id INTO _d FROM public.webhook_deliveries
   WHERE endpoint_id = 'e0000000-0000-4000-8000-0000000000a1' AND event_type = 'client.created';
  _res := public.webhook_record_attempt(_d, false, false, now() + interval '5 minutes', 500, 'HTTP 500', 5);
  IF (SELECT status || '/' || (next_attempt_at = now() + interval '5 minutes')::text || '/' || last_status_code
        FROM public.webhook_deliveries WHERE id = _d) <> 'pending/true/500'
     OR (SELECT consecutive_failures FROM public.webhook_endpoints WHERE id = 'e0000000-0000-4000-8000-0000000000a1') <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [retry]: %', _res;
  END IF;

  -- Four deliveries end failed: counted, still on.
  _i := 0;
  FOR _r IN SELECT id FROM public.webhook_deliveries
             WHERE endpoint_id = 'e0000000-0000-4000-8000-0000000000a1' AND status = 'pending' ORDER BY created_at, id LIMIT 4 LOOP
    _res := public.webhook_record_attempt(_r.id, false, true, NULL, 503, 'HTTP 503', 5);
    _i := _i + 1;
    IF (_res->>'disabled_now')::boolean THEN
      RAISE EXCEPTION 'PROOF FAILED [disable early]: switched off after % failures', _i;
    END IF;
  END LOOP;
  IF (SELECT consecutive_failures || '/' || enabled FROM public.webhook_endpoints
       WHERE id = 'e0000000-0000-4000-8000-0000000000a1') <> '4/true' THEN
    RAISE EXCEPTION 'PROOF FAILED [count]: %', (SELECT consecutive_failures FROM public.webhook_endpoints WHERE id = 'e0000000-0000-4000-8000-0000000000a1');
  END IF;

  -- A failed TEST does not count.
  INSERT INTO public.webhook_deliveries (organization_id, endpoint_id, event_id, event_type, payload)
  VALUES ('0a000000-0000-4000-8000-0000000000ca', 'e0000000-0000-4000-8000-0000000000a1', gen_random_uuid(), 'webhook.test', '{}')
  RETURNING id INTO _d;
  _res := public.webhook_record_attempt(_d, false, true, NULL, 500, 'HTTP 500', 5);
  IF (SELECT consecutive_failures FROM public.webhook_endpoints WHERE id = 'e0000000-0000-4000-8000-0000000000a1') <> 4 THEN
    RAISE EXCEPTION 'PROOF FAILED [test counted]';
  END IF;

  -- The fifth switches it off, and says so exactly once.
  SELECT id INTO _d FROM public.webhook_deliveries
   WHERE endpoint_id = 'e0000000-0000-4000-8000-0000000000a1' AND status = 'pending' ORDER BY created_at, id LIMIT 1;
  _res := public.webhook_record_attempt(_d, false, true, NULL, 503, 'HTTP 503', 5);
  IF NOT (_res->>'disabled_now')::boolean OR (_res->>'consecutive_failures')::int <> 5 THEN
    RAISE EXCEPTION 'PROOF FAILED [disable]: %', _res;
  END IF;
  IF (SELECT enabled OR disabled_at IS NULL OR disabled_reason NOT LIKE '%5 deliveries in a row%'
        FROM public.webhook_endpoints WHERE id = 'e0000000-0000-4000-8000-0000000000a1') THEN
    RAISE EXCEPTION 'PROOF FAILED [disabled state]';
  END IF;
  SELECT id INTO _d FROM public.webhook_deliveries
   WHERE endpoint_id = 'e0000000-0000-4000-8000-0000000000a1' AND status = 'pending' ORDER BY created_at, id LIMIT 1;
  _res := public.webhook_record_attempt(_d, false, true, NULL, 503, 'HTTP 503', 5);
  IF (_res->>'disabled_now')::boolean THEN
    RAISE EXCEPTION 'PROOF FAILED [notify twice]: a failure after the switch-off reported disabled_now again';
  END IF;

  -- Nothing new is queued for it, and nothing it has is claimed ...
  UPDATE public.webhook_deliveries SET next_attempt_at = now() - interval '1 second'
   WHERE endpoint_id = 'e0000000-0000-4000-8000-0000000000a1' AND status = 'pending';
  INSERT INTO public.clients (organization_id, account_type, display_name)
  VALUES ('0a000000-0000-4000-8000-0000000000ca', 'residential', 'After switch-off');
  IF pg_temp.n('a1', 'client.created') <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [disabled enqueue]: a switched-off endpoint was given a new event';
  END IF;
  IF EXISTS (SELECT 1 FROM public.webhook_claim_deliveries(100, 120) WHERE endpoint_id = 'e0000000-0000-4000-8000-0000000000a1') THEN
    RAISE EXCEPTION 'PROOF FAILED [disabled claim]: the worker claimed a switched-off endpoint''s delivery';
  END IF;
  -- ... except by the test button, which asks for one row by id.
  SELECT id INTO _d FROM public.webhook_deliveries
   WHERE endpoint_id = 'e0000000-0000-4000-8000-0000000000a1' AND status = 'pending' LIMIT 1;
  IF NOT EXISTS (SELECT 1 FROM public.webhook_claim_deliveries(1, 120, _d) WHERE delivery_id = _d AND secret_ciphertext = 'v1.aaaa.bbbb.cccc') THEN
    RAISE EXCEPTION 'PROOF FAILED [claim one]: the test path could not claim its row, or got no secret';
  END IF;

  -- Switching it back on starts clean; a success resets the count.
  UPDATE public.webhook_endpoints SET enabled = true WHERE id = 'e0000000-0000-4000-8000-0000000000a1';
  IF (SELECT consecutive_failures <> 0 OR disabled_at IS NOT NULL OR disabled_reason IS NOT NULL
        FROM public.webhook_endpoints WHERE id = 'e0000000-0000-4000-8000-0000000000a1') THEN
    RAISE EXCEPTION 'PROOF FAILED [re-enable]: the counters survived switching back on';
  END IF;
  UPDATE public.webhook_endpoints SET consecutive_failures = 3 WHERE id = 'e0000000-0000-4000-8000-0000000000a1';
  _res := public.webhook_record_attempt(_d, true, true, NULL, 200, NULL, 5);
  IF (SELECT consecutive_failures FROM public.webhook_endpoints WHERE id = 'e0000000-0000-4000-8000-0000000000a1') <> 0
     OR (SELECT status FROM public.webhook_deliveries WHERE id = _d) <> 'succeeded' THEN
    RAISE EXCEPTION 'PROOF FAILED [success resets]';
  END IF;
  RAISE NOTICE 'ok: claims lease rows once, retries go back on the schedule given, the fifth failed delivery switches the endpoint off and says so once, a test never counts, and switching back on starts clean';
END $$;

-- ── Who can see and touch what ──────────────────────────────────────────────
SET ROLE anon;
DO $$
DECLARE _err text;
BEGIN
  BEGIN PERFORM 1 FROM public.webhook_endpoints; EXCEPTION WHEN insufficient_privilege THEN _err := 'denied'; END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [anon]: read webhook_endpoints'; END IF;
  _err := NULL;
  BEGIN PERFORM 1 FROM public.webhook_deliveries; EXCEPTION WHEN insufficient_privilege THEN _err := 'denied'; END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [anon]: read webhook_deliveries'; END IF;
  _err := NULL;
  BEGIN PERFORM public.webhook_enqueue('0a000000-0000-4000-8000-0000000000ca', 'client.created', '{}'); EXCEPTION WHEN insufficient_privilege THEN _err := 'denied'; END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [anon]: called webhook_enqueue'; END IF;
  RAISE NOTICE 'ok: anon can read neither table and call nothing';
END $$;
RESET ROLE;

SET LOCAL request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-00000000b001","role":"authenticated"}';
SET ROLE authenticated;
DO $$
DECLARE _err text; _n integer;
BEGIN
  SELECT count(*) INTO _n FROM public.webhook_endpoints;
  IF _n <> 3 THEN RAISE EXCEPTION 'PROOF FAILED [owner reads]: sees % endpoints, expected A''s 3', _n; END IF;
  SELECT count(*) INTO _n FROM public.webhook_deliveries WHERE organization_id <> '0a000000-0000-4000-8000-0000000000ca';
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [owner reads]: sees % of B''s deliveries', _n; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.webhook_deliveries) THEN
    RAISE EXCEPTION 'PROOF FAILED [owner reads]: sees none of A''s deliveries';
  END IF;

  UPDATE public.webhook_endpoints SET description = 'Zapier', events = ARRAY['lead.created'], enabled = false
   WHERE id = 'e0000000-0000-4000-8000-0000000000a2';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED [owner edits]: could not edit description, events, enabled'; END IF;

  BEGIN
    UPDATE public.webhook_endpoints SET url = 'https://169.254.169.254/' WHERE id = 'e0000000-0000-4000-8000-0000000000a2';
  EXCEPTION WHEN insufficient_privilege THEN _err := 'denied';
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [owner url]: rewrote a URL around the SSRF check'; END IF;
  _err := NULL;
  BEGIN
    INSERT INTO public.webhook_endpoints (organization_id, url, events)
    VALUES ('0a000000-0000-4000-8000-0000000000ca', 'https://127.0.0.1/', ARRAY['lead.created']);
  EXCEPTION WHEN insufficient_privilege THEN _err := 'denied';
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [owner insert]: created an endpoint around the SSRF check'; END IF;
  _err := NULL;
  BEGIN PERFORM 1 FROM public.webhook_endpoint_secrets; EXCEPTION WHEN insufficient_privilege THEN _err := 'denied'; END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [owner secret]: read the secrets table'; END IF;
  _err := NULL;
  BEGIN
    INSERT INTO public.webhook_deliveries (organization_id, endpoint_id, event_id, event_type, payload)
    VALUES ('0a000000-0000-4000-8000-0000000000ca', 'e0000000-0000-4000-8000-0000000000a1', gen_random_uuid(), 'webhook.test', '{}');
  EXCEPTION WHEN insufficient_privilege THEN _err := 'denied';
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [owner outbox]: wrote to the outbox'; END IF;
  _err := NULL;
  BEGIN PERFORM public.webhook_claim_deliveries(10, 120); EXCEPTION WHEN insufficient_privilege THEN _err := 'denied'; END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [owner claim]: claimed deliveries, secrets and all'; END IF;

  DELETE FROM public.webhook_endpoints WHERE id = 'e0000000-0000-4000-8000-0000000000b1';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [owner delete]: deleted another tenant''s endpoint'; END IF;
  DELETE FROM public.webhook_endpoints WHERE id = 'e0000000-0000-4000-8000-0000000000a3';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED [owner delete]: could not delete their own endpoint'; END IF;
  RAISE NOTICE 'ok: the owner reads and edits their own endpoints, cannot create one or move its URL, and cannot read a secret, write the outbox or claim';
END $$;
RESET ROLE;

SET LOCAL request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-00000000b002","role":"authenticated"}';
SET ROLE authenticated;
DO $$
DECLARE _n integer;
BEGIN
  SELECT count(*) INTO _n FROM public.webhook_endpoints;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [tech reads]: a technician sees % endpoints', _n; END IF;
  SELECT count(*) INTO _n FROM public.webhook_deliveries;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [tech reads]: a technician sees % deliveries', _n; END IF;
  UPDATE public.webhook_endpoints SET enabled = false WHERE id = 'e0000000-0000-4000-8000-0000000000a1';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [tech edits]: a technician switched an endpoint off'; END IF;
  RAISE NOTICE 'ok: a technician in the same organization sees and changes nothing';
END $$;
RESET ROLE;

-- ── The plaintext guard and the schedule ────────────────────────────────────
DO $$
DECLARE _err text;
BEGIN
  BEGIN
    INSERT INTO public.webhook_endpoint_secrets (endpoint_id, secret_ciphertext)
    VALUES ('e0000000-0000-4000-8000-0000000000a2', 'whsec_plaintext');
  EXCEPTION WHEN check_violation THEN _err := 'refused';
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [plaintext]: the database stored a plaintext secret'; END IF;
  _err := NULL;
  BEGIN
    INSERT INTO public.webhook_endpoints (organization_id, url, events)
    VALUES ('0a000000-0000-4000-8000-0000000000ca', 'http://hooks.example.com/', ARRAY['lead.created']);
  EXCEPTION WHEN check_violation THEN _err := 'refused';
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [https]: the database stored an http URL'; END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'deliver-webhooks' AND schedule = '* * * * *'
                    AND command LIKE '%https://app.houndstack.com/api/public/hooks/webhook-deliveries%'
                    AND command LIKE '%cron_service_role_key%') THEN
      RAISE EXCEPTION 'PROOF FAILED [schedule]: deliver-webhooks is not scheduled every minute at the canonical host';
    END IF;
  ELSE
    RAISE WARNING 'pg_cron is not installed here, so the schedule was not checked';
  END IF;
  RAISE NOTICE 'ok: the database refuses a plaintext secret and an http URL, and the worker is scheduled every minute';
END $$;

\echo ALL WEBHOOK PROOFS PASSED
ROLLBACK;
