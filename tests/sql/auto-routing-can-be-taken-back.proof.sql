-- Auto-routing can be taken back (#435, QA row 17), proved against a real
-- Postgres rather than read off the migration's text.
-- Run by tests/auto-routing-can-be-taken-back.test.ts, which passes
--   :migration  20261015140000_auto-routing-can-be-taken-back.sql
--
-- Everything happens inside one transaction that is ROLLED BACK at the end,
-- the migration included. Each group prints "ok: ..." only when every check
-- in it passed, or raises "PROOF FAILED [...]", and ON_ERROR_STOP turns the
-- first failure into a non-zero exit.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

-- ── Fixture ───────────────────────────────────────────────────────────────
-- One business, an owner, two technicians (Ann, Bo). Ann has v1 and v2, Bo
-- has v3, each with a time from "before" (the year 2000) so a restore that
-- forgets the times is caught.
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('a6200000-0000-4000-8000-0000000000a1', 'owner@undo.proof.invalid'),
  ('a6200000-0000-4000-8000-0000000000a2', 'ann@undo.proof.invalid'),
  ('a6200000-0000-4000-8000-0000000000a3', 'bo@undo.proof.invalid');
INSERT INTO public.organizations (id, name, timezone, work_days) VALUES
  ('06200000-0000-4000-8000-0000000000aa', 'Undo Proof A', 'America/Chicago', '{0,1,2,3,4,5,6}');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a6200000-0000-4000-8000-0000000000a1', '06200000-0000-4000-8000-0000000000aa', 'owner'),
  ('a6200000-0000-4000-8000-0000000000a2', '06200000-0000-4000-8000-0000000000aa', 'tech'),
  ('a6200000-0000-4000-8000-0000000000a3', '06200000-0000-4000-8000-0000000000aa', 'tech');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.staff (id, organization_id, user_id, role, display_name, active,
                          is_field_tech, is_field_tech_overridden, start_latitude, start_longitude) VALUES
  ('5e620000-0000-4000-8000-0000000000a2', '06200000-0000-4000-8000-0000000000aa',
   'a6200000-0000-4000-8000-0000000000a2', 'tech', 'Ann Undo', true, true, true, 41.90, -87.65),
  ('5e620000-0000-4000-8000-0000000000a3', '06200000-0000-4000-8000-0000000000aa',
   'a6200000-0000-4000-8000-0000000000a3', 'tech', 'Bo Undo', true, true, true, 41.90, -87.70);

INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('c6200000-0000-4000-8000-0000000000a1', '06200000-0000-4000-8000-0000000000aa', 'residential', 'Undo Client One'),
  ('c6200000-0000-4000-8000-0000000000a2', '06200000-0000-4000-8000-0000000000aa', 'residential', 'Undo Client Two'),
  ('c6200000-0000-4000-8000-0000000000a3', '06200000-0000-4000-8000-0000000000aa', 'residential', 'Undo Client Three');

INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code, latitude, longitude) VALUES
  ('e6200000-0000-4000-8000-0000000000a1', '06200000-0000-4000-8000-0000000000aa',
   'c6200000-0000-4000-8000-0000000000a1', '1 Undo St', 'Chicago', '60614', 41.92, -87.65),
  ('e6200000-0000-4000-8000-0000000000a2', '06200000-0000-4000-8000-0000000000aa',
   'c6200000-0000-4000-8000-0000000000a2', '2 Undo St', 'Chicago', '60614', 41.94, -87.66),
  ('e6200000-0000-4000-8000-0000000000a3', '06200000-0000-4000-8000-0000000000aa',
   'c6200000-0000-4000-8000-0000000000a3', '3 Undo St', 'Chicago', '60614', 41.93, -87.70);

CREATE TEMP TABLE proof_day ON COMMIT DROP AS
  SELECT ((now() AT TIME ZONE 'America/Chicago')::date + 7) AS d;
GRANT SELECT ON proof_day TO authenticated, anon;

CREATE FUNCTION pg_temp.as_user(_uid text, _aal text DEFAULT 'aal1') RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
           json_build_object('sub', _uid, 'role', 'authenticated', 'aal', _aal)::text, true);
$$;
CREATE FUNCTION pg_temp.pet_waste(_org uuid) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM public.services WHERE organization_id = _org AND lower(name) = 'pet waste removal';
$$;

INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency,
                                  price_cents, dog_count, started_on, service_id)
SELECT x.id::uuid, '06200000-0000-4000-8000-0000000000aa', x.client::uuid, x.prop::uuid, 'residential', 'weekly',
       2000, 1, p.d - 7, pg_temp.pet_waste('06200000-0000-4000-8000-0000000000aa')
  FROM proof_day p, (VALUES
    ('d6200000-0000-4000-8000-0000000000a1', 'c6200000-0000-4000-8000-0000000000a1', 'e6200000-0000-4000-8000-0000000000a1'),
    ('d6200000-0000-4000-8000-0000000000a2', 'c6200000-0000-4000-8000-0000000000a2', 'e6200000-0000-4000-8000-0000000000a2'),
    ('d6200000-0000-4000-8000-0000000000a3', 'c6200000-0000-4000-8000-0000000000a3', 'e6200000-0000-4000-8000-0000000000a3')
  ) AS x(id, client, prop);

INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id, scheduled_on, status,
                           assigned_staff_id, sequence, eta_start, eta_end)
SELECT x.id::uuid, '06200000-0000-4000-8000-0000000000aa', x.sub::uuid, x.client::uuid, x.prop::uuid, p.d, 'scheduled',
       x.staff::uuid, x.seq, '2000-01-01T00:00:00Z', '2000-01-01T00:10:00Z'
  FROM proof_day p, (VALUES
    ('f6200000-0000-4000-8000-0000000000a1', 'd6200000-0000-4000-8000-0000000000a1',
     'c6200000-0000-4000-8000-0000000000a1', 'e6200000-0000-4000-8000-0000000000a1', '5e620000-0000-4000-8000-0000000000a2', 1),
    ('f6200000-0000-4000-8000-0000000000a2', 'd6200000-0000-4000-8000-0000000000a2',
     'c6200000-0000-4000-8000-0000000000a2', 'e6200000-0000-4000-8000-0000000000a2', '5e620000-0000-4000-8000-0000000000a2', 2),
    ('f6200000-0000-4000-8000-0000000000a3', 'd6200000-0000-4000-8000-0000000000a3',
     'c6200000-0000-4000-8000-0000000000a3', 'e6200000-0000-4000-8000-0000000000a3', '5e620000-0000-4000-8000-0000000000a3', 1)
  ) AS x(id, sub, client, prop, staff, seq);

\i :migration

-- ── 1. A run keeps what it replaced, and says what it changed ─────────────
-- The owner runs auto-routing for D across both techs; the plan swaps the
-- day around: Ann gets v3, Bo gets v2 then v1.
SELECT pg_temp.as_user('a6200000-0000-4000-8000-0000000000a1');
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  _d date := (SELECT d FROM proof_day);
  _run constant uuid := '76200000-0000-4000-8000-0000000000a1';
  _ann constant uuid := '5e620000-0000-4000-8000-0000000000a2';
  _bo constant uuid := '5e620000-0000-4000-8000-0000000000a3';
  _started jsonb; _out jsonb; _state jsonb; _n integer;
BEGIN
  _started := public.start_routing_run(_run, '06200000-0000-4000-8000-0000000000aa', _d, _d,
                ARRAY[_ann, _bo], 'org');
  IF (_started->>'attached')::boolean THEN
    RAISE EXCEPTION 'PROOF FAILED [capture]: the run attached to another instead of starting';
  END IF;
  _n := public.capture_routing_run_undo(_run);
  IF _n <> 3 THEN
    RAISE EXCEPTION 'PROOF FAILED [capture]: captured % visits, expected the 3 the run may write', _n;
  END IF;
  _out := public.apply_route_plans(_run, true, jsonb_build_array(jsonb_build_object(
            'day', _d,
            'routes', jsonb_build_array(
              jsonb_build_object('staff_id', _ann, 'visit_ids',
                jsonb_build_array('f6200000-0000-4000-8000-0000000000a3')),
              jsonb_build_object('staff_id', _bo, 'visit_ids',
                jsonb_build_array('f6200000-0000-4000-8000-0000000000a2', 'f6200000-0000-4000-8000-0000000000a1'))),
            'unassigned', '[]'::jsonb,
            'honour_windows', true)));
  IF NOT (_out->0->>'ok')::boolean THEN
    RAISE EXCEPTION 'PROOF FAILED [capture]: apply_route_plans refused the day: %', _out->0->>'error';
  END IF;
  _n := public.seal_routing_run_undo(_run);
  IF _n <> 3 THEN
    RAISE EXCEPTION 'PROOF FAILED [capture]: sealed % rows, expected 3', _n;
  END IF;
  _state := public.routing_run_undo_state(_run);
  IF NOT (_state->>'available')::boolean OR (_state->>'moved')::int <> 3 OR (_state->>'techs')::int <> 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [capture]: state reads %, expected available, 3 moved across 2 techs', _state;
  END IF;
  RAISE NOTICE 'ok: a run keeps what it replaced, and says it moved 3 visits across 2 techs';
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

