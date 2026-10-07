-- Auto-routing runs in the background, proved against a real Postgres rather
-- than read off the migration's text. Run by
-- tests/routing-runs-in-the-background.test.ts, which passes the migration's
-- path as :migration.
--
-- Everything happens inside one transaction that is ROLLED BACK at the end,
-- the migration included. Each group prints "ok: ..." only when every check
-- in it passed, or raises "PROOF FAILED [...]", and ON_ERROR_STOP turns the
-- first failure into a non-zero exit.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :migration

-- ── Fixture ─────────────────────────────────────────────────────────────────
-- Org A: Olivia (owner), Dee (dispatcher), Sam (tech, runs routes).
-- Org B: Bea (owner).
-- Two scheduled stops on day D for Sam, and one on D+1.
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('a5000000-0000-4000-8000-00000000a001', 'olivia@runs.proof.invalid'),
  ('a5000000-0000-4000-8000-00000000a002', 'dee@runs.proof.invalid'),
  ('a5000000-0000-4000-8000-00000000a003', 'sam@runs.proof.invalid'),
  ('b5000000-0000-4000-8000-00000000b001', 'bea@runs.proof.invalid');

INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a500000-0000-4000-8000-0000000000aa', 'Runs Proof A', 'America/Chicago'),
  ('0b500000-0000-4000-8000-0000000000bb', 'Runs Proof B', 'America/Chicago');

INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a5000000-0000-4000-8000-00000000a001', '0a500000-0000-4000-8000-0000000000aa', 'owner'),
  ('a5000000-0000-4000-8000-00000000a002', '0a500000-0000-4000-8000-0000000000aa', 'dispatcher'),
  ('a5000000-0000-4000-8000-00000000a003', '0a500000-0000-4000-8000-0000000000aa', 'tech'),
  ('b5000000-0000-4000-8000-00000000b001', '0b500000-0000-4000-8000-0000000000bb', 'owner');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.staff (id, organization_id, user_id, role, display_name, active,
                          is_field_tech, is_field_tech_overridden) VALUES
  ('5e000000-0000-4000-8000-000000000003', '0a500000-0000-4000-8000-0000000000aa',
   'a5000000-0000-4000-8000-00000000a003', 'tech', 'Sam Rivera', true, true, true);

INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('c5000000-0000-4000-8000-0000000000a1', '0a500000-0000-4000-8000-0000000000aa', 'residential', 'Runs Client A1'),
  ('c5000000-0000-4000-8000-0000000000a2', '0a500000-0000-4000-8000-0000000000aa', 'residential', 'Runs Client A2');

INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code, latitude, longitude) VALUES
  ('e5000000-0000-4000-8000-0000000000a1', '0a500000-0000-4000-8000-0000000000aa',
   'c5000000-0000-4000-8000-0000000000a1', '412 Elm St', 'Chicago', '60614', 41.92, -87.65),
  ('e5000000-0000-4000-8000-0000000000a2', '0a500000-0000-4000-8000-0000000000aa',
   'c5000000-0000-4000-8000-0000000000a2', '9 Ash St', 'Chicago', '60614', 41.93, -87.66);

INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency, price_cents, dog_count) VALUES
  ('d5000000-0000-4000-8000-0000000000a1', '0a500000-0000-4000-8000-0000000000aa',
   'c5000000-0000-4000-8000-0000000000a1', 'e5000000-0000-4000-8000-0000000000a1', 'residential', 'weekly', 2500, 1),
  ('d5000000-0000-4000-8000-0000000000a2', '0a500000-0000-4000-8000-0000000000aa',
   'c5000000-0000-4000-8000-0000000000a2', 'e5000000-0000-4000-8000-0000000000a2', 'residential', 'weekly', 2500, 1);

-- D is a week out, so no "today" rule anywhere can touch it.
CREATE TEMP TABLE proof_day ON COMMIT DROP AS
  SELECT ((now() AT TIME ZONE 'America/Chicago')::date + 7) AS d;
GRANT SELECT ON proof_day TO authenticated, anon;

INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id, assigned_staff_id, scheduled_on, status)
SELECT x.id::uuid, '0a500000-0000-4000-8000-0000000000aa', x.sub::uuid, x.client::uuid, x.prop::uuid,
       '5e000000-0000-4000-8000-000000000003', p.d + x.offs, 'scheduled'
  FROM proof_day p, (VALUES
    ('f5000000-0000-4000-8000-0000000000a1', 'd5000000-0000-4000-8000-0000000000a1',
     'c5000000-0000-4000-8000-0000000000a1', 'e5000000-0000-4000-8000-0000000000a1', 0),
    ('f5000000-0000-4000-8000-0000000000a2', 'd5000000-0000-4000-8000-0000000000a2',
     'c5000000-0000-4000-8000-0000000000a2', 'e5000000-0000-4000-8000-0000000000a2', 0),
    ('f5000000-0000-4000-8000-0000000000a3', 'd5000000-0000-4000-8000-0000000000a1',
     'c5000000-0000-4000-8000-0000000000a1', 'e5000000-0000-4000-8000-0000000000a1', 1)
  ) AS x(id, sub, client, prop, offs);

-- Who is acting. A helper rather than repeating the claims literal.
CREATE OR REPLACE FUNCTION pg_temp.act_as(_uid text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
    CASE WHEN _uid IS NULL THEN '{"role":"anon"}'
         ELSE json_build_object('sub', _uid, 'role', 'authenticated')::text END, true);
$$;

-- ── Start, and one active run per organization ─────────────────────────────
SELECT pg_temp.act_as('a5000000-0000-4000-8000-00000000a001');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _d date := (SELECT d FROM proof_day); _r jsonb; _row record;
BEGIN
  _r := public.start_routing_run('77000000-0000-4000-8000-000000000001', '0a500000-0000-4000-8000-0000000000aa',
                                 _d, _d + 1, ARRAY['5e000000-0000-4000-8000-000000000003']::uuid[], 'org');
  IF (_r->>'attached')::boolean IS DISTINCT FROM false
     OR _r->>'run_id' <> '77000000-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'PROOF FAILED [start]: %', _r;
  END IF;
  SELECT * INTO _row FROM public.routing_runs WHERE id = '77000000-0000-4000-8000-000000000001';
  IF _row.status <> 'queued' OR _row.days_total <> 2 OR _row.days_done <> 0
     OR _row.started_by <> 'a5000000-0000-4000-8000-00000000a001' THEN
    RAISE EXCEPTION 'PROOF FAILED [start row]: status %, days %/%', _row.status, _row.days_done, _row.days_total;
  END IF;
  -- The same press again (a retry) attaches to itself.
  _r := public.start_routing_run('77000000-0000-4000-8000-000000000001', '0a500000-0000-4000-8000-0000000000aa',
                                 _d, _d + 1, ARRAY['5e000000-0000-4000-8000-000000000003']::uuid[], 'org');
  IF NOT (_r->>'attached')::boolean OR _r->>'run_id' <> '77000000-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'PROOF FAILED [retry]: %', _r;
  END IF;
  RAISE NOTICE 'ok: a press records a queued run, and pressing again attaches to it';
END $$;
RESET ROLE;

