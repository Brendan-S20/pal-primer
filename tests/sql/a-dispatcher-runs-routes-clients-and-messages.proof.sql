-- A dispatcher runs routes, clients and messages (#728), proved against a real
-- Postgres. Run by tests/a-dispatcher-runs-routes-clients-and-messages.test.ts
-- with :migration. One transaction, ROLLED BACK at the end, the migration
-- included. Each check prints "ok: ..." or raises "PROOF FAILED [...]".
--
-- Business A: an owner, a dispatcher, a technician. Business B: an owner.
-- Each person is tried as the API sees them: role authenticated, the JWT's sub
-- set the way Supabase sets it.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :migration

-- ── Fixture ─────────────────────────────────────────────────────────────────
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('f0000000-0000-4000-8000-0000000d7a01', 'owner-a@dispatch.proof.invalid'),
  ('f0000000-0000-4000-8000-0000000d7a02', 'dispatcher-a@dispatch.proof.invalid'),
  ('f0000000-0000-4000-8000-0000000d7a03', 'tech-a@dispatch.proof.invalid'),
  ('f0000000-0000-4000-8000-0000000d7b01', 'owner-b@dispatch.proof.invalid');
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a000000-0000-4000-8000-0000000d7a00', 'Dispatch Proof A', 'America/Chicago'),
  ('0b000000-0000-4000-8000-0000000d7b00', 'Dispatch Proof B', 'America/Chicago');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('f0000000-0000-4000-8000-0000000d7a01', '0a000000-0000-4000-8000-0000000d7a00', 'owner'),
  ('f0000000-0000-4000-8000-0000000d7a02', '0a000000-0000-4000-8000-0000000d7a00', 'dispatcher'),
  ('f0000000-0000-4000-8000-0000000d7a03', '0a000000-0000-4000-8000-0000000d7a00', 'tech'),
  ('f0000000-0000-4000-8000-0000000d7b01', '0b000000-0000-4000-8000-0000000d7b00', 'owner');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.staff (id, organization_id, user_id, role, display_name, active) VALUES
  ('5a000000-0000-4000-8000-0000000d7a01', '0a000000-0000-4000-8000-0000000d7a00', 'f0000000-0000-4000-8000-0000000d7a01', 'owner', 'Owner A', true),
  ('5a000000-0000-4000-8000-0000000d7a02', '0a000000-0000-4000-8000-0000000d7a00', 'f0000000-0000-4000-8000-0000000d7a02', 'dispatcher', 'Dispatcher A', true),
  ('5a000000-0000-4000-8000-0000000d7a03', '0a000000-0000-4000-8000-0000000d7a00', 'f0000000-0000-4000-8000-0000000d7a03', 'tech', 'Tech A', true),
  ('5b000000-0000-4000-8000-0000000d7b01', '0b000000-0000-4000-8000-0000000d7b00', 'f0000000-0000-4000-8000-0000000d7b01', 'owner', 'Owner B', true);

INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('c0000000-0000-4000-8000-0000000d7a00', '0a000000-0000-4000-8000-0000000d7a00', 'residential', 'Dispatch Client A'),
  ('c0000000-0000-4000-8000-0000000d7b00', '0b000000-0000-4000-8000-0000000d7b00', 'residential', 'Dispatch Client B');
INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code) VALUES
  ('d0000000-0000-4000-8000-0000000d7a00', '0a000000-0000-4000-8000-0000000d7a00', 'c0000000-0000-4000-8000-0000000d7a00', '1 Oak St', 'Springfield', '60614'),
  ('d0000000-0000-4000-8000-0000000d7b00', '0b000000-0000-4000-8000-0000000d7b00', 'c0000000-0000-4000-8000-0000000d7b00', '2 Elm St', 'Shelbyville', '60615');
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency, price_cents, dog_count, started_on) VALUES
  ('e0000000-0000-4000-8000-0000000d7a00', '0a000000-0000-4000-8000-0000000d7a00', 'c0000000-0000-4000-8000-0000000d7a00',
   'd0000000-0000-4000-8000-0000000d7a00', 'residential', 'weekly', 2400, 1, current_date + 1),
  ('e0000000-0000-4000-8000-0000000d7b00', '0b000000-0000-4000-8000-0000000d7b00', 'c0000000-0000-4000-8000-0000000d7b00',
   'd0000000-0000-4000-8000-0000000d7b00', 'residential', 'weekly', 2400, 1, current_date + 1);
INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id, scheduled_on) VALUES
  ('7a000000-0000-4000-8000-0000000d7a00', '0a000000-0000-4000-8000-0000000d7a00', 'e0000000-0000-4000-8000-0000000d7a00',
   'c0000000-0000-4000-8000-0000000d7a00', 'd0000000-0000-4000-8000-0000000d7a00', current_date + 1),
  ('7b000000-0000-4000-8000-0000000d7b00', '0b000000-0000-4000-8000-0000000d7b00', 'e0000000-0000-4000-8000-0000000d7b00',
   'c0000000-0000-4000-8000-0000000d7b00', 'd0000000-0000-4000-8000-0000000d7b00', current_date + 1);

CREATE FUNCTION pg_temp.as_user(_uid text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
           json_build_object('sub', _uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
$$;

-- ── The dispatcher's matrix ─────────────────────────────────────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-0000000d7a02');
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  _me constant uuid := 'f0000000-0000-4000-8000-0000000d7a02';
  _a constant uuid := '0a000000-0000-4000-8000-0000000d7a00';
  _b constant uuid := '0b000000-0000-4000-8000-0000000d7b00';
  _p text;
BEGIN
  FOREACH _p IN ARRAY ARRAY['booking', 'manage_schedule', 'message_clients', 'view_client_directory'] LOOP
    IF NOT public.has_permission(_me, _a, _p) THEN
      RAISE EXCEPTION 'PROOF FAILED [grants]: a dispatcher does not hold %', _p;
    END IF;
    IF public.has_permission(_me, _b, _p) THEN
      RAISE EXCEPTION 'PROOF FAILED [grants]: a dispatcher holds % in another business', _p;
    END IF;
  END LOOP;
  RAISE NOTICE 'ok: a dispatcher holds booking, manage_schedule and message_clients in their own business, and nothing in another';

  FOREACH _p IN ARRAY ARRAY['manage_pricing', 'manage_client_billing', 'view_financials', 'manage_users',
                            'manage_settings', 'manage_org_billing', 'reveal_signin_code', 'send_campaigns'] LOOP
    IF public.has_permission(_me, _a, _p) THEN
      RAISE EXCEPTION 'PROOF FAILED [refusals]: a dispatcher holds %', _p;
    END IF;
  END LOOP;
  RAISE NOTICE 'ok: a dispatcher holds no price, billing, financials, users, settings or campaigns';
END $$;

-- ── A plan, or a price, with the dispatcher's own key: refused ──────────────
DO $$
DECLARE _n int;
BEGIN
  BEGIN
    INSERT INTO public.subscriptions (organization_id, client_id, property_id, account_type, frequency, price_cents, dog_count, started_on)
    VALUES ('0a000000-0000-4000-8000-0000000d7a00', 'c0000000-0000-4000-8000-0000000d7a00',
            'd0000000-0000-4000-8000-0000000d7a00', 'residential', 'weekly', 1, 1, current_date + 1);
    RAISE EXCEPTION 'PROOF FAILED [plan]: a dispatcher wrote a plan at a price they typed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  UPDATE public.subscriptions SET price_cents = 1
   WHERE id = 'e0000000-0000-4000-8000-0000000d7a00';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [plan]: a dispatcher repriced a plan';
  END IF;
  RAISE NOTICE 'ok: a dispatcher cannot write a plan or change its price with their own key';
END $$;

-- ── Routes: a move in their own business, nothing in another ────────────────
DO $$
DECLARE _on date; _n int;
BEGIN
  PERFORM public.reschedule_visit('7a000000-0000-4000-8000-0000000d7a00', current_date + 3);
  SELECT scheduled_on INTO _on FROM public.visits WHERE id = '7a000000-0000-4000-8000-0000000d7a00';
  IF _on IS DISTINCT FROM current_date + 3 THEN
    RAISE EXCEPTION 'PROOF FAILED [move]: a dispatcher could not move their own business''s visit (on %)', _on;
  END IF;

  SELECT count(*) INTO _n FROM public.visits WHERE organization_id = '0b000000-0000-4000-8000-0000000d7b00';
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [tenant]: a dispatcher reads % visit(s) of another business', _n;
  END IF;
  BEGIN
    PERFORM public.reschedule_visit('7b000000-0000-4000-8000-0000000d7b00', current_date + 3);
    RAISE EXCEPTION 'PROOF FAILED [tenant]: a dispatcher moved another business''s visit';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'PROOF FAILED%' THEN RAISE; END IF;
  END;
  UPDATE public.visits SET scheduled_on = current_date + 5
   WHERE id = '7b000000-0000-4000-8000-0000000d7b00';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [tenant]: a dispatcher wrote to another business''s visit';
  END IF;
  RAISE NOTICE 'ok: a dispatcher moves their own business''s visit and cannot read or move another''s';
END $$;

-- ── Messages: to their own client, not to another business's ────────────────
DO $$
BEGIN
  INSERT INTO public.messages (organization_id, client_id, direction, body)
  VALUES ('0a000000-0000-4000-8000-0000000d7a00', 'c0000000-0000-4000-8000-0000000d7a00', 'outbound', 'See you Thursday');
  BEGIN
    INSERT INTO public.messages (organization_id, client_id, direction, body)
    VALUES ('0b000000-0000-4000-8000-0000000d7b00', 'c0000000-0000-4000-8000-0000000d7b00', 'outbound', 'Hello from A');
    RAISE EXCEPTION 'PROOF FAILED [tenant]: a dispatcher wrote a message into another business';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  IF EXISTS (SELECT 1 FROM public.messages WHERE organization_id = '0b000000-0000-4000-8000-0000000d7b00') THEN
    RAISE EXCEPTION 'PROOF FAILED [tenant]: a dispatcher reads another business''s messages';
  END IF;
  RAISE NOTICE 'ok: a dispatcher writes a message to their own client and nothing into another business';
END $$;
RESET ROLE;

-- ── A technician gains nothing ──────────────────────────────────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-0000000d7a03');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF public.has_permission('f0000000-0000-4000-8000-0000000d7a03', '0a000000-0000-4000-8000-0000000d7a00', 'manage_schedule')
     OR public.has_permission('f0000000-0000-4000-8000-0000000d7a03', '0a000000-0000-4000-8000-0000000d7a00', 'message_clients')
     OR public.has_permission('f0000000-0000-4000-8000-0000000d7a03', '0a000000-0000-4000-8000-0000000d7a00', 'booking') THEN
    RAISE EXCEPTION 'PROOF FAILED [tech]: a technician holds a dispatcher permission';
  END IF;
  RAISE NOTICE 'ok: a technician holds none of the dispatcher''s permissions';
END $$;
RESET ROLE;

-- ── Turned off means off, for the new permissions too ───────────────────────
UPDATE public.staff SET active = false WHERE id = '5a000000-0000-4000-8000-0000000d7a02';
SELECT pg_temp.as_user('f0000000-0000-4000-8000-0000000d7a02');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF public.has_permission('f0000000-0000-4000-8000-0000000d7a02', '0a000000-0000-4000-8000-0000000d7a00', 'manage_schedule')
     OR public.has_permission('f0000000-0000-4000-8000-0000000d7a02', '0a000000-0000-4000-8000-0000000d7a00', 'message_clients') THEN
    RAISE EXCEPTION 'PROOF FAILED [off]: a dispatcher who is turned off still holds a permission';
  END IF;
  RAISE NOTICE 'ok: a dispatcher who is turned off holds neither new permission';
END $$;
RESET ROLE;

ROLLBACK;

\echo 'ALL DISPATCHER-PERMISSION PROOFS PASSED'
