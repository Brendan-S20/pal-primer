-- A dragged stop keeps the right arrival time, and a moved visit keeps its
-- technician when it can (#430, QA rows 15 and 16), proved against a real
-- Postgres rather than read off the migrations' text.
-- Run by tests/a-dragged-stop-keeps-the-right-arrival-time.test.ts, which passes
--   :etas        20261015130000_a-dragged-stop-keeps-the-right-arrival-time.sql
--   :reschedule  20261015131000_a-moved-visit-keeps-its-tech.sql
--
-- Everything happens inside one transaction that is ROLLED BACK at the end,
-- the migrations included. Each group prints "ok: ..." only when every check
-- in it passed, or raises "PROOF FAILED [...]", and ON_ERROR_STOP turns the
-- first failure into a non-zero exit.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

-- ── Fixture ───────────────────────────────────────────────────────────────
-- One business working Monday to Friday from 08:00, an owner, and two
-- technicians who run routes: Ann and Bo. Three stops on Ann's Monday, each
-- carrying a stale ETA from "the last auto-routing run" (the year 2000), so a
-- function that leaves the times alone is caught.
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('a6100000-0000-4000-8000-0000000000a1', 'owner@eta.proof.invalid'),
  ('a6100000-0000-4000-8000-0000000000a2', 'ann@eta.proof.invalid'),
  ('a6100000-0000-4000-8000-0000000000a3', 'bo@eta.proof.invalid');
INSERT INTO public.organizations (id, name, timezone, work_days, workday_start) VALUES
  ('06100000-0000-4000-8000-0000000000aa', 'ETA Proof A', 'America/Chicago', '{1,2,3,4,5}', '08:00');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a6100000-0000-4000-8000-0000000000a1', '06100000-0000-4000-8000-0000000000aa', 'owner'),
  ('a6100000-0000-4000-8000-0000000000a2', '06100000-0000-4000-8000-0000000000aa', 'tech'),
  ('a6100000-0000-4000-8000-0000000000a3', '06100000-0000-4000-8000-0000000000aa', 'tech');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.staff (id, organization_id, user_id, role, display_name, active,
                          is_field_tech, is_field_tech_overridden, start_latitude, start_longitude) VALUES
  ('5e610000-0000-4000-8000-0000000000a2', '06100000-0000-4000-8000-0000000000aa',
   'a6100000-0000-4000-8000-0000000000a2', 'tech', 'Ann Proof', true, true, true, 41.90, -87.65),
  ('5e610000-0000-4000-8000-0000000000a3', '06100000-0000-4000-8000-0000000000aa',
   'a6100000-0000-4000-8000-0000000000a3', 'tech', 'Bo Proof', true, true, true, 41.90, -87.70);

INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('c6100000-0000-4000-8000-0000000000a1', '06100000-0000-4000-8000-0000000000aa', 'residential', 'ETA Client One'),
  ('c6100000-0000-4000-8000-0000000000a2', '06100000-0000-4000-8000-0000000000aa', 'residential', 'ETA Client Two'),
  ('c6100000-0000-4000-8000-0000000000a3', '06100000-0000-4000-8000-0000000000aa', 'residential', 'ETA Client Three');

INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code, latitude, longitude) VALUES
  ('e6100000-0000-4000-8000-0000000000a1', '06100000-0000-4000-8000-0000000000aa',
   'c6100000-0000-4000-8000-0000000000a1', '1 Near St', 'Chicago', '60614', 41.92, -87.65),
  ('e6100000-0000-4000-8000-0000000000a2', '06100000-0000-4000-8000-0000000000aa',
   'c6100000-0000-4000-8000-0000000000a2', '2 Mid St', 'Chicago', '60614', 41.94, -87.65),
  ('e6100000-0000-4000-8000-0000000000a3', '06100000-0000-4000-8000-0000000000aa',
   'c6100000-0000-4000-8000-0000000000a3', '3 Far St', 'Chicago', '60614', 41.96, -87.65);

-- D is a Monday at least a week out on the business's calendar.
CREATE TEMP TABLE proof_day ON COMMIT DROP AS
  SELECT date_trunc('week', (now() AT TIME ZONE 'America/Chicago')::date + 14)::date AS d;
GRANT SELECT ON proof_day TO authenticated, anon;

CREATE FUNCTION pg_temp.as_user(_uid text, _aal text DEFAULT 'aal1') RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
           json_build_object('sub', _uid, 'role', 'authenticated', 'aal', _aal)::text, true);
$$;

-- The business's own cleanup service, which a new organization is given
-- (the same lookup a-window-is-kept-and-a-skill-is-matched.proof.sql makes).
CREATE FUNCTION pg_temp.pet_waste(_org uuid) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM public.services WHERE organization_id = _org AND lower(name) = 'pet waste removal';
$$;

INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency,
                                  price_cents, dog_count, started_on, service_id)
SELECT x.id::uuid, '06100000-0000-4000-8000-0000000000aa', x.client::uuid, x.prop::uuid, 'residential', 'weekly',
       2000, 1, p.d - 7, pg_temp.pet_waste('06100000-0000-4000-8000-0000000000aa')
  FROM proof_day p, (VALUES
    ('d6100000-0000-4000-8000-0000000000a1', 'c6100000-0000-4000-8000-0000000000a1', 'e6100000-0000-4000-8000-0000000000a1'),
    ('d6100000-0000-4000-8000-0000000000a2', 'c6100000-0000-4000-8000-0000000000a2', 'e6100000-0000-4000-8000-0000000000a2'),
    ('d6100000-0000-4000-8000-0000000000a3', 'c6100000-0000-4000-8000-0000000000a3', 'e6100000-0000-4000-8000-0000000000a3')
  ) AS x(id, client, prop);

INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id, scheduled_on, status,
                           assigned_staff_id, sequence, eta_start, eta_end)
SELECT x.id::uuid, '06100000-0000-4000-8000-0000000000aa', x.sub::uuid, x.client::uuid, x.prop::uuid, p.d, 'scheduled',
       '5e610000-0000-4000-8000-0000000000a2', x.seq, '2000-01-01T00:00:00Z', '2000-01-01T00:10:00Z'
  FROM proof_day p, (VALUES
    ('f6100000-0000-4000-8000-0000000000a1', 'd6100000-0000-4000-8000-0000000000a1',
     'c6100000-0000-4000-8000-0000000000a1', 'e6100000-0000-4000-8000-0000000000a1', 1),
    ('f6100000-0000-4000-8000-0000000000a2', 'd6100000-0000-4000-8000-0000000000a2',
     'c6100000-0000-4000-8000-0000000000a2', 'e6100000-0000-4000-8000-0000000000a2', 2),
    ('f6100000-0000-4000-8000-0000000000a3', 'd6100000-0000-4000-8000-0000000000a3',
     'c6100000-0000-4000-8000-0000000000a3', 'e6100000-0000-4000-8000-0000000000a3', 3)
  ) AS x(id, sub, client, prop, seq);

-- Bo is off on the Wednesday.
INSERT INTO public.staff_time_off (organization_id, staff_id, starts_on, ends_on, reason)
SELECT '06100000-0000-4000-8000-0000000000aa', '5e610000-0000-4000-8000-0000000000a3', p.d + 2, p.d + 2, 'Proof'
  FROM proof_day p;

\i :etas
\i :reschedule

-- ── 1. A reorder rewrites the lane's times in the new order ───────────────
SELECT pg_temp.as_user('a6100000-0000-4000-8000-0000000000a1');
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  _d date := (SELECT d FROM proof_day);
  _ann constant uuid := '5e610000-0000-4000-8000-0000000000a2';
  _v1 constant uuid := 'f6100000-0000-4000-8000-0000000000a1';
  _v2 constant uuid := 'f6100000-0000-4000-8000-0000000000a2';
  _v3 constant uuid := 'f6100000-0000-4000-8000-0000000000a3';
  _e1 timestamptz; _e2 timestamptz; _e3 timestamptz; _end3 timestamptz;
BEGIN
  PERFORM public.reorder_route(_ann, _d, ARRAY[_v3, _v1, _v2]);
  SELECT eta_start INTO _e1 FROM public.visits WHERE id = _v1;
  SELECT eta_start INTO _e2 FROM public.visits WHERE id = _v2;
  SELECT eta_start, eta_end INTO _e3, _end3 FROM public.visits WHERE id = _v3;
  IF _e1 < '2001-01-01' OR _e2 < '2001-01-01' OR _e3 < '2001-01-01' THEN
    RAISE EXCEPTION 'PROOF FAILED [reorder]: a stop kept the stale time (% % %)', _e1, _e2, _e3;
  END IF;
  IF NOT (_e3 < _e1 AND _e1 < _e2) THEN
    RAISE EXCEPTION 'PROOF FAILED [reorder]: times do not follow the new order v3, v1, v2 (% % %)', _e3, _e1, _e2;
  END IF;
  IF _e3 < (_d + TIME '08:00') AT TIME ZONE 'America/Chicago' THEN
    RAISE EXCEPTION 'PROOF FAILED [reorder]: the first stop arrives before the workday starts (%)', _e3;
  END IF;
  IF _end3 <= _e3 THEN
    RAISE EXCEPTION 'PROOF FAILED [reorder]: eta_end is not after eta_start (% %)', _e3, _end3;
  END IF;
  RAISE NOTICE 'ok: reorder_route rewrites the lane''s arrival times in the order the dispatcher dropped';
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

