-- A visit knows its service (the service catalog, phase 2), proved against a
-- real Postgres rather than read off the migrations' text. Run by
-- tests/a-visit-knows-its-service-in-a-real-database.test.ts, which passes
--   :lines      20261008120000_a-dog-walker-should-not-have-to-learn-about-dump-sites.sql
--   :p1         20261009200000_a-walk-is-not-a-cleanup.sql (the catalog itself)
--   :migration  20261009230000_a-visit-knows-its-service.sql
--   :durations  20261009230100_a-walk-takes-as-long-as-the-walk.sql
-- The first two are applied only when the database does not have them yet:
-- the shared stack CI runs proofs against follows main, which may have
-- neither (#358, #381).
--
-- Everything happens inside one transaction that is ROLLED BACK at the end,
-- the migrations included. Each group prints "ok: ..." only when every check
-- in it passed, or raises "PROOF FAILED [...]", and ON_ERROR_STOP turns the
-- first failure into a non-zero exit.
--
-- Days are relative to the org's own today (America/Chicago), never
-- hard-coded, so this passes on any date.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

-- The two bases, in order, inside this same rolled-back transaction, each only
-- where the stack was built before it: organizations.service_lines (#358),
-- then public.services (#381).
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

-- ── Fixture, BEFORE the migration, so the backfill has rows to find ───────
-- A runs pet waste (owner, tech who runs routes). B only walks dogs (owner).
-- C runs pet waste and was created after P1's seed, so it has no service.
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('a5230000-0000-4000-8000-0000000000a1', 'owner-a@visit-service.proof.invalid'),
  ('a5230000-0000-4000-8000-0000000000a3', 'tech-a@visit-service.proof.invalid'),
  ('a5230000-0000-4000-8000-0000000000b1', 'owner-b@visit-service.proof.invalid');
INSERT INTO public.organizations (id, name, timezone, work_days, service_lines) VALUES
  ('05230000-0000-4000-8000-0000000000aa', 'Visit Service Proof A', 'America/Chicago', '{0,1,2,3,4,5,6}', '{pet_waste}'),
  ('05230000-0000-4000-8000-0000000000bb', 'Visit Service Proof B', 'America/Chicago', '{0,1,2,3,4,5,6}', '{dog_walking}'),
  ('05230000-0000-4000-8000-0000000000cc', 'Visit Service Proof C', 'America/Chicago', '{0,1,2,3,4,5,6}', '{pet_waste}');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a5230000-0000-4000-8000-0000000000a1', '05230000-0000-4000-8000-0000000000aa', 'owner'),
  ('a5230000-0000-4000-8000-0000000000a3', '05230000-0000-4000-8000-0000000000aa', 'tech'),
  ('a5230000-0000-4000-8000-0000000000b1', '05230000-0000-4000-8000-0000000000bb', 'owner');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.staff (id, organization_id, user_id, role, display_name, active,
                          is_field_tech, is_field_tech_overridden) VALUES
  ('5e230000-0000-4000-8000-0000000000a3', '05230000-0000-4000-8000-0000000000aa',
   'a5230000-0000-4000-8000-0000000000a3', 'tech', 'Tess Walker', true, true, true);

INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('c5230000-0000-4000-8000-0000000000a1', '05230000-0000-4000-8000-0000000000aa', 'residential', 'Visit Service Client A1'),
  ('c5230000-0000-4000-8000-0000000000a2', '05230000-0000-4000-8000-0000000000aa', 'residential', 'Visit Service Client A2'),
  ('c5230000-0000-4000-8000-0000000000b1', '05230000-0000-4000-8000-0000000000bb', 'residential', 'Visit Service Client B1');

-- The yard says 12 minutes at A1 and A2.
INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code, latitude, longitude, service_duration_min) VALUES
  ('e5230000-0000-4000-8000-0000000000a1', '05230000-0000-4000-8000-0000000000aa',
   'c5230000-0000-4000-8000-0000000000a1', '412 Elm St', 'Chicago', '60614', 41.92, -87.65, 12),
  ('e5230000-0000-4000-8000-0000000000a2', '05230000-0000-4000-8000-0000000000aa',
   'c5230000-0000-4000-8000-0000000000a2', '9 Ash St', 'Chicago', '60614', 41.93, -87.66, 12),
  ('e5230000-0000-4000-8000-0000000000b1', '05230000-0000-4000-8000-0000000000bb',
   'c5230000-0000-4000-8000-0000000000b1', '1 Other Rd', 'Chicago', '60615', 41.80, -87.60, 8);

-- D is a week out on A's calendar, so no "today" rule can touch it.
CREATE TEMP TABLE proof_day ON COMMIT DROP AS
  SELECT ((now() AT TIME ZONE 'America/Chicago')::date + 7) AS d,
         (now() AT TIME ZONE 'America/Chicago')::date AS today;
GRANT SELECT ON proof_day TO authenticated, anon;

-- A's pet-waste plan with three visits: last week's (scheduled, never
-- closed), D's, and D+7's (canceled). B's plan with none.
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency, price_cents, dog_count, started_on)
SELECT x.id::uuid, x.org::uuid, x.client::uuid, x.prop::uuid, 'residential', 'weekly', 2500, 1, p.today - 14
  FROM proof_day p, (VALUES
    ('d5230000-0000-4000-8000-0000000000a1', '05230000-0000-4000-8000-0000000000aa',
     'c5230000-0000-4000-8000-0000000000a1', 'e5230000-0000-4000-8000-0000000000a1'),
    ('d5230000-0000-4000-8000-0000000000b1', '05230000-0000-4000-8000-0000000000bb',
     'c5230000-0000-4000-8000-0000000000b1', 'e5230000-0000-4000-8000-0000000000b1')
  ) AS x(id, org, client, prop);

INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id, scheduled_on, status)
SELECT x.id::uuid, '05230000-0000-4000-8000-0000000000aa', 'd5230000-0000-4000-8000-0000000000a1',
       'c5230000-0000-4000-8000-0000000000a1', 'e5230000-0000-4000-8000-0000000000a1', p.d + x.offs, x.status::visit_status
  FROM proof_day p, (VALUES
    ('f5230000-0000-4000-8000-0000000000a1', -14, 'scheduled'),
    ('f5230000-0000-4000-8000-0000000000a2', 0, 'scheduled'),
    ('f5230000-0000-4000-8000-0000000000a3', 7, 'canceled')
  ) AS x(id, offs, status);