SELECT pg_temp.act_as('a5000000-0000-4000-8000-00000000a002');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _d date := (SELECT d FROM proof_day); _r jsonb; _n int;
BEGIN
  -- Dee presses for a DIFFERENT range while Olivia's runs: attaches.
  _r := public.start_routing_run('77000000-0000-4000-8000-000000000002', '0a500000-0000-4000-8000-0000000000aa',
                                 _d + 5, _d + 5, ARRAY['5e000000-0000-4000-8000-000000000003']::uuid[], 'org');
  IF NOT (_r->>'attached')::boolean OR _r->>'run_id' <> '77000000-0000-4000-8000-000000000001'
     OR (_r->>'mine')::boolean THEN
    RAISE EXCEPTION 'PROOF FAILED [attach]: %', _r;
  END IF;
  SELECT count(*) INTO _n FROM public.routing_runs WHERE organization_id = '0a500000-0000-4000-8000-0000000000aa';
  IF _n <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [attach]: % runs, not 1', _n;
  END IF;
  -- Dee can see the run (it is what her press attached to)...
  IF NOT EXISTS (SELECT 1 FROM public.routing_runs WHERE id = '77000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'PROOF FAILED [attach]: the dispatcher cannot see the run she attached to';
  END IF;
  -- ...and cannot move it: it is Olivia's.
  IF public.routing_run_progress('77000000-0000-4000-8000-000000000001', 'road_times', 1) THEN
    RAISE EXCEPTION 'PROOF FAILED [not hers]: a dispatcher moved somebody else''s run';
  END IF;
  IF (public.finish_routing_run('77000000-0000-4000-8000-000000000001', 'failed', NULL, 'x')->>'finished')::boolean THEN
    RAISE EXCEPTION 'PROOF FAILED [not hers]: a dispatcher finished somebody else''s run';
  END IF;
  BEGIN
    PERFORM public.apply_route_plans('77000000-0000-4000-8000-000000000001', true, '[]'::jsonb);
    RAISE EXCEPTION 'PROOF FAILED [not hers]: a dispatcher saved somebody else''s run';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok: a second press attaches to the active run, which only its starter can move';
END $$;
RESET ROLE;

-- ── Nobody outside can see, start, or touch it ──────────────────────────────
SELECT pg_temp.act_as('b5000000-0000-4000-8000-00000000b001');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _d date := (SELECT d FROM proof_day); _n int;
BEGIN
  SELECT count(*) INTO _n FROM public.routing_runs;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [other org]: sees % runs', _n; END IF;
  BEGIN
    PERFORM public.start_routing_run('77000000-0000-4000-8000-0000000000b1', '0a500000-0000-4000-8000-0000000000aa',
                                     _d, _d, ARRAY['5e000000-0000-4000-8000-000000000003']::uuid[], 'org');
    RAISE EXCEPTION 'PROOF FAILED [other org]: started a run in somebody else''s org';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- Nor can a run id be borrowed across organizations.
  BEGIN
    PERFORM public.start_routing_run('77000000-0000-4000-8000-000000000001', '0b500000-0000-4000-8000-0000000000bb',
                                     _d, _d, ARRAY['5e000000-0000-4000-8000-000000000003']::uuid[], 'org');
    RAISE EXCEPTION 'PROOF FAILED [other org]: a run id from org A answered for org B';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM public.my_routing_runs(true, ARRAY['77000000-0000-4000-8000-000000000001']::uuid[])) THEN
    RAISE EXCEPTION 'PROOF FAILED [other org]: listed org A''s run by id';
  END IF;
  IF public.routing_run_progress('77000000-0000-4000-8000-000000000001', 'road_times', 1) THEN
    RAISE EXCEPTION 'PROOF FAILED [other org]: moved org A''s run';
  END IF;
  RAISE NOTICE 'ok: another organization cannot see, start, borrow, list or move the run';
END $$;
RESET ROLE;

SELECT pg_temp.act_as('a5000000-0000-4000-8000-00000000a003');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _d date := (SELECT d FROM proof_day); _n int;
BEGIN
  SELECT count(*) INTO _n FROM public.routing_runs;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [tech]: a technician sees % runs', _n; END IF;
  BEGIN
    PERFORM public.start_routing_run('77000000-0000-4000-8000-0000000000c1', '0a500000-0000-4000-8000-0000000000aa',
                                     _d, _d, ARRAY['5e000000-0000-4000-8000-000000000003']::uuid[], 'org');
    RAISE EXCEPTION 'PROOF FAILED [tech]: a technician started a run';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok: a technician can neither see nor start a run';
END $$;
RESET ROLE;

SELECT pg_temp.act_as(NULL);
SET LOCAL ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM 1 FROM public.routing_runs;
    RAISE EXCEPTION 'PROOF FAILED [anon]: read routing_runs';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.my_routing_runs(false, '{}');
    RAISE EXCEPTION 'PROOF FAILED [anon]: called my_routing_runs';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok: the publishable key reads and calls nothing';
END $$;
RESET ROLE;

-- ── The table is read-only to the API ───────────────────────────────────────
SELECT pg_temp.act_as('a5000000-0000-4000-8000-00000000a001');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    UPDATE public.routing_runs SET status = 'succeeded' WHERE id = '77000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'PROOF FAILED [read-only]: the owner updated a run directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.routing_runs WHERE id = '77000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'PROOF FAILED [read-only]: the owner deleted a run directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok: nobody writes the table except through its functions';
END $$;

