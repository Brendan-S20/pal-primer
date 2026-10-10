-- A window is kept and a skill is matched (appointment routing, phase 4),
-- proved against a real Postgres rather than read off the migration's text.
-- Run by tests/a-window-is-kept-and-a-skill-is-matched-in-a-real-database.test.ts,
-- which passes
--   :lines      20261008120000_a-dog-walker-should-not-have-to-learn-about-dump-sites.sql
--   :p1         20261009200000_a-walk-is-not-a-cleanup.sql (the catalog itself)
--   :p2         20261009230000_a-visit-knows-its-service.sql
--   :durations  20261009230100_a-walk-takes-as-long-as-the-walk.sql
--   :migration  20261010120000_a-window-is-kept-and-a-skill-is-matched.sql
-- The first four are applied only when the database does not have them yet:
-- the shared stack CI runs proofs against follows main, which may have none
-- of them (#358, #381, #384).
--
-- Everything happens inside one transaction that is ROLLED BACK at the end,
-- the migrations included. Each group prints "ok: ..." only when every check
-- in it passed, or raises "PROOF FAILED [...]", and ON_ERROR_STOP turns the
-- first failure into a non-zero exit.
--
-- The solver is TypeScript and is not here; what is here is the database's
-- half of each rule: who may read and write a skill, that the planner's read
-- carries skills and services, and that the planner's write takes a list of
-- stops left out on purpose and writes them as unassigned.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

-- The bases, in order, each only where the stack was built before it.
SELECT NOT EXISTS (
  SELECT 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'service_lines'
) AS need_lines \gset
\if :need_lines
\i :lines
\endif
SELECT to_regclass('public.services') IS NULL AS need_services \gset
\if :need_services
\i :p1
\endif
SELECT NOT EXISTS (
  SELECT 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'visits' AND column_name = 'service_id'
) AS need_service_ids \gset
\if :need_service_ids
\i :p2
\i :durations
\endif

-- ── Fixture ───────────────────────────────────────────────────────────────
-- A scoops and walks: an owner, a walker (Wren) and a scooper (Sid), both of
-- whom run routes. B is another business with an owner.
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('a5400000-0000-4000-8000-0000000000a1', 'owner-a@skills.proof.invalid'),
  ('a5400000-0000-4000-8000-0000000000a2', 'wren@skills.proof.invalid'),
  ('a5400000-0000-4000-8000-0000000000a3', 'sid@skills.proof.invalid'),
  ('a5400000-0000-4000-8000-0000000000b1', 'owner-b@skills.proof.invalid');
INSERT INTO public.organizations (id, name, timezone, work_days, service_lines) VALUES
  ('05400000-0000-4000-8000-0000000000aa', 'Skills Proof A', 'America/Chicago', '{0,1,2,3,4,5,6}', '{pet_waste,dog_walking}'),
  ('05400000-0000-4000-8000-0000000000bb', 'Skills Proof B', 'America/Chicago', '{0,1,2,3,4,5,6}', '{pet_waste}');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a5400000-0000-4000-8000-0000000000a1', '05400000-0000-4000-8000-0000000000aa', 'owner'),
  ('a5400000-0000-4000-8000-0000000000a2', '05400000-0000-4000-8000-0000000000aa', 'tech'),
  ('a5400000-0000-4000-8000-0000000000a3', '05400000-0000-4000-8000-0000000000aa', 'tech'),
  ('a5400000-0000-4000-8000-0000000000b1', '05400000-0000-4000-8000-0000000000bb', 'owner');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.staff (id, organization_id, user_id, role, display_name, active,
                          is_field_tech, is_field_tech_overridden, start_latitude, start_longitude) VALUES
  ('5e400000-0000-4000-8000-0000000000a2', '05400000-0000-4000-8000-0000000000aa',
   'a5400000-0000-4000-8000-0000000000a2', 'tech', 'Wren Walker', true, true, true, 41.90, -87.65),
  ('5e400000-0000-4000-8000-0000000000a3', '05400000-0000-4000-8000-0000000000aa',
   'a5400000-0000-4000-8000-0000000000a3', 'tech', 'Sid Scooper', true, true, true, 41.91, -87.66);

INSERT INTO public.services (id, organization_id, name, service_line, price_unit, base_price_cents, default_duration_min, active)
VALUES ('55400000-0000-4000-8000-0000000000a1', '05400000-0000-4000-8000-0000000000aa',
        '30-minute walk', 'dog_walking', 'visit', 2500, 30, true);

INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('c5400000-0000-4000-8000-0000000000a1', '05400000-0000-4000-8000-0000000000aa', 'residential', 'Skills Client Walk'),
  ('c5400000-0000-4000-8000-0000000000a2', '05400000-0000-4000-8000-0000000000aa', 'residential', 'Skills Client Yard'),
  ('c5400000-0000-4000-8000-0000000000a3', '05400000-0000-4000-8000-0000000000aa', 'residential', 'Skills Client Early');

INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code, latitude, longitude) VALUES
  ('e5400000-0000-4000-8000-0000000000a1', '05400000-0000-4000-8000-0000000000aa',
   'c5400000-0000-4000-8000-0000000000a1', '1 Walk St', 'Chicago', '60614', 41.92, -87.65),
  ('e5400000-0000-4000-8000-0000000000a2', '05400000-0000-4000-8000-0000000000aa',
   'c5400000-0000-4000-8000-0000000000a2', '2 Yard St', 'Chicago', '60614', 41.93, -87.66),
  ('e5400000-0000-4000-8000-0000000000a3', '05400000-0000-4000-8000-0000000000aa',
   'c5400000-0000-4000-8000-0000000000a3', '3 Far Rd', 'Chicago', '60614', 42.30, -87.65);