-- Whatever this database already holds, put the fixture back in the state
-- the backfill is for: C has no service at all, and nothing of A's or B's
-- points at one. (On a database that already has phase 2 the triggers have
-- filled these in; setting service_id to NULL is allowed until NOT NULL.)
DO $reset$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'visits' AND column_name = 'service_id') THEN
    EXECUTE $q$UPDATE public.visits SET service_id = NULL
                WHERE organization_id IN ('05230000-0000-4000-8000-0000000000aa', '05230000-0000-4000-8000-0000000000bb')$q$;
    EXECUTE $q$UPDATE public.subscriptions SET service_id = NULL
                WHERE organization_id IN ('05230000-0000-4000-8000-0000000000aa', '05230000-0000-4000-8000-0000000000bb')$q$;
  END IF;
  DELETE FROM public.services WHERE organization_id = '05230000-0000-4000-8000-0000000000cc';
END
$reset$;

\i :migration
-- Only where the stack lacks it: 20261009230100 restates apply_route_plan
-- with six arguments, and a stack that already carries the seven-argument
-- one (20261010200000) would end up with both, and every call ambiguous.
SELECT to_regprocedure('public.stop_service_min(integer, integer)') IS NULL AS need_durations \gset
\if :need_durations
\i :durations
\endif

CREATE FUNCTION pg_temp.as_user(_uid text, _aal text DEFAULT 'aal1') RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
           json_build_object('sub', _uid, 'role', 'authenticated', 'aal', _aal)::text, true);
$$;
CREATE FUNCTION pg_temp.pet_waste(_org uuid) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM public.services WHERE organization_id = _org AND lower(name) = 'pet waste removal';
$$;

-- ── 1. The backfill ───────────────────────────────────────────────────────
DO $$
DECLARE
  _a uuid := pg_temp.pet_waste('05230000-0000-4000-8000-0000000000aa');
  _b uuid := pg_temp.pet_waste('05230000-0000-4000-8000-0000000000bb');
  _c record;
  _n integer;