-- ── 2. The offer is withdrawn when anything moves, or the window passes ───
-- A hand edit (as the table's owner, standing in for a drag) withdraws it;
-- putting the value back restores it. An applied_at 20 minutes ago reads
-- as expired.
CREATE TEMP TABLE saved ON COMMIT DROP AS
  SELECT (SELECT after_sequence FROM public.routing_run_undo
           WHERE run_id = '76200000-0000-4000-8000-0000000000a1'
             AND visit_id = 'f6200000-0000-4000-8000-0000000000a1') AS seq,
         (SELECT applied_at FROM public.routing_runs WHERE id = '76200000-0000-4000-8000-0000000000a1') AS applied;

UPDATE public.visits SET sequence = 99 WHERE id = 'f6200000-0000-4000-8000-0000000000a1';
SELECT pg_temp.as_user('a6200000-0000-4000-8000-0000000000a1');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _state jsonb;
BEGIN
  _state := public.routing_run_undo_state('76200000-0000-4000-8000-0000000000a1');
  IF (_state->>'available')::boolean OR _state->>'reason' IS DISTINCT FROM 'changed_since' THEN
    RAISE EXCEPTION 'PROOF FAILED [window]: after a hand edit the state reads %', _state;
  END IF;
  BEGIN
    PERFORM public.undo_routing_run('76200000-0000-4000-8000-0000000000a1');
    RAISE EXCEPTION 'PROOF FAILED [window]: undo ran on top of a newer change';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%schedule has changed%' THEN RAISE; END IF;
  END;
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

UPDATE public.visits SET sequence = (SELECT seq FROM saved) WHERE id = 'f6200000-0000-4000-8000-0000000000a1';
UPDATE public.routing_runs SET applied_at = applied_at - interval '20 minutes'
 WHERE id = '76200000-0000-4000-8000-0000000000a1';
SELECT pg_temp.as_user('a6200000-0000-4000-8000-0000000000a1');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _state jsonb;
BEGIN
  _state := public.routing_run_undo_state('76200000-0000-4000-8000-0000000000a1');
  IF (_state->>'available')::boolean OR _state->>'reason' IS DISTINCT FROM 'expired' THEN
    RAISE EXCEPTION 'PROOF FAILED [window]: 20 minutes after saving the state reads %', _state;
  END IF;
  RAISE NOTICE 'ok: the offer is withdrawn once anything it would overwrite moves, and after 15 minutes';
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);
UPDATE public.routing_runs SET applied_at = (SELECT applied FROM saved)
 WHERE id = '76200000-0000-4000-8000-0000000000a1';

-- ── 3. Who may undo ──────────────────────────────────────────────────────
SELECT pg_temp.as_user('a6200000-0000-4000-8000-0000000000a2');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.undo_routing_run('76200000-0000-4000-8000-0000000000a1');
    RAISE EXCEPTION 'PROOF FAILED [who]: a technician undid the business''s routing';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.routing_run_undo;
    RAISE EXCEPTION 'PROOF FAILED [who]: a member read routing_run_undo directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM public.routing_run_undo_state('76200000-0000-4000-8000-0000000000a1');
    RAISE EXCEPTION 'PROOF FAILED [who]: anon read an undo state';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok: only someone who can route the business can undo; nobody reads the table directly';
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

-- ── 4. Undo puts every visit back, once ──────────────────────────────────
SELECT pg_temp.as_user('a6200000-0000-4000-8000-0000000000a1');
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  _ann constant uuid := '5e620000-0000-4000-8000-0000000000a2';
  _bo constant uuid := '5e620000-0000-4000-8000-0000000000a3';
  _out jsonb; _r record; _bad integer;
BEGIN
  _out := public.undo_routing_run('76200000-0000-4000-8000-0000000000a1');
  IF (_out->>'restored')::int <> 3 THEN
    RAISE EXCEPTION 'PROOF FAILED [undo]: restored % visits, expected 3', _out->>'restored';
  END IF;
  SELECT count(*) INTO _bad FROM public.visits v
   WHERE v.id IN ('f6200000-0000-4000-8000-0000000000a1', 'f6200000-0000-4000-8000-0000000000a2',
                  'f6200000-0000-4000-8000-0000000000a3')
     AND (v.eta_start <> '2000-01-01T00:00:00Z' OR v.eta_end <> '2000-01-01T00:10:00Z');
  IF _bad <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [undo]: % visits did not get their old times back', _bad;
  END IF;
  SELECT assigned_staff_id, sequence INTO _r FROM public.visits WHERE id = 'f6200000-0000-4000-8000-0000000000a1';
  IF _r.assigned_staff_id IS DISTINCT FROM _ann OR _r.sequence <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [undo]: v1 is %, expected Ann first', _r;
  END IF;
  SELECT assigned_staff_id, sequence INTO _r FROM public.visits WHERE id = 'f6200000-0000-4000-8000-0000000000a3';
  IF _r.assigned_staff_id IS DISTINCT FROM _bo OR _r.sequence <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [undo]: v3 is %, expected Bo first', _r;
  END IF;
  -- Once.
  BEGIN
    PERFORM public.undo_routing_run('76200000-0000-4000-8000-0000000000a1');
    RAISE EXCEPTION 'PROOF FAILED [undo]: the same run was undone twice';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%nothing to undo%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'ok: undo puts back each visit''s tech, order and times, and only once';
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

ROLLBACK;
\echo ALL ROUTING-UNDO PROOFS PASSED