-- ── Progress, and the write: whole, or not at all ───────────────────────────
DO $$
DECLARE _d date := (SELECT d FROM proof_day); _out jsonb; _row record; _seq1 int; _seq2 int; _caught boolean := false;
BEGIN
  IF NOT public.routing_run_progress('77000000-0000-4000-8000-000000000001', 'optimizing', 1) THEN
    RAISE EXCEPTION 'PROOF FAILED [progress]: the starter could not move her own run';
  END IF;
  SELECT * INTO _row FROM public.routing_runs WHERE id = '77000000-0000-4000-8000-000000000001';
  IF _row.status <> 'running' OR _row.stage <> 'optimizing' OR _row.days_done <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [progress]: % % %', _row.status, _row.stage, _row.days_done;
  END IF;

  -- A valid day D, then a day outside the run. The whole call is refused,
  -- and D -- which apply_route_plan had already written inside the loop --
  -- is undone with it. This is the property the run depends on: a write that
  -- does not finish leaves nothing behind.
  BEGIN
    PERFORM public.apply_route_plans('77000000-0000-4000-8000-000000000001', true, jsonb_build_array(
      jsonb_build_object('day', _d, 'honour_windows', true, 'routes', jsonb_build_array(jsonb_build_object(
        'staff_id', '5e000000-0000-4000-8000-000000000003',
        'visit_ids', jsonb_build_array('f5000000-0000-4000-8000-0000000000a2', 'f5000000-0000-4000-8000-0000000000a1')))),
      jsonb_build_object('day', _d + 30, 'routes', '[]'::jsonb)));
  EXCEPTION WHEN OTHERS THEN
    _caught := SQLERRM LIKE '%outside the run%';
  END;
  IF NOT _caught THEN RAISE EXCEPTION 'PROOF FAILED [whole]: a day outside the run was accepted'; END IF;
  IF EXISTS (SELECT 1 FROM public.visits WHERE id IN ('f5000000-0000-4000-8000-0000000000a1', 'f5000000-0000-4000-8000-0000000000a2')
                                          AND sequence IS NOT NULL) THEN
    RAISE EXCEPTION 'PROOF FAILED [whole]: a refused write left day D half-routed';
  END IF;
  IF (SELECT applied_at FROM public.routing_runs WHERE id = '77000000-0000-4000-8000-000000000001') IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [whole]: a refused write stamped the run saved';
  END IF;

  -- Now the real write: D in the order given, and D+1 with a plan that
  -- visits a stop twice, which apply_route_plan refuses. D stands; D+1 is
  -- reported and untouched.
  _out := public.apply_route_plans('77000000-0000-4000-8000-000000000001', true, jsonb_build_array(
    jsonb_build_object('day', _d, 'honour_windows', true, 'routes', jsonb_build_array(jsonb_build_object(
      'staff_id', '5e000000-0000-4000-8000-000000000003',
      'visit_ids', jsonb_build_array('f5000000-0000-4000-8000-0000000000a2', 'f5000000-0000-4000-8000-0000000000a1')))),
    jsonb_build_object('day', _d + 1, 'honour_windows', true, 'routes', jsonb_build_array(jsonb_build_object(
      'staff_id', '5e000000-0000-4000-8000-000000000003',
      'visit_ids', jsonb_build_array('f5000000-0000-4000-8000-0000000000a3', 'f5000000-0000-4000-8000-0000000000a3'))))));
  IF jsonb_array_length(_out) <> 2
     OR NOT (_out->0->>'ok')::boolean OR (_out->1->>'ok')::boolean
     OR _out->1->>'error' NOT LIKE '%twice%' THEN
    RAISE EXCEPTION 'PROOF FAILED [per day]: %', _out;
  END IF;
  SELECT sequence INTO _seq1 FROM public.visits WHERE id = 'f5000000-0000-4000-8000-0000000000a1';
  SELECT sequence INTO _seq2 FROM public.visits WHERE id = 'f5000000-0000-4000-8000-0000000000a2';
  IF _seq2 IS DISTINCT FROM 1 OR _seq1 IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [per day]: D was written as % / %, not 2 / 1', _seq1, _seq2;
  END IF;
  IF (SELECT sequence FROM public.visits WHERE id = 'f5000000-0000-4000-8000-0000000000a3') IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [per day]: the refused day was written';
  END IF;
  SELECT * INTO _row FROM public.routing_runs WHERE id = '77000000-0000-4000-8000-000000000001';
  IF _row.applied_at IS NULL OR _row.stage <> 'saving' THEN
    RAISE EXCEPTION 'PROOF FAILED [per day]: the run was not stamped saved';
  END IF;

  -- Once.
  _caught := false;
  BEGIN
    PERFORM public.apply_route_plans('77000000-0000-4000-8000-000000000001', true, '[]'::jsonb);
  EXCEPTION WHEN OTHERS THEN _caught := SQLERRM LIKE '%already saved%';
  END;
  IF NOT _caught THEN RAISE EXCEPTION 'PROOF FAILED [once]: a run was saved twice'; END IF;
  -- And no heartbeat moves a run that has saved.
  IF public.routing_run_progress('77000000-0000-4000-8000-000000000001', 'road_times', 0) THEN
    RAISE EXCEPTION 'PROOF FAILED [once]: a saved run went back to road times';
  END IF;
  RAISE NOTICE 'ok: the write is all of the run or none of it, a refused day stands alone, and it happens once';