BEGIN
  IF _a IS NULL OR _b IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [backfill]: a business that existed has no Pet waste removal';
  END IF;
  IF (SELECT service_id FROM public.subscriptions WHERE id = 'd5230000-0000-4000-8000-0000000000a1') IS DISTINCT FROM _a
     OR (SELECT service_id FROM public.subscriptions WHERE id = 'd5230000-0000-4000-8000-0000000000b1') IS DISTINCT FROM _b THEN
    RAISE EXCEPTION 'PROOF FAILED [backfill]: a plan does not point at its own business''s Pet waste removal';
  END IF;
  SELECT count(*) INTO _n FROM public.visits
   WHERE subscription_id = 'd5230000-0000-4000-8000-0000000000a1' AND service_id IS DISTINCT FROM _a;
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [backfill]: % of A''s visits do not point at A''s Pet waste removal', _n;
  END IF;
  -- C existed, had no service, and now has the one P1 would have given it.
  SELECT * INTO _c FROM public.services WHERE organization_id = '05230000-0000-4000-8000-0000000000cc';
  IF _c.id IS NULL OR lower(_c.name) <> 'pet waste removal' OR _c.service_line <> 'pet_waste'
     OR NOT _c.active OR _c.base_price_cents IS NOT NULL OR _c.default_duration_min IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [backfill]: a business created after the seed has no default service';
  END IF;
  RAISE NOTICE 'ok: every plan and visit points at its business''s Pet waste removal, and a business created after the seed got one';
END $$;

-- ── 2. A new business gets its default service, and a plan defaults to it ─
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO public.organizations (id, name, timezone, service_lines) VALUES
  ('05230000-0000-4000-8000-0000000000dd', 'Visit Service Proof D', 'America/Chicago', '{dog_walking}'),
  ('05230000-0000-4000-8000-0000000000ee', 'Visit Service Proof E', 'America/Chicago', '{pet_waste,dog_walking}');
SET LOCAL app.allow_protected_org_write = '';
DO $$
DECLARE _d record; _e record; _sub uuid;
BEGIN
  SELECT * INTO _d FROM public.services WHERE organization_id = '05230000-0000-4000-8000-0000000000dd';
  SELECT * INTO _e FROM public.services WHERE organization_id = '05230000-0000-4000-8000-0000000000ee';
  IF _d.id IS NULL OR _e.id IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [new org]: a business created now has no default service';
  END IF;
  IF _d.active OR NOT _e.active THEN
    RAISE EXCEPTION 'PROOF FAILED [new org]: the default is active for a walker (%) or inactive for a scooper (%)', _d.active, _e.active;
  END IF;
  IF (SELECT count(*) FROM public.services
       WHERE organization_id IN ('05230000-0000-4000-8000-0000000000dd', '05230000-0000-4000-8000-0000000000ee')) <> 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [new org]: a new business got more than one default service';
  END IF;

  INSERT INTO public.subscriptions (organization_id, client_id, property_id, account_type, frequency, price_cents, dog_count)
  VALUES ('05230000-0000-4000-8000-0000000000aa', 'c5230000-0000-4000-8000-0000000000a1',
          'e5230000-0000-4000-8000-0000000000a1', 'residential', 'monthly', 4000, 1)
  RETURNING id INTO _sub;
  IF (SELECT service_id FROM public.subscriptions WHERE id = _sub)
     IS DISTINCT FROM pg_temp.pet_waste('05230000-0000-4000-8000-0000000000aa') THEN
    RAISE EXCEPTION 'PROOF FAILED [new plan]: a plan saved without a service did not get the business''s default';
  END IF;
  DELETE FROM public.subscriptions WHERE id = _sub;

  -- A business that renamed its pet-waste service is not handed a second one.
  UPDATE public.services SET name = 'Scooping' WHERE organization_id = '05230000-0000-4000-8000-0000000000ee';
  IF public.ensure_default_services('05230000-0000-4000-8000-0000000000ee') IS DISTINCT FROM _e.id
     OR (SELECT count(*) FROM public.services WHERE organization_id = '05230000-0000-4000-8000-0000000000ee') <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [renamed]: a renamed pet-waste service was duplicated';
  END IF;
  RAISE NOTICE 'ok: a new business gets one default service (active only if it runs pet waste), a plan without a service gets it, and a renamed one is not duplicated';
