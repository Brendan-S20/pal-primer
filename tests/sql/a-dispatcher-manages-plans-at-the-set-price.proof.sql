-- A dispatcher manages an existing client's plans at the set price (#728),
-- proved against a real Postgres. Run by
-- tests/a-dispatcher-manages-plans-at-the-set-price.test.ts with :migration.
-- One transaction, ROLLED BACK at the end, the migration included. Each check
-- prints "ok: ..." or raises "PROOF FAILED [...]".
--
-- Business A: an owner, a dispatcher, a technician. Business B: an owner.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :migration

-- ── Fixture ─────────────────────────────────────────────────────────────────
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('f0000000-0000-4000-8000-0000000e7a01', 'owner-a@plans.proof.invalid'),
  ('f0000000-0000-4000-8000-0000000e7a02', 'dispatcher-a@plans.proof.invalid'),
  ('f0000000-0000-4000-8000-0000000e7a03', 'tech-a@plans.proof.invalid'),
  ('f0000000-0000-4000-8000-0000000e7b01', 'owner-b@plans.proof.invalid');
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a000000-0000-4000-8000-0000000e7a00', 'Plans Proof A', 'America/Chicago'),
  ('0b000000-0000-4000-8000-0000000e7b00', 'Plans Proof B', 'America/Chicago');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('f0000000-0000-4000-8000-0000000e7a01', '0a000000-0000-4000-8000-0000000e7a00', 'owner'),
  ('f0000000-0000-4000-8000-0000000e7a02', '0a000000-0000-4000-8000-0000000e7a00', 'dispatcher'),
  ('f0000000-0000-4000-8000-0000000e7a03', '0a000000-0000-4000-8000-0000000e7a00', 'tech'),
  ('f0000000-0000-4000-8000-0000000e7b01', '0b000000-0000-4000-8000-0000000e7b00', 'owner');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.staff (id, organization_id, user_id, role, display_name, active) VALUES
  ('5a000000-0000-4000-8000-0000000e7a01', '0a000000-0000-4000-8000-0000000e7a00', 'f0000000-0000-4000-8000-0000000e7a01', 'owner', 'Owner A', true),
  ('5a000000-0000-4000-8000-0000000e7a02', '0a000000-0000-4000-8000-0000000e7a00', 'f0000000-0000-4000-8000-0000000e7a02', 'dispatcher', 'Dispatcher A', true),
  ('5a000000-0000-4000-8000-0000000e7a03', '0a000000-0000-4000-8000-0000000e7a00', 'f0000000-0000-4000-8000-0000000e7a03', 'tech', 'Tech A', true),
  ('5b000000-0000-4000-8000-0000000e7b01', '0b000000-0000-4000-8000-0000000e7b00', 'f0000000-0000-4000-8000-0000000e7b01', 'owner', 'Owner B', true);

INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('c0000000-0000-4000-8000-0000000e7a00', '0a000000-0000-4000-8000-0000000e7a00', 'residential', 'Plans Client A'),
  ('c0000000-0000-4000-8000-0000000e7b00', '0b000000-0000-4000-8000-0000000e7b00', 'residential', 'Plans Client B');
INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code) VALUES
  ('d0000000-0000-4000-8000-0000000e7a00', '0a000000-0000-4000-8000-0000000e7a00', 'c0000000-0000-4000-8000-0000000e7a00', '1 Oak St', 'Springfield', '60614'),
  ('d0000000-0000-4000-8000-0000000e7b00', '0b000000-0000-4000-8000-0000000e7b00', 'c0000000-0000-4000-8000-0000000e7b00', '2 Elm St', 'Shelbyville', '60615');
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency, price_cents, dog_count, started_on) VALUES
  ('e0000000-0000-4000-8000-0000000e7a00', '0a000000-0000-4000-8000-0000000e7a00', 'c0000000-0000-4000-8000-0000000e7a00',
   'd0000000-0000-4000-8000-0000000e7a00', 'residential', 'weekly', 2400, 1, current_date + 1),
  ('e0000000-0000-4000-8000-0000000e7b00', '0b000000-0000-4000-8000-0000000e7b00', 'c0000000-0000-4000-8000-0000000e7b00',
   'd0000000-0000-4000-8000-0000000e7b00', 'residential', 'weekly', 2400, 1, current_date + 1);