END $$;

-- ── Finish, and what the indicator reads ────────────────────────────────────
DO $$
DECLARE _f jsonb; _n int;
BEGIN
  -- Watching: the poll stamps watched_at while the run is going.
  PERFORM public.my_routing_runs(true, '{}');
  IF (SELECT watched_at FROM public.routing_runs WHERE id = '77000000-0000-4000-8000-000000000001') IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [watching]: watched_at was not stamped';
  END IF;
  _f := public.finish_routing_run('77000000-0000-4000-8000-000000000001', 'succeeded', '{"stops": 2}'::jsonb, NULL);
  IF NOT (_f->>'finished')::boolean OR _f->>'watched_at' IS NULL OR _f->>'applied_at' IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [finish]: %', _f;
  END IF;
  IF (public.finish_routing_run('77000000-0000-4000-8000-000000000001', 'failed', NULL, 'late')->>'finished')::boolean THEN
    RAISE EXCEPTION 'PROOF FAILED [finish]: a finished run was finished again';
  END IF;
  -- Finished and not yet looked at: still listed, so the header says "ready".
  SELECT count(*) INTO _n FROM public.my_routing_runs(false, '{}')
   WHERE id = '77000000-0000-4000-8000-000000000001' AND status = 'succeeded';
  IF _n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED [ready]: the finished run is not listed'; END IF;
  RAISE NOTICE 'ok: a run finishes once, keeps who was watching, and is listed until it is looked at';
END $$;
RESET ROLE;