END $$;

-- ── 3. Generation copies the plan's service onto every visit ───────────────
INSERT INTO public.services (id, organization_id, name, service_line, price_unit, base_price_cents, default_duration_min)
VALUES ('55230000-0000-4000-8000-0000000000a1', '05230000-0000-4000-8000-0000000000aa',
        '45-minute walk', 'dog_walking', 'visit', 3000, 45),
       ('55230000-0000-4000-8000-0000000000b1', '05230000-0000-4000-8000-0000000000bb',
        '30-minute walk', 'dog_walking', 'visit', 2500, 30);
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency, price_cents, dog_count, started_on, service_id)
SELECT 'd5230000-0000-4000-8000-0000000000a2', '05230000-0000-4000-8000-0000000000aa',
       'c5230000-0000-4000-8000-0000000000a2', 'e5230000-0000-4000-8000-0000000000a2',
       'residential', 'weekly', 3000, 1, p.d, '55230000-0000-4000-8000-0000000000a1'
  FROM proof_day p;
DO $$
DECLARE _d date := (SELECT d FROM proof_day); _n integer; _bad integer;
  _a uuid := pg_temp.pet_waste('05230000-0000-4000-8000-0000000000aa');
BEGIN
  PERFORM public.generate_visits_core('05230000-0000-4000-8000-0000000000aa', _d + 21, 'd5230000-0000-4000-8000-0000000000a2');
  PERFORM public.generate_visits_core('05230000-0000-4000-8000-0000000000aa', _d + 21, 'd5230000-0000-4000-8000-0000000000a1');

  SELECT count(*), count(*) FILTER (WHERE service_id IS DISTINCT FROM '55230000-0000-4000-8000-0000000000a1')
    INTO _n, _bad FROM public.visits WHERE subscription_id = 'd5230000-0000-4000-8000-0000000000a2';
  IF _n < 4 THEN
    RAISE EXCEPTION 'PROOF FAILED [generate]: the walk plan generated % visits through D+21, expected 4', _n;
  END IF;
  IF _bad <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [generate]: % generated visits of the walk plan are not walks', _bad;
  END IF;

  SELECT count(*), count(*) FILTER (WHERE service_id IS DISTINCT FROM _a)
    INTO _n, _bad FROM public.visits
   WHERE subscription_id = 'd5230000-0000-4000-8000-0000000000a1' AND scheduled_on > _d + 7;
  IF _n < 2 OR _bad <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [generate]: the pet-waste plan generated % visits, % of them not pet waste', _n, _bad;
  END IF;
  RAISE NOTICE 'ok: a visit generated from a plan carries the plan''s service';
END $$;

-- ── 4. A plan's new service reaches the visits that have not happened ─────
DO $$
DECLARE _d date := (SELECT d FROM proof_day);
  _a uuid := pg_temp.pet_waste('05230000-0000-4000-8000-0000000000aa');
  _walk constant uuid := '55230000-0000-4000-8000-0000000000a1';
  _bad integer;
BEGIN
  UPDATE public.subscriptions SET service_id = _walk WHERE id = 'd5230000-0000-4000-8000-0000000000a1';
  SELECT count(*) INTO _bad FROM public.visits
   WHERE subscription_id = 'd5230000-0000-4000-8000-0000000000a1'
     AND status = 'scheduled' AND scheduled_on >= _d AND service_id IS DISTINCT FROM _walk;
  IF _bad <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [plan change]: % upcoming visits kept the old service', _bad;
  END IF;
  IF (SELECT service_id FROM public.visits WHERE id = 'f5230000-0000-4000-8000-0000000000a1') IS DISTINCT FROM _a THEN
    RAISE EXCEPTION 'PROOF FAILED [plan change]: a visit from last week was rewritten';
  END IF;
  IF (SELECT service_id FROM public.visits WHERE id = 'f5230000-0000-4000-8000-0000000000a3') IS DISTINCT FROM _a THEN
    RAISE EXCEPTION 'PROOF FAILED [plan change]: a canceled visit was rewritten';
  END IF;
  -- Put it back: pet waste, as the rest of the proof expects.
  UPDATE public.subscriptions SET service_id = _a WHERE id = 'd5230000-0000-4000-8000-0000000000a1';
  IF (SELECT service_id FROM public.visits WHERE id = 'f5230000-0000-4000-8000-0000000000a2') IS DISTINCT FROM _a THEN
    RAISE EXCEPTION 'PROOF FAILED [plan change]: changing it back did not reach D''s visit';
  END IF;
  RAISE NOTICE 'ok: changing a plan''s service moves its upcoming scheduled visits and leaves the past and the canceled alone';
