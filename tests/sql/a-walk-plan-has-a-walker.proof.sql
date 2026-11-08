-- A walk plan has a walker, and a one-person walking business walks its own
-- walks (#731, F-17), proved against a real Postgres. Run by
-- tests/a-walk-plan-has-a-walker-in-a-real-database.test.ts, which passes the
-- migration as :migration.
--
-- Business P has an owner and two walkers, Ann and Bo. Business S is one
-- person, its owner, who runs routes. Proves:
--
--   1. a new unassigned visit from a plan naming Ann goes to Ann;
--   2. a visit that arrives with Bo stays with Bo (never overwritten);
--   3. on a day Ann is off, or once she no longer runs routes, the visit stays
--      unassigned rather than going to someone the plan did not name;
--   4. changing the plan's walker moves no visit that already exists;
--   5. a plan cannot name a walker from another business;
--   6. in S, a new dog walk with no walker on its plan goes to the owner; a
--      cleanup does not; and once S has a second person, a walk does not.
--
-- Everything is inside one transaction, ROLLED BACK at the end.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :migration

-- ── Fixture ───────────────────────────────────────────────────────────────
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('a7320000-0000-4000-8000-0000000000a1', 'owner-p@plan-walker.proof.invalid'),
  ('a7320000-0000-4000-8000-0000000000a2', 'ann@plan-walker.proof.invalid'),
  ('a7320000-0000-4000-8000-0000000000a3', 'bo@plan-walker.proof.invalid'),
  ('a7320000-0000-4000-8000-0000000000b1', 'owner-s@plan-walker.proof.invalid'),
  ('a7320000-0000-4000-8000-0000000000b2', 'hire-s@plan-walker.proof.invalid');
INSERT INTO public.organizations (id, name, timezone, work_days, service_lines) VALUES
  ('07320000-0000-4000-8000-0000000000aa', 'Plan Walker Proof P', 'America/Chicago',
   '{0,1,2,3,4,5,6}', '{dog_walking}'),
  ('07320000-0000-4000-8000-0000000000bb', 'Plan Walker Proof S', 'America/Chicago',
   '{0,1,2,3,4,5,6}', '{dog_walking,pet_waste}');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a7320000-0000-4000-8000-0000000000a1', '07320000-0000-4000-8000-0000000000aa', 'owner'),
  ('a7320000-0000-4000-8000-0000000000a2', '07320000-0000-4000-8000-0000000000aa', 'tech'),
  ('a7320000-0000-4000-8000-0000000000a3', '07320000-0000-4000-8000-0000000000aa', 'tech'),
  ('a7320000-0000-4000-8000-0000000000b1', '07320000-0000-4000-8000-0000000000bb', 'owner');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.staff (id, organization_id, user_id, role, display_name, active,
                          is_field_tech, is_field_tech_overridden) VALUES
  ('5e732000-0000-4000-8000-0000000000a2', '07320000-0000-4000-8000-0000000000aa',
   'a7320000-0000-4000-8000-0000000000a2', 'tech', 'Ann Plan', true, true, true),
  ('5e732000-0000-4000-8000-0000000000a3', '07320000-0000-4000-8000-0000000000aa',
   'a7320000-0000-4000-8000-0000000000a3', 'tech', 'Bo Plan', true, true, true),
  ('5e732000-0000-4000-8000-0000000000b1', '07320000-0000-4000-8000-0000000000bb',
   'a7320000-0000-4000-8000-0000000000b1', 'owner', 'Solo Owner', true, true, true);
-- P's owner may also have a staff row from a trigger; P has more than one
-- person either way, so the solo rule cannot apply there.

INSERT INTO public.services (id, organization_id, name, service_line, price_unit,
                             base_price_cents, extra_pet_cents, default_duration_min, active) VALUES
  ('55732000-0000-4000-8000-0000000000a1', '07320000-0000-4000-8000-0000000000aa',
   'Plan walk', 'dog_walking', 'visit', 2000, 0, 30, true),
  ('55732000-0000-4000-8000-0000000000b1', '07320000-0000-4000-8000-0000000000bb',
   'Solo walk', 'dog_walking', 'visit', 2000, 0, 30, true);

CREATE TEMP TABLE proof_day ON COMMIT DROP AS
  SELECT (now() AT TIME ZONE 'America/Chicago')::date + 20 AS d;

INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('c7320000-0000-4000-8000-0000000000a1', '07320000-0000-4000-8000-0000000000aa', 'residential', 'Plan Client'),
  ('c7320000-0000-4000-8000-0000000000b1', '07320000-0000-4000-8000-0000000000bb', 'residential', 'Solo Client');
INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code) VALUES
  ('e7320000-0000-4000-8000-0000000000a1', '07320000-0000-4000-8000-0000000000aa',
   'c7320000-0000-4000-8000-0000000000a1', '1 Plan St', 'Chicago', '60614'),
  ('e7320000-0000-4000-8000-0000000000b1', '07320000-0000-4000-8000-0000000000bb',
   'c7320000-0000-4000-8000-0000000000b1', '1 Solo St', 'Chicago', '60614');