CREATE FUNCTION pg_temp.as_user(_uid text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
           json_build_object('sub', _uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
$$;

-- ── The matrix ──────────────────────────────────────────────────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-0000000e7a02');
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  _me constant uuid := 'f0000000-0000-4000-8000-0000000e7a02';
  _a constant uuid := '0a000000-0000-4000-8000-0000000e7a00';
  _b constant uuid := '0b000000-0000-4000-8000-0000000e7b00';
  _p text;
BEGIN
  IF NOT public.has_permission(_me, _a, 'manage_plans') THEN
    RAISE EXCEPTION 'PROOF FAILED [grants]: a dispatcher does not hold manage_plans';
  END IF;
  IF public.has_permission(_me, _b, 'manage_plans') THEN
    RAISE EXCEPTION 'PROOF FAILED [grants]: a dispatcher holds manage_plans in another business';
  END IF;
  FOREACH _p IN ARRAY ARRAY['booking', 'manage_schedule', 'message_clients', 'view_client_directory'] LOOP
    IF NOT public.has_permission(_me, _a, _p) THEN
      RAISE EXCEPTION 'PROOF FAILED [grants]: a dispatcher lost %', _p;
    END IF;
  END LOOP;
  FOREACH _p IN ARRAY ARRAY['manage_pricing', 'manage_client_billing', 'manage_org_billing',
                            'manage_users', 'manage_settings', 'view_financials'] LOOP
    IF public.has_permission(_me, _a, _p) THEN
      RAISE EXCEPTION 'PROOF FAILED [refusals]: a dispatcher holds %', _p;
    END IF;
  END LOOP;
  RAISE NOTICE 'ok: a dispatcher holds manage_plans in their own business, nowhere else, and still no price or money';
END $$;

-- ── The dispatcher's own key still writes no plan and no price ──────────────
DO $$
DECLARE _n int;
BEGIN
  BEGIN
    INSERT INTO public.subscriptions (organization_id, client_id, property_id, account_type, frequency, price_cents, dog_count, started_on)
    VALUES ('0a000000-0000-4000-8000-0000000e7a00', 'c0000000-0000-4000-8000-0000000e7a00',
            'd0000000-0000-4000-8000-0000000e7a00', 'residential', 'weekly', 1, 1, current_date + 1);
    RAISE EXCEPTION 'PROOF FAILED [policy]: a dispatcher wrote a plan with their own key';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  UPDATE public.subscriptions SET price_cents = 1, status = 'paused'
   WHERE id = 'e0000000-0000-4000-8000-0000000e7a00';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [policy]: a dispatcher changed a plan with their own key';
  END IF;
  SELECT count(*) INTO _n FROM public.subscriptions WHERE organization_id = '0b000000-0000-4000-8000-0000000e7b00';
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [tenant]: a dispatcher reads % plan(s) of another business', _n;
  END IF;
  RAISE NOTICE 'ok: the plan write policies still refuse a dispatcher''s own key, and another business''s plans are invisible';
END $$;

-- ── A technician holds none of it ───────────────────────────────────────────
DO $$
BEGIN
  IF public.has_permission('f0000000-0000-4000-8000-0000000e7a03', '0a000000-0000-4000-8000-0000000e7a00', 'manage_plans') THEN
    RAISE EXCEPTION 'PROOF FAILED [grants]: a technician holds manage_plans';
  END IF;
  RAISE NOTICE 'ok: a technician does not manage plans';
END $$ ;

-- ── Who and when, written with the change ───────────────────────────────────
-- As the server writes it (the service role): the audit columns exist, take
-- the dispatcher's id and a time, and the price is untouched.
RESET ROLE;
DO $$
DECLARE _r record;
BEGIN
  UPDATE public.subscriptions
     SET status = 'paused', paused_at = now(),
         last_changed_by = 'f0000000-0000-4000-8000-0000000e7a02', last_changed_at = now()
   WHERE id = 'e0000000-0000-4000-8000-0000000e7a00'
     AND organization_id = '0a000000-0000-4000-8000-0000000e7a00';
  SELECT status, price_cents, last_changed_by, last_changed_at, created_by INTO _r
    FROM public.subscriptions WHERE id = 'e0000000-0000-4000-8000-0000000e7a00';
  IF _r.status <> 'paused' OR _r.price_cents <> 2400
     OR _r.last_changed_by IS DISTINCT FROM 'f0000000-0000-4000-8000-0000000e7a02'::uuid
     OR _r.last_changed_at IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [audit]: the plan reads %', row_to_json(_r);
  END IF;
  IF _r.created_by IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [audit]: created_by was invented for a plan nobody stamped';
  END IF;
  RAISE NOTICE 'ok: a plan change records who made it and when, and leaves the price alone';
END $$;

ROLLBACK;

\echo 'ALL PLAN-MANAGEMENT PROOFS PASSED'