-- D is a week out on A's calendar.
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

-- A walk plan, a cleanup plan, and a walk plan with a window that closes five
-- minutes into the day at a house 40 km away (the solver's case; here it is
-- just a visit the plan may leave out).
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency,
                                  price_cents, dog_count, started_on, service_id, earliest_time, latest_time)
SELECT x.id::uuid, '05400000-0000-4000-8000-0000000000aa', x.client::uuid, x.prop::uuid, 'residential', 'weekly',
       2500, 1, p.d - 7, x.svc::uuid, x.e::time, x.l::time
  FROM proof_day p, (VALUES
    ('d5400000-0000-4000-8000-0000000000a1', 'c5400000-0000-4000-8000-0000000000a1',
     'e5400000-0000-4000-8000-0000000000a1', '55400000-0000-4000-8000-0000000000a1', NULL, NULL),
    ('d5400000-0000-4000-8000-0000000000a2', 'c5400000-0000-4000-8000-0000000000a2',
     'e5400000-0000-4000-8000-0000000000a2', pg_temp.pet_waste('05400000-0000-4000-8000-0000000000aa')::text, NULL, NULL),
    ('d5400000-0000-4000-8000-0000000000a3', 'c5400000-0000-4000-8000-0000000000a3',
     'e5400000-0000-4000-8000-0000000000a3', '55400000-0000-4000-8000-0000000000a1', '08:00', '08:05')
  ) AS x(id, client, prop, svc, e, l);

INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id, scheduled_on, status)
SELECT x.id::uuid, '05400000-0000-4000-8000-0000000000aa', x.sub::uuid, x.client::uuid, x.prop::uuid, p.d, 'scheduled'
  FROM proof_day p, (VALUES
    ('f5400000-0000-4000-8000-0000000000a1', 'd5400000-0000-4000-8000-0000000000a1',
     'c5400000-0000-4000-8000-0000000000a1', 'e5400000-0000-4000-8000-0000000000a1'),
    ('f5400000-0000-4000-8000-0000000000a2', 'd5400000-0000-4000-8000-0000000000a2',
     'c5400000-0000-4000-8000-0000000000a2', 'e5400000-0000-4000-8000-0000000000a2'),
    ('f5400000-0000-4000-8000-0000000000a3', 'd5400000-0000-4000-8000-0000000000a3',
     'c5400000-0000-4000-8000-0000000000a3', 'e5400000-0000-4000-8000-0000000000a3')
  ) AS x(id, sub, client, prop);

\i :migration

