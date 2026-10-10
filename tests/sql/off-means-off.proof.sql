-- Off means off, proved against a real Postgres. Run by
-- tests/off-means-off.test.ts with :migration. One transaction, ROLLED BACK at
-- the end, the migration included. Each check prints "ok: ..." or raises
-- "PROOF FAILED [...]".
--
-- Business A: an owner, a technician with a visit today, an office manager.
-- Business B: an owner. Each person is tried as the API sees them: role
-- authenticated, the JWT's sub set the way Supabase sets it.

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
  ('f0000000-0000-4000-8000-0000000c0a01', 'owner-a@off.proof.invalid'),
  ('f0000000-0000-4000-8000-0000000c0a02', 'tech-a@off.proof.invalid'),
  ('f0000000-0000-4000-8000-0000000c0a03', 'office-a@off.proof.invalid'),
  ('f0000000-0000-4000-8000-0000000c0a04', 'owner2-a@off.proof.invalid'),
  ('f0000000-0000-4000-8000-0000000c0b01', 'owner-b@off.proof.invalid');
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a000000-0000-4000-8000-0000000c0a00', 'Off Proof A', 'America/Chicago'),
  ('0b000000-0000-4000-8000-0000000c0b00', 'Off Proof B', 'America/Chicago');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('f0000000-0000-4000-8000-0000000c0a01', '0a000000-0000-4000-8000-0000000c0a00', 'owner'),
  ('f0000000-0000-4000-8000-0000000c0a02', '0a000000-0000-4000-8000-0000000c0a00', 'tech'),
  ('f0000000-0000-4000-8000-0000000c0a03', '0a000000-0000-4000-8000-0000000c0a00', 'office_manager'),
  ('f0000000-0000-4000-8000-0000000c0a04', '0a000000-0000-4000-8000-0000000c0a00', 'owner'),
  ('f0000000-0000-4000-8000-0000000c0b01', '0b000000-0000-4000-8000-0000000c0b00', 'owner');
SET LOCAL app.allow_protected_org_write = '';

-- The second owner of A is already off: an owner who is off does not count
-- as the one who keeps the business reachable.
INSERT INTO public.staff (id, organization_id, user_id, role, display_name, active) VALUES
  ('5a000000-0000-4000-8000-0000000c0a01', '0a000000-0000-4000-8000-0000000c0a00', 'f0000000-0000-4000-8000-0000000c0a01', 'owner', 'Owner A', true),
  ('5a000000-0000-4000-8000-0000000c0a02', '0a000000-0000-4000-8000-0000000c0a00', 'f0000000-0000-4000-8000-0000000c0a02', 'tech', 'Tech A', true),
  ('5a000000-0000-4000-8000-0000000c0a03', '0a000000-0000-4000-8000-0000000c0a00', 'f0000000-0000-4000-8000-0000000c0a03', 'office_manager', 'Office A', true),
  ('5a000000-0000-4000-8000-0000000c0a04', '0a000000-0000-4000-8000-0000000c0a00', 'f0000000-0000-4000-8000-0000000c0a04', 'owner', 'Owner A Two', false),
  ('5b000000-0000-4000-8000-0000000c0b01', '0b000000-0000-4000-8000-0000000c0b00', 'f0000000-0000-4000-8000-0000000c0b01', 'owner', 'Owner B', true);

INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('c0000000-0000-4000-8000-0000000c0a00', '0a000000-0000-4000-8000-0000000c0a00', 'residential', 'Off Client A'),
  ('c0000000-0000-4000-8000-0000000c0b00', '0b000000-0000-4000-8000-0000000c0b00', 'residential', 'Off Client B');
INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code, gate_code) VALUES
  ('d0000000-0000-4000-8000-0000000c0a00', '0a000000-0000-4000-8000-0000000c0a00', 'c0000000-0000-4000-8000-0000000c0a00',
   '1 Oak St', 'Springfield', '60614', 'GATE-OFF-A');
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency, price_cents, dog_count, started_on) VALUES
  ('e0000000-0000-4000-8000-0000000c0a00', '0a000000-0000-4000-8000-0000000c0a00', 'c0000000-0000-4000-8000-0000000c0a00',
   'd0000000-0000-4000-8000-0000000c0a00', 'residential', 'weekly', 2400, 1, current_date);
INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id, scheduled_on, assigned_staff_id) VALUES
  ('7a000000-0000-4000-8000-0000000c0a00', '0a000000-0000-4000-8000-0000000c0a00', 'e0000000-0000-4000-8000-0000000c0a00',
   'c0000000-0000-4000-8000-0000000c0a00', 'd0000000-0000-4000-8000-0000000c0a00', current_date,
   '5a000000-0000-4000-8000-0000000c0a02');
INSERT INTO public.time_entries (organization_id, staff_id, clock_in, clock_out, clock_out_source) VALUES
  ('0a000000-0000-4000-8000-0000000c0a00', '5a000000-0000-4000-8000-0000000c0a02', now() - interval '2 hours', now() - interval '1 hour', 'tech_live');