-- Dee cannot mark Olivia's run seen (it would hide it from her).
SELECT pg_temp.act_as('a5000000-0000-4000-8000-00000000a002');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF public.routing_run_seen('77000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'PROOF FAILED [seen]: somebody else marked the run seen';
  END IF;
  -- Without the id, Dee's list does not include Olivia's run at all.
  IF EXISTS (SELECT 1 FROM public.my_routing_runs(false, '{}')) THEN
    RAISE EXCEPTION 'PROOF FAILED [seen]: another person''s run is in the dispatcher''s list';
  END IF;
  RAISE NOTICE 'ok: only the starter clears a run, and nobody else lists it unasked';
END $$;
RESET ROLE;

SELECT pg_temp.act_as('a5000000-0000-4000-8000-00000000a001');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _d date := (SELECT d FROM proof_day); _r jsonb; _caught boolean := false;
BEGIN
  IF NOT public.routing_run_seen('77000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'PROOF FAILED [seen]: the starter could not mark her run seen';
  END IF;
  IF EXISTS (SELECT 1 FROM public.my_routing_runs(false, '{}') WHERE id = '77000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'PROOF FAILED [seen]: a seen run is still listed';
  END IF;

  -- Succeeded means saved. A run that never wrote cannot say it succeeded.
  _r := public.start_routing_run('77000000-0000-4000-8000-000000000003', '0a500000-0000-4000-8000-0000000000aa',
                                 _d, _d, ARRAY['5e000000-0000-4000-8000-000000000003']::uuid[], 'org');
  IF (_r->>'attached')::boolean THEN
    RAISE EXCEPTION 'PROOF FAILED [slot]: the finished run still holds the organization''s slot';
  END IF;
  BEGIN
    PERFORM public.finish_routing_run('77000000-0000-4000-8000-000000000003', 'succeeded', NULL, NULL);
  EXCEPTION WHEN check_violation THEN _caught := true;
  END;
  IF NOT _caught THEN
    RAISE EXCEPTION 'PROOF FAILED [succeeded means saved]: a run that wrote nothing finished as succeeded';
  END IF;
  RAISE NOTICE 'ok: a seen run leaves the list, the slot frees on finish, and succeeded requires a save';
END $$;
RESET ROLE;

-- ── Abandonment ─────────────────────────────────────────────────────────────
-- Run 3 goes silent: its heartbeat is four minutes old. (Set as the table's
-- owner: nothing in the API can move updated_at backwards.)
UPDATE public.routing_runs SET updated_at = now() - interval '4 minutes'
 WHERE id = '77000000-0000-4000-8000-000000000003';

SELECT pg_temp.act_as('a5000000-0000-4000-8000-00000000a001');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _d date := (SELECT d FROM proof_day); _r jsonb; _row record; _caught boolean := false;
BEGIN
  -- The next press declares it abandoned and takes the slot.
  _r := public.start_routing_run('77000000-0000-4000-8000-000000000004', '0a500000-0000-4000-8000-0000000000aa',
                                 _d, _d, ARRAY['5e000000-0000-4000-8000-000000000003']::uuid[], 'org');
  IF (_r->>'attached')::boolean OR _r->>'run_id' <> '77000000-0000-4000-8000-000000000004' THEN
    RAISE EXCEPTION 'PROOF FAILED [abandoned]: a silent run still blocked the next press: %', _r;
  END IF;
  SELECT * INTO _row FROM public.routing_runs WHERE id = '77000000-0000-4000-8000-000000000003';
  IF _row.status <> 'failed' OR _row.error <> 'abandoned' OR _row.finished_at IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [abandoned]: % %', _row.status, _row.error;
  END IF;
  -- And the Worker that was slow rather than dead cannot write after it.
  BEGIN
    PERFORM public.apply_route_plans('77000000-0000-4000-8000-000000000003', true, '[]'::jsonb);
  EXCEPTION WHEN OTHERS THEN _caught := SQLERRM LIKE '%already ended%';
  END;
  IF NOT _caught THEN RAISE EXCEPTION 'PROOF FAILED [abandoned]: an abandoned run saved its plan'; END IF;
  IF public.routing_run_progress('77000000-0000-4000-8000-000000000003', 'saving', 1) THEN
    RAISE EXCEPTION 'PROOF FAILED [abandoned]: an abandoned run took a heartbeat';
  END IF;
  RAISE NOTICE 'ok: a silent run is declared abandoned by the next press, and can write nothing after';
END $$;
RESET ROLE;

-- The indicator declares it too, without waiting for a press.
UPDATE public.routing_runs SET updated_at = now() - interval '4 minutes'
 WHERE id = '77000000-0000-4000-8000-000000000004';
SELECT pg_temp.act_as('a5000000-0000-4000-8000-00000000a001');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _row record;
BEGIN
  SELECT * INTO _row FROM public.my_routing_runs(true, '{}') WHERE id = '77000000-0000-4000-8000-000000000004';
  IF _row.status IS DISTINCT FROM 'failed' OR _row.error IS DISTINCT FROM 'abandoned' THEN
    RAISE EXCEPTION 'PROOF FAILED [abandoned list]: the poll still says %', _row.status;
  END IF;
  RAISE NOTICE 'ok: the poll stops spinning for a run whose Worker is gone';
END $$;
RESET ROLE;

ROLLBACK;
\echo ALL ROUTING RUN PROOFS PASSED