-- P's plan names Ann. S has a walk plan and a cleanup plan, neither naming anyone.
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency,
                                  price_cents, dog_count, started_on, service_id, assigned_staff_id)
SELECT x.id::uuid, x.org::uuid, x.client::uuid, x.prop::uuid, 'residential', 'weekly', 2000, 1, p.d + 60,
       x.svc::uuid, x.walker::uuid
  FROM proof_day p, (VALUES
    ('d7320000-0000-4000-8000-0000000000a1', '07320000-0000-4000-8000-0000000000aa',
     'c7320000-0000-4000-8000-0000000000a1', 'e7320000-0000-4000-8000-0000000000a1',
     '55732000-0000-4000-8000-0000000000a1', '5e732000-0000-4000-8000-0000000000a2'),
    ('d7320000-0000-4000-8000-0000000000b1', '07320000-0000-4000-8000-0000000000bb',
     'c7320000-0000-4000-8000-0000000000b1', 'e7320000-0000-4000-8000-0000000000b1',
     '55732000-0000-4000-8000-0000000000b1', NULL),
    ('d7320000-0000-4000-8000-0000000000b2', '07320000-0000-4000-8000-0000000000bb',
     'c7320000-0000-4000-8000-0000000000b1', 'e7320000-0000-4000-8000-0000000000b1',
     (SELECT id::text FROM public.services WHERE organization_id = '07320000-0000-4000-8000-0000000000bb'
        AND lower(name) = 'pet waste removal'), NULL)
  ) AS x(id, org, client, prop, svc, walker);

CREATE FUNCTION pg_temp.new_visit(_id uuid, _org uuid, _sub uuid, _client uuid, _prop uuid,
                                  _day date, _staff uuid DEFAULT NULL) RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id,
                             scheduled_on, status, assigned_staff_id)
  VALUES (_id, _org, _sub, _client, _prop, _day, 'scheduled', _staff)
  RETURNING assigned_staff_id;
$$;

-- ── 1-4. The plan's walker ────────────────────────────────────────────────
DO $$
DECLARE
  _d date := (SELECT d FROM proof_day);
  _org constant uuid := '07320000-0000-4000-8000-0000000000aa';
  _sub constant uuid := 'd7320000-0000-4000-8000-0000000000a1';
  _cl constant uuid := 'c7320000-0000-4000-8000-0000000000a1';
  _pr constant uuid := 'e7320000-0000-4000-8000-0000000000a1';
  _ann constant uuid := '5e732000-0000-4000-8000-0000000000a2';
  _bo constant uuid := '5e732000-0000-4000-8000-0000000000a3';
  _got uuid;