-- ── 2. A reassign recomputes both lanes; an unassign clears the time ───────
SELECT pg_temp.as_user('a6100000-0000-4000-8000-0000000000a1');
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  _bo constant uuid := '5e610000-0000-4000-8000-0000000000a3';
  _v1 constant uuid := 'f6100000-0000-4000-8000-0000000000a1';
  _v2 constant uuid := 'f6100000-0000-4000-8000-0000000000a2';
  _before timestamptz; _after timestamptz; _r record;
BEGIN
  SELECT eta_start INTO _before FROM public.visits WHERE id = _v2;
  PERFORM public.reassign_visit(_v1, _bo);
  SELECT eta_start INTO _after FROM public.visits WHERE id = _v2;
  IF NOT (_after < _before) THEN
    RAISE EXCEPTION 'PROOF FAILED [reassign]: Ann''s later stop did not move up when v1 left her lane (% -> %)', _before, _after;
  END IF;
  SELECT assigned_staff_id, sequence, eta_start INTO _r FROM public.visits WHERE id = _v1;
  IF _r.assigned_staff_id IS DISTINCT FROM _bo OR _r.sequence IS NULL OR _r.eta_start IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [reassign]: v1 on Bo''s lane has no place or time (%)', _r;
  END IF;

  PERFORM public.reassign_visit(_v1, NULL);
  SELECT assigned_staff_id, eta_start, eta_end, travel_min INTO _r FROM public.visits WHERE id = _v1;
  IF _r.assigned_staff_id IS NOT NULL OR _r.eta_start IS NOT NULL OR _r.eta_end IS NOT NULL OR _r.travel_min IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [reassign]: an unassigned visit kept an arrival time (%)', _r;
  END IF;
  RAISE NOTICE 'ok: reassign_visit recomputes the lane it left and the lane it joined, and an unassigned visit has no time';
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

-- ── 3. A move keeps the technician on a day they work ──────────────────────
SELECT pg_temp.as_user('a6100000-0000-4000-8000-0000000000a1');
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  _d date := (SELECT d FROM proof_day);
  _ann constant uuid := '5e610000-0000-4000-8000-0000000000a2';
  _bo constant uuid := '5e610000-0000-4000-8000-0000000000a3';
  _v1 constant uuid := 'f6100000-0000-4000-8000-0000000000a1';
  _v2 constant uuid := 'f6100000-0000-4000-8000-0000000000a2';
  _v3 constant uuid := 'f6100000-0000-4000-8000-0000000000a3';
  _r record;
BEGIN
  -- Tuesday is a work day: Ann keeps it, with a time on Tuesday.
  PERFORM public.reschedule_visit(_v2, _d + 1);
  SELECT assigned_staff_id, scheduled_on, eta_start INTO _r FROM public.visits WHERE id = _v2;
  IF _r.assigned_staff_id IS DISTINCT FROM _ann OR _r.scheduled_on <> _d + 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [move]: a move to a work day dropped the technician (%)', _r;
  END IF;
  IF _r.eta_start IS NULL OR (_r.eta_start AT TIME ZONE 'America/Chicago')::date <> _d + 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [move]: the kept visit''s time is not on its new day (%)', _r;
  END IF;

  -- Saturday is not: unassigned, and no time.
  PERFORM public.reschedule_visit(_v3, _d + 5);
  SELECT assigned_staff_id, eta_start, sequence INTO _r FROM public.visits WHERE id = _v3;
  IF _r.assigned_staff_id IS NOT NULL OR _r.eta_start IS NOT NULL OR _r.sequence IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [move]: a move to a day off kept the technician or a time (%)', _r;
  END IF;

  -- Bo is off on Wednesday: unassigned, and the time-off trigger is not tripped.
  PERFORM public.reassign_visit(_v1, _bo);
  PERFORM public.reschedule_visit(_v1, _d + 2);
  SELECT assigned_staff_id, scheduled_on INTO _r FROM public.visits WHERE id = _v1;
  IF _r.assigned_staff_id IS NOT NULL OR _r.scheduled_on <> _d + 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [move]: a move onto a technician''s time off kept them (%)', _r;
  END IF;
  RAISE NOTICE 'ok: reschedule_visit keeps the technician on a work day they are not off, and otherwise leaves it unassigned';
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

-- ── 4. The helper is not part of the API ──────────────────────────────────
SELECT pg_temp.as_user('a6100000-0000-4000-8000-0000000000a1');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.recompute_lane_etas('06100000-0000-4000-8000-0000000000aa',
              '5e610000-0000-4000-8000-0000000000a2', (SELECT d FROM proof_day));
    RAISE EXCEPTION 'PROOF FAILED [grants]: authenticated called recompute_lane_etas directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok: recompute_lane_etas is reached only through the functions that authorize first';
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

ROLLBACK;
\echo ALL DRAGGED-STOP PROOFS PASSED