END $$;

-- ── 5. Another business's service is refused everywhere ───────────────────
DO $$
DECLARE _theirs constant uuid := '55230000-0000-4000-8000-0000000000b1';
BEGIN
  BEGIN
    INSERT INTO public.subscriptions (organization_id, client_id, property_id, account_type, frequency, price_cents, dog_count, service_id)
    VALUES ('05230000-0000-4000-8000-0000000000aa', 'c5230000-0000-4000-8000-0000000000a1',
            'e5230000-0000-4000-8000-0000000000a1', 'residential', 'weekly', 2500, 1, _theirs);
    RAISE EXCEPTION 'PROOF FAILED [cross-org]: a plan was sold as another business''s service';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.subscriptions SET service_id = _theirs WHERE id = 'd5230000-0000-4000-8000-0000000000a2';
    RAISE EXCEPTION 'PROOF FAILED [cross-org]: a plan was moved onto another business''s service';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.visits SET service_id = _theirs WHERE id = 'f5230000-0000-4000-8000-0000000000a2';
    RAISE EXCEPTION 'PROOF FAILED [cross-org]: a visit was moved onto another business''s service';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.visits (organization_id, client_id, property_id, scheduled_on, service_id)
    SELECT '05230000-0000-4000-8000-0000000000aa', 'c5230000-0000-4000-8000-0000000000a1',
           'e5230000-0000-4000-8000-0000000000a1', d + 3, _theirs FROM proof_day;
    RAISE EXCEPTION 'PROOF FAILED [cross-org]: a visit was booked as another business''s service';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.subscriptions SET service_id = gen_random_uuid() WHERE id = 'd5230000-0000-4000-8000-0000000000a2';
    RAISE EXCEPTION 'PROOF FAILED [fk]: a plan points at a service that does not exist';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  RAISE NOTICE 'ok: another business''s service is refused on a plan and a visit, on insert and on update';
END $$;

-- ── 6. The office decides what a visit is; a tech does not ───────────────
UPDATE public.visits SET assigned_staff_id = '5e230000-0000-4000-8000-0000000000a3'
 WHERE id = 'f5230000-0000-4000-8000-0000000000a2';