BEGIN
  _got := pg_temp.new_visit('f7320000-0000-4000-8000-0000000000a1', _org, _sub, _cl, _pr, _d);
  IF _got IS DISTINCT FROM _ann THEN
    RAISE EXCEPTION 'PROOF FAILED [plan]: a visit from Ann''s plan went to %', _got;
  END IF;
  RAISE NOTICE 'ok: a new visit takes its plan''s walker';

  _got := pg_temp.new_visit('f7320000-0000-4000-8000-0000000000a2', _org, _sub, _cl, _pr, _d + 1, _bo);
  IF _got IS DISTINCT FROM _bo THEN
    RAISE EXCEPTION 'PROOF FAILED [keep]: a visit booked to Bo became %', _got;
  END IF;
  RAISE NOTICE 'ok: a visit that arrives with someone keeps them';

  INSERT INTO public.staff_time_off (organization_id, staff_id, starts_on, ends_on, reason)
  VALUES (_org, _ann, _d + 2, _d + 2, 'Proof');
  _got := pg_temp.new_visit('f7320000-0000-4000-8000-0000000000a3', _org, _sub, _cl, _pr, _d + 2);
  IF _got IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [off]: a visit on Ann''s day off went to %', _got;
  END IF;
  UPDATE public.staff SET is_field_tech = false, is_field_tech_overridden = true WHERE id = _ann;
  _got := pg_temp.new_visit('f7320000-0000-4000-8000-0000000000a4', _org, _sub, _cl, _pr, _d + 3);
  IF _got IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [routes]: a visit went to a walker who does not run routes: %', _got;
  END IF;
  UPDATE public.staff SET is_field_tech = true WHERE id = _ann;
  RAISE NOTICE 'ok: a walker who cannot take the day leaves the walk unassigned, not given to another';

  UPDATE public.subscriptions SET assigned_staff_id = _bo WHERE id = _sub;
  IF (SELECT assigned_staff_id FROM public.visits WHERE id = 'f7320000-0000-4000-8000-0000000000a1')
     IS DISTINCT FROM _ann
    OR (SELECT assigned_staff_id FROM public.visits WHERE id = 'f7320000-0000-4000-8000-0000000000a3')
     IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [moves]: changing the plan''s walker moved a visit that already existed';
  END IF;
  RAISE NOTICE 'ok: changing a plan''s walker moves nothing already made';
END $$;

-- ── 5. Only a walker from the plan's business ─────────────────────────────
DO $$
BEGIN
  BEGIN
    UPDATE public.subscriptions SET assigned_staff_id = '5e732000-0000-4000-8000-0000000000b1'
     WHERE id = 'd7320000-0000-4000-8000-0000000000a1';
    RAISE EXCEPTION 'PROOF FAILED [tenant]: a plan named another business''s walker';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'ok: a plan cannot name a walker from another business';
END $$;

-- ── 6. The one-person business ────────────────────────────────────────────
DO $$
DECLARE
  _d date := (SELECT d FROM proof_day);
  _org constant uuid := '07320000-0000-4000-8000-0000000000bb';
  _cl constant uuid := 'c7320000-0000-4000-8000-0000000000b1';
  _pr constant uuid := 'e7320000-0000-4000-8000-0000000000b1';
  _owner constant uuid := '5e732000-0000-4000-8000-0000000000b1';
  _people int;
  _got uuid;
BEGIN
  SELECT count(*) INTO _people FROM public.staff WHERE organization_id = _org AND COALESCE(active, true);
  IF _people <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [fixture]: S has % active people, not one', _people;
  END IF;
  _got := pg_temp.new_visit('f7320000-0000-4000-8000-0000000000b1', _org,
    'd7320000-0000-4000-8000-0000000000b1', _cl, _pr, _d);
  IF _got IS DISTINCT FROM _owner THEN
    RAISE EXCEPTION 'PROOF FAILED [solo]: a one-person business''s walk went to %', _got;
  END IF;
  _got := pg_temp.new_visit('f7320000-0000-4000-8000-0000000000b2', _org,
    'd7320000-0000-4000-8000-0000000000b2', _cl, _pr, _d);
  IF _got IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [solo-line]: a cleanup was given to the owner by the walk rule';
  END IF;
  SET LOCAL app.allow_protected_org_write = '1';
  INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
    ('a7320000-0000-4000-8000-0000000000b2', _org, 'tech');
  SET LOCAL app.allow_protected_org_write = '';
  INSERT INTO public.staff (id, organization_id, user_id, role, display_name, active,
                            is_field_tech, is_field_tech_overridden)
  VALUES ('5e732000-0000-4000-8000-0000000000b2', _org, 'a7320000-0000-4000-8000-0000000000b2',
          'tech', 'New Hire', true, true, true);
  _got := pg_temp.new_visit('f7320000-0000-4000-8000-0000000000b3', _org,
    'd7320000-0000-4000-8000-0000000000b1', _cl, _pr, _d + 1);
  IF _got IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [solo-two]: with two people a walk was still given to %', _got;
  END IF;
  RAISE NOTICE 'ok: a one-person business walks its own walks, and only walks, and only while it is one person';
END $$;

ROLLBACK;
\echo ALL PLAN WALKER PROOFS PASSED