-- ── 1. Who may read and write a skill ─────────────────────────────────────
-- The owner gives Wren the walk; a service of another business is refused;
-- there is no UPDATE at all.
SELECT pg_temp.as_user('a5400000-0000-4000-8000-0000000000a1');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  INSERT INTO public.staff_services (staff_id, service_id, organization_id) VALUES
    ('5e400000-0000-4000-8000-0000000000a2', '55400000-0000-4000-8000-0000000000a1',
     '05400000-0000-4000-8000-0000000000aa');
  BEGIN
    INSERT INTO public.staff_services (staff_id, service_id, organization_id) VALUES
      ('5e400000-0000-4000-8000-0000000000a2', pg_temp.pet_waste('05400000-0000-4000-8000-0000000000bb'),
       '05400000-0000-4000-8000-0000000000aa');
    RAISE EXCEPTION 'PROOF FAILED [skills]: a skill named another business''s service';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.staff_services SET service_id = pg_temp.pet_waste('05400000-0000-4000-8000-0000000000aa')
     WHERE staff_id = '5e400000-0000-4000-8000-0000000000a2';
    RAISE EXCEPTION 'PROOF FAILED [skills]: a skill row was updated; a skill is given or taken away';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;

-- Wren reads her business's skills and can neither give nor take one.
SELECT pg_temp.as_user('a5400000-0000-4000-8000-0000000000a2');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _n integer;
BEGIN
  SELECT count(*) INTO _n FROM public.staff_services;
  IF _n <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [skills]: a tech reads % skill rows of their own business, expected 1', _n;
  END IF;
  BEGIN
    INSERT INTO public.staff_services (staff_id, service_id, organization_id) VALUES
      ('5e400000-0000-4000-8000-0000000000a3', '55400000-0000-4000-8000-0000000000a1',
       '05400000-0000-4000-8000-0000000000aa');
    RAISE EXCEPTION 'PROOF FAILED [skills]: a tech gave a colleague a skill';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  DELETE FROM public.staff_services WHERE staff_id = '5e400000-0000-4000-8000-0000000000a2';
  IF FOUND THEN
    RAISE EXCEPTION 'PROOF FAILED [skills]: a tech took a skill away';
  END IF;
END $$;
RESET ROLE;

-- B's owner sees none of it; anon holds nothing.
SELECT pg_temp.as_user('a5400000-0000-4000-8000-0000000000b1');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _n integer;
BEGIN
  SELECT count(*) INTO _n FROM public.staff_services;
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [skills]: another business''s owner reads % skill rows', _n;
  END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM 1 FROM public.staff_services;
    RAISE EXCEPTION 'PROOF FAILED [skills]: anon read staff_services';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok: members read skills; the owner gives and takes them inside the business; a tech, another business and anon cannot';
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

-- ── 2. The planner's read carries the skills, the services and the names ──
SELECT pg_temp.as_user('a5400000-0000-4000-8000-0000000000a1');
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  _d date := (SELECT d FROM proof_day);
  _in jsonb;
  _wren jsonb; _sid jsonb; _walk jsonb;
BEGIN
  _in := public.route_day_inputs('05400000-0000-4000-8000-0000000000aa',
           ARRAY['5e400000-0000-4000-8000-0000000000a2', '5e400000-0000-4000-8000-0000000000a3']::uuid[], _d, true);
  SELECT t INTO _wren FROM jsonb_array_elements(_in->'techs') t WHERE t->>'id' = '5e400000-0000-4000-8000-0000000000a2';
  SELECT t INTO _sid  FROM jsonb_array_elements(_in->'techs') t WHERE t->>'id' = '5e400000-0000-4000-8000-0000000000a3';
  IF _wren->'services' IS DISTINCT FROM jsonb_build_array('55400000-0000-4000-8000-0000000000a1') THEN
    RAISE EXCEPTION 'PROOF FAILED [inputs]: Wren''s skills read as %, expected the walk', _wren->'services';
  END IF;
  IF jsonb_typeof(_sid->'services') IS DISTINCT FROM 'null' THEN
    RAISE EXCEPTION 'PROOF FAILED [inputs]: Sid has no skill rows and should read as null (any service), got %', _sid->'services';
  END IF;
  SELECT v INTO _walk FROM jsonb_array_elements(_in->'visits') v WHERE v->>'id' = 'f5400000-0000-4000-8000-0000000000a1';
  IF _walk->>'service_id' IS DISTINCT FROM '55400000-0000-4000-8000-0000000000a1'
     OR _walk->>'service' IS DISTINCT FROM '30-minute walk'
     OR _walk->>'client' IS DISTINCT FROM 'Skills Client Walk' THEN
    RAISE EXCEPTION 'PROOF FAILED [inputs]: the walk visit reads as %', _walk;
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(_in->'visits') v WHERE v->>'service_id' IS NULL) <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [inputs]: a visit came back with no service';
  END IF;
  RAISE NOTICE 'ok: route_day_inputs carries each technician''s skills (null when none) and each visit''s service and client';
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