SELECT pg_temp.as_user('a5230000-0000-4000-8000-0000000000a3');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    UPDATE public.visits SET service_id = '55230000-0000-4000-8000-0000000000a1'
     WHERE id = 'f5230000-0000-4000-8000-0000000000a2';
    IF FOUND THEN
      RAISE EXCEPTION 'PROOF FAILED [tech]: a tech changed the service of their own visit';
    END IF;
    RAISE EXCEPTION 'PROOF FAILED [tech]: the tech''s update matched nothing, so the guard was never asked';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- A tech still reads what the stop is (My Day's card).
  IF (SELECT s.name FROM public.visits v JOIN public.services s ON s.id = v.service_id
       WHERE v.id = 'f5230000-0000-4000-8000-0000000000a2') IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [tech]: a tech cannot read the service of their own stop';
  END IF;
END $$;
RESET ROLE;
SELECT pg_temp.as_user('a5230000-0000-4000-8000-0000000000a1');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _n integer;
BEGIN
  WITH u AS (
    UPDATE public.visits SET service_id = '55230000-0000-4000-8000-0000000000a1'
     WHERE id = 'f5230000-0000-4000-8000-0000000000a1' RETURNING id
  ) SELECT count(*) INTO _n FROM u;
  IF _n <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [office]: the owner''s change of a visit''s service matched % rows', _n;
  END IF;
  RAISE NOTICE 'ok: a tech cannot change what a visit is but can read it; the owner can change it';
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

-- ── 7. The planner reads the service's minutes, else the yard's ───────────
SELECT pg_temp.as_user('a5230000-0000-4000-8000-0000000000a1');
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  _d date := (SELECT d FROM proof_day);
  _in jsonb; _out jsonb;
  _yard_visit constant uuid := 'f5230000-0000-4000-8000-0000000000a2';
  _walk_visit uuid;
  _min_yard numeric; _min_walk numeric;
  _len_yard interval; _len_walk interval;
BEGIN
  SELECT id INTO _walk_visit FROM public.visits
   WHERE subscription_id = 'd5230000-0000-4000-8000-0000000000a2' AND scheduled_on = _d;

  _in := public.route_day_inputs('05230000-0000-4000-8000-0000000000aa',
                                 ARRAY['5e230000-0000-4000-8000-0000000000a3']::uuid[], _d, true);
  SELECT (v->>'service_min')::numeric INTO _min_yard
    FROM jsonb_array_elements(_in->'visits') v WHERE (v->>'id')::uuid = _yard_visit;
  SELECT (v->>'service_min')::numeric INTO _min_walk
    FROM jsonb_array_elements(_in->'visits') v WHERE (v->>'id')::uuid = _walk_visit;
  IF _min_yard IS DISTINCT FROM 12 OR _min_walk IS DISTINCT FROM 45 THEN
    RAISE EXCEPTION 'PROOF FAILED [durations]: route_day_inputs gave the cleanup % min (yard 12) and the walk % min (service 45)',
      _min_yard, _min_walk;
  END IF;

  _out := public.apply_route_plan('05230000-0000-4000-8000-0000000000aa',
            ARRAY['5e230000-0000-4000-8000-0000000000a3']::uuid[], _d, true,
            jsonb_build_array(jsonb_build_object(
              'staff_id', '5e230000-0000-4000-8000-0000000000a3',
              'visit_ids', jsonb_build_array(_yard_visit, _walk_visit))), true);
  SELECT eta_end - eta_start INTO _len_yard FROM public.visits WHERE id = _yard_visit;
  SELECT eta_end - eta_start INTO _len_walk FROM public.visits WHERE id = _walk_visit;
  IF _len_yard IS DISTINCT FROM interval '12 minutes' OR _len_walk IS DISTINCT FROM interval '45 minutes' THEN
    RAISE EXCEPTION 'PROOF FAILED [durations]: apply_route_plan booked the cleanup for % and the walk for %',
      _len_yard, _len_walk;
  END IF;
  IF (_out->'staff'->0->>'service_min')::numeric IS DISTINCT FROM 57 THEN
    RAISE EXCEPTION 'PROOF FAILED [durations]: the day''s summary counts % minutes on site, expected 57', _out->'staff'->0->>'service_min';
  END IF;
  RAISE NOTICE 'ok: the planner gives a walk its service''s 45 minutes and a cleanup its yard''s 12';
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

-- ── 8. A sold service is not erased; a whole business still can be ────────
DO $$
BEGIN
  BEGIN
    DELETE FROM public.services WHERE id = '55230000-0000-4000-8000-0000000000a1';
    RAISE EXCEPTION 'PROOF FAILED [delete]: a service that plans and visits point at was deleted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  -- B's plan points at B's Pet waste removal: the cascade from the business
  -- removes both without the reference getting in its way.
  SET LOCAL app.allow_protected_org_write = '1';
  DELETE FROM public.organizations WHERE id = '05230000-0000-4000-8000-0000000000bb';
  SET LOCAL app.allow_protected_org_write = '';
  IF EXISTS (SELECT 1 FROM public.services WHERE organization_id = '05230000-0000-4000-8000-0000000000bb') THEN
    RAISE EXCEPTION 'PROOF FAILED [delete]: deleting a business left its services behind';
  END IF;
  RAISE NOTICE 'ok: a service that was sold cannot be deleted, and deleting a whole business still works';
END $$;

ROLLBACK;
\echo ALL VISIT-SERVICE PROOFS PASSED