INSERT INTO public.leads (organization_id, name, email, source, status) VALUES
  ('0a000000-0000-4000-8000-0000000c0a00', 'Off Lead A', 'lead-a@off.proof.invalid', 'website', 'new');

CREATE FUNCTION pg_temp.as_user(_uid text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
           json_build_object('sub', _uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
$$;

-- How much of business A this session can see, table by table.
CREATE FUNCTION pg_temp.seen_of_a() RETURNS bigint LANGUAGE sql AS $$
  SELECT (SELECT count(*) FROM public.organizations WHERE id = '0a000000-0000-4000-8000-0000000c0a00')
       + (SELECT count(*) FROM public.clients WHERE organization_id = '0a000000-0000-4000-8000-0000000c0a00')
       + (SELECT count(*) FROM public.properties WHERE organization_id = '0a000000-0000-4000-8000-0000000c0a00')
       + (SELECT count(*) FROM public.subscriptions WHERE organization_id = '0a000000-0000-4000-8000-0000000c0a00')
       + (SELECT count(*) FROM public.visits WHERE organization_id = '0a000000-0000-4000-8000-0000000c0a00')
       + (SELECT count(*) FROM public.staff WHERE organization_id = '0a000000-0000-4000-8000-0000000c0a00')
       + (SELECT count(*) FROM public.time_entries WHERE organization_id = '0a000000-0000-4000-8000-0000000c0a00')
       + (SELECT count(*) FROM public.leads WHERE organization_id = '0a000000-0000-4000-8000-0000000c0a00')
       + (SELECT count(*) FROM public.my_day_stop_facts(ARRAY['7a000000-0000-4000-8000-0000000c0a00'::uuid]));
$$;

-- ── Before: everyone on A is on ─────────────────────────────────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-0000000c0a02');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.clients WHERE id = 'c0000000-0000-4000-8000-0000000c0a00')
     OR NOT EXISTS (SELECT 1 FROM public.time_entries)
     OR NOT public.is_org_member('f0000000-0000-4000-8000-0000000c0a02', '0a000000-0000-4000-8000-0000000c0a00') THEN
    RAISE EXCEPTION 'PROOF FAILED [before]: the technician, while on, cannot see their own route';
  END IF;
  RAISE NOTICE 'ok: before anything is turned off, the technician reads their route and their hours';
END $$;
RESET ROLE;

-- ── The owner turns the technician and the office manager off ───────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-0000000c0a01');
SET LOCAL ROLE authenticated;
SELECT public.set_staff_active('5a000000-0000-4000-8000-0000000c0a02', false);
SELECT public.set_staff_active('5a000000-0000-4000-8000-0000000c0a03', false);
RESET ROLE;

-- ── The technician, off ─────────────────────────────────────────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-0000000c0a02');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _n bigint; _name text;
BEGIN
  _n := pg_temp.seen_of_a();
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [off tech]: still reads % row(s) of the business', _n;
  END IF;
  IF public.is_org_member('f0000000-0000-4000-8000-0000000c0a02', '0a000000-0000-4000-8000-0000000c0a00')
     OR public.has_role('f0000000-0000-4000-8000-0000000c0a02', '0a000000-0000-4000-8000-0000000c0a00', 'tech')
     OR public.has_permission('f0000000-0000-4000-8000-0000000c0a02', '0a000000-0000-4000-8000-0000000c0a00', 'record_field_addons')
     OR public.is_visit_tech('f0000000-0000-4000-8000-0000000c0a02', '7a000000-0000-4000-8000-0000000c0a00')
     OR public.may_read_client('c0000000-0000-4000-8000-0000000c0a00')
     OR public.may_read_property('d0000000-0000-4000-8000-0000000c0a00') THEN
    RAISE EXCEPTION 'PROOF FAILED [off tech]: passes a permission check inside an RPC';
  END IF;

  UPDATE public.visits SET updated_at = now() WHERE id = '7a000000-0000-4000-8000-0000000c0a00';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [off tech]: updated their visit';
  END IF;
  BEGIN
    INSERT INTO public.clients (organization_id, account_type, display_name)
    VALUES ('0a000000-0000-4000-8000-0000000c0a00', 'residential', 'Should not exist');
    RAISE EXCEPTION 'PROOF FAILED [off tech]: wrote a client';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  SELECT organization_name INTO _name FROM public.access_turned_off();
  IF _name IS DISTINCT FROM 'Off Proof A' THEN
    RAISE EXCEPTION 'PROOF FAILED [off tech]: access_turned_off() said %, not the business', _name;
  END IF;
  RAISE NOTICE 'ok: a technician who is off reads nothing of the business, writes nothing, passes nothing, and is told which business';
END $$;
RESET ROLE;

-- ── The office manager, off ─────────────────────────────────────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-0000000c0a03');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _n bigint;
BEGIN
  _n := pg_temp.seen_of_a() + (SELECT count(*) FROM public.org_invites);
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [off office]: still reads % row(s) of the business', _n;
  END IF;
  BEGIN
    INSERT INTO public.org_invites (organization_id, email, role, token)
    VALUES ('0a000000-0000-4000-8000-0000000c0a00', 'sneaky@off.proof.invalid', 'tech', 'off-proof-sneaky');
    RAISE EXCEPTION 'PROOF FAILED [off office]: invited somebody';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.set_staff_active('5a000000-0000-4000-8000-0000000c0a03', true);
    RAISE EXCEPTION 'PROOF FAILED [off office]: turned themselves back on';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'Not authorized%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'ok: an office manager who is off reads no leads or invitations, invites nobody, and cannot turn themselves back on';
END $$;
RESET ROLE;

-- ── Business B is untouched ─────────────────────────────────────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-0000000c0b01');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.clients WHERE id = 'c0000000-0000-4000-8000-0000000c0b00')
     OR NOT public.has_permission('f0000000-0000-4000-8000-0000000c0b01', '0b000000-0000-4000-8000-0000000c0b00', 'manage_settings')
     OR EXISTS (SELECT 1 FROM public.access_turned_off())
     OR pg_temp.seen_of_a() <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [other org]: business B changed';
  END IF;
  RAISE NOTICE 'ok: another business works exactly as before';
END $$;
RESET ROLE;

-- ── The owner who is on keeps everything, and cannot leave nobody on ────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-0000000c0a01');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF pg_temp.seen_of_a() < 9 OR EXISTS (SELECT 1 FROM public.access_turned_off()) THEN
    RAISE EXCEPTION 'PROOF FAILED [owner]: the owner lost access';
  END IF;
  BEGIN
    PERFORM public.set_staff_active('5a000000-0000-4000-8000-0000000c0a01', false);
    RAISE EXCEPTION 'PROOF FAILED [owner]: the last owner who is on turned themselves off';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'The business needs at least one owner%' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE public.staff SET active = false WHERE id = '5a000000-0000-4000-8000-0000000c0a01';
    RAISE EXCEPTION 'PROOF FAILED [owner]: the staff UPDATE policy turned off the last owner';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'The business needs at least one owner%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'ok: the owner keeps the business, and cannot turn off the last owner who is on';
END $$;
RESET ROLE;

-- Demoting that owner, with only an owner who is off left, is refused too.
DO $$
BEGIN
  BEGIN
    UPDATE public.user_roles SET role = 'office_manager'
     WHERE user_id = 'f0000000-0000-4000-8000-0000000c0a01';
    RAISE EXCEPTION 'PROOF FAILED [demote]: the last owner who is on was demoted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'The business needs at least one owner%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'ok: demoting the last owner who is on is refused, an owner who is off does not count';
END $$;

-- ── Turned back on ──────────────────────────────────────────────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-0000000c0a01');
SET LOCAL ROLE authenticated;
SELECT public.set_staff_active('5a000000-0000-4000-8000-0000000c0a02', true);
RESET ROLE;

SELECT pg_temp.as_user('f0000000-0000-4000-8000-0000000c0a02');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.clients WHERE id = 'c0000000-0000-4000-8000-0000000c0a00')
     OR NOT EXISTS (SELECT 1 FROM public.time_entries)
     OR NOT EXISTS (SELECT 1 FROM public.my_day_stop_facts(ARRAY['7a000000-0000-4000-8000-0000000c0a00'::uuid]))
     OR NOT public.is_visit_tech('f0000000-0000-4000-8000-0000000c0a02', '7a000000-0000-4000-8000-0000000c0a00')
     OR EXISTS (SELECT 1 FROM public.access_turned_off()) THEN
    RAISE EXCEPTION 'PROOF FAILED [back on]: turning the technician back on did not restore their route';
  END IF;
  RAISE NOTICE 'ok: turning the technician back on restores their route';
END $$;
RESET ROLE;

-- ── An accepted invitation is a seat, whatever the role ─────────────────────
INSERT INTO public.org_invites (organization_id, email, role, token) VALUES
  ('0a000000-0000-4000-8000-0000000c0a00', 'dispatch-a@off.proof.invalid', 'dispatcher', 'off-proof-dispatch-token');
INSERT INTO auth.users (id, email) VALUES
  ('f0000000-0000-4000-8000-0000000c0a05', 'dispatch-a@off.proof.invalid');
SELECT pg_temp.as_user('f0000000-0000-4000-8000-0000000c0a05');
SET LOCAL ROLE authenticated;
SELECT public.accept_org_invite_for_current_user('off-proof-dispatch-token');
RESET ROLE;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.staff
     WHERE user_id = 'f0000000-0000-4000-8000-0000000c0a05'
       AND organization_id = '0a000000-0000-4000-8000-0000000c0a00'
       AND active
  ) THEN
    RAISE EXCEPTION 'PROOF FAILED [invite]: an accepted dispatcher joined turned off, so not a seat';
  END IF;
  RAISE NOTICE 'ok: an accepted dispatcher joins turned on, and counts as a seat';
END $$;

ROLLBACK;
\echo ALL OFF-MEANS-OFF PROOFS PASSED