-- ── 3. The planner's write takes the stops left out ───────────────────────
SELECT pg_temp.as_user('a5400000-0000-4000-8000-0000000000a1');
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  _d date := (SELECT d FROM proof_day);
  _org constant uuid := '05400000-0000-4000-8000-0000000000aa';
  _crew constant uuid[] := ARRAY['5e400000-0000-4000-8000-0000000000a2', '5e400000-0000-4000-8000-0000000000a3']::uuid[];
  _wren constant uuid := '5e400000-0000-4000-8000-0000000000a2';
  _sid constant uuid := '5e400000-0000-4000-8000-0000000000a3';
  _v1 constant uuid := 'f5400000-0000-4000-8000-0000000000a1';
  _v2 constant uuid := 'f5400000-0000-4000-8000-0000000000a2';
  _v3 constant uuid := 'f5400000-0000-4000-8000-0000000000a3';
  _out jsonb;
  _r record;
  _routes jsonb := jsonb_build_array(
    jsonb_build_object('staff_id', _wren, 'visit_ids', jsonb_build_array(_v1)),
    jsonb_build_object('staff_id', _sid,  'visit_ids', jsonb_build_array(_v2)));
BEGIN
  -- First, every stop routed, through the six-argument call every existing
  -- caller makes: it still resolves, and gives the far visit an ETA.
  _out := public.apply_route_plan(_org, _crew, _d, true,
            jsonb_build_array(
              jsonb_build_object('staff_id', _wren, 'visit_ids', jsonb_build_array(_v1, _v3)),
              jsonb_build_object('staff_id', _sid,  'visit_ids', jsonb_build_array(_v2))), true);
  SELECT assigned_staff_id, sequence, eta_start INTO _r FROM public.visits WHERE id = _v3;
  IF _r.assigned_staff_id IS DISTINCT FROM _wren OR _r.sequence IS NULL OR _r.eta_start IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [write]: the six-argument call did not route the far visit (%)', _r;
  END IF;
  IF _out->'unassigned' IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'PROOF FAILED [write]: a plan that routes everything reports % unassigned', _out->'unassigned';
  END IF;

  -- A stop may not be both routed and left out.
  BEGIN
    PERFORM public.apply_route_plan(_org, _crew, _d, true,
              jsonb_build_array(
                jsonb_build_object('staff_id', _wren, 'visit_ids', jsonb_build_array(_v1, _v3)),
                jsonb_build_object('staff_id', _sid,  'visit_ids', jsonb_build_array(_v2))),
              true, ARRAY[_v3]);
    RAISE EXCEPTION 'PROOF FAILED [write]: a stop both routed and left out was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%both routes a stop and leaves it unassigned%' THEN RAISE; END IF;
  END;

  -- A stop neither routed nor listed is still "the day changed".
  BEGIN
    PERFORM public.apply_route_plan(_org, _crew, _d, true, _routes, true, NULL);
    RAISE EXCEPTION 'PROOF FAILED [write]: a plan missing a stop, with nothing listed, was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%day changed while it was being planned%' THEN RAISE; END IF;
  END;

  -- A listed stop that is not in play is too.
  BEGIN
    PERFORM public.apply_route_plan(_org, _crew, _d, true, _routes, true,
              ARRAY[_v3, 'f5400000-0000-4000-8000-00000000ffff'::uuid]);
    RAISE EXCEPTION 'PROOF FAILED [write]: a plan leaving out a stop that is not in play was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%day changed while it was being planned%' THEN RAISE; END IF;
  END;

  -- The plan that leaves the far visit out: accepted, and the visit is
  -- written as unassigned -- no technician (reassign), no order, no time.
  _out := public.apply_route_plan(_org, _crew, _d, true, _routes, true, ARRAY[_v3]);
  SELECT assigned_staff_id, sequence, eta_start, eta_end, travel_min, window_violated INTO _r
    FROM public.visits WHERE id = _v3;
  IF _r.assigned_staff_id IS NOT NULL OR _r.sequence IS NOT NULL OR _r.eta_start IS NOT NULL
     OR _r.eta_end IS NOT NULL OR _r.travel_min IS NOT NULL OR _r.window_violated THEN
    RAISE EXCEPTION 'PROOF FAILED [write]: the left-out visit was not cleared (%)', _r;
  END IF;
  IF _out->'unassigned' IS DISTINCT FROM jsonb_build_array(_v3) THEN
    RAISE EXCEPTION 'PROOF FAILED [write]: the write reports % unassigned, expected the far visit', _out->'unassigned';
  END IF;
  SELECT assigned_staff_id, sequence, eta_start INTO _r FROM public.visits WHERE id = _v1;
  IF _r.assigned_staff_id IS DISTINCT FROM _wren OR _r.sequence <> 1 OR _r.eta_start IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [write]: the walk was not written beside the left-out stop (%)', _r;
  END IF;
  IF (_out->'staff'->0->>'stops')::int + (_out->'staff'->1->>'stops')::int <> 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [write]: the summary counts % stops, expected 2', _out->'staff';
  END IF;

  -- Without reassign the assignment stands and only the order and the times
  -- go: put the far visit back on Wren, then leave it out with reassign off.
  PERFORM public.apply_route_plan(_org, _crew, _d, true,
            jsonb_build_array(
              jsonb_build_object('staff_id', _wren, 'visit_ids', jsonb_build_array(_v1, _v3)),
              jsonb_build_object('staff_id', _sid,  'visit_ids', jsonb_build_array(_v2))), true);
  PERFORM public.apply_route_plan(_org, _crew, _d, false, _routes, true, ARRAY[_v3]);
  SELECT assigned_staff_id, sequence, eta_start INTO _r FROM public.visits WHERE id = _v3;
  IF _r.assigned_staff_id IS DISTINCT FROM _wren OR _r.sequence IS NOT NULL OR _r.eta_start IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [write]: without reassign the left-out visit should keep Wren and lose its time (%)', _r;
  END IF;
  RAISE NOTICE 'ok: apply_route_plan takes the stops left out, writes them as unassigned, and still refuses a plan for another day';
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

-- ── 4. The run's write passes the list through ────────────────────────────
SELECT pg_temp.as_user('a5400000-0000-4000-8000-0000000000a1');
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  _d date := (SELECT d FROM proof_day);
  _run constant uuid := '75400000-0000-4000-8000-0000000000a1';
  _started jsonb; _out jsonb;
  _r record;
BEGIN
  _started := public.start_routing_run(_run, '05400000-0000-4000-8000-0000000000aa', _d, _d,
                ARRAY['5e400000-0000-4000-8000-0000000000a2', '5e400000-0000-4000-8000-0000000000a3']::uuid[], 'org');
  IF (_started->>'attached')::boolean THEN
    RAISE EXCEPTION 'PROOF FAILED [run]: the run attached to another instead of starting';
  END IF;
  _out := public.apply_route_plans(_run, true, jsonb_build_array(jsonb_build_object(
            'day', _d,
            'routes', jsonb_build_array(
              jsonb_build_object('staff_id', '5e400000-0000-4000-8000-0000000000a2',
                                 'visit_ids', jsonb_build_array('f5400000-0000-4000-8000-0000000000a1')),
              jsonb_build_object('staff_id', '5e400000-0000-4000-8000-0000000000a3',
                                 'visit_ids', jsonb_build_array('f5400000-0000-4000-8000-0000000000a2'))),
            'unassigned', jsonb_build_array('f5400000-0000-4000-8000-0000000000a3'),
            'honour_windows', true)));
  IF NOT (_out->0->>'ok')::boolean THEN
    RAISE EXCEPTION 'PROOF FAILED [run]: apply_route_plans refused the day: %', _out->0->>'error';
  END IF;
  SELECT assigned_staff_id, sequence INTO _r FROM public.visits WHERE id = 'f5400000-0000-4000-8000-0000000000a3';
  IF _r.assigned_staff_id IS NOT NULL OR _r.sequence IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [run]: the run''s write did not leave the listed stop unassigned (%)', _r;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.routing_runs WHERE id = _run AND applied_at IS NOT NULL) THEN
    RAISE EXCEPTION 'PROOF FAILED [run]: the run was not stamped applied';
  END IF;
  RAISE NOTICE 'ok: apply_route_plans passes each day''s unassigned list through to apply_route_plan';
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

ROLLBACK;
\echo ALL WINDOW-AND-SKILL PROOFS PASSED
