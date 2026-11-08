-- A walker has a dog cap (#731), proved against a real Postgres. Run by
-- tests/a-walker-has-a-dog-cap-in-a-real-database.test.ts, which passes the
-- migration as :migration.
--
-- One business that walks dogs, a group walk service for up to six dogs, and
-- two walkers: Ann, capped at three dogs at once, and Bo, with no cap (the
-- default). Five clients, each with their own plan and their own visit on
-- one day. Proves:
--
--   1. staff.max_dogs_per_walk is NULL for a person nobody set it on;
--   2. a walk joining Ann's group is refused once it would take her past
--      three dogs, even though the service allows six, and the refusal names
--      her and the numbers;
--   3. giving a group with four dogs to Ann is refused; to Bo it is not;
--   4. lowering Ann's cap below a group she already has neither fails nor
--      changes that group;
--   5. a completed walk stops counting, so a place it held can be taken;
--   6. each member is still its own client's visit, so the group bills five
--      clients once each and nothing about billing changed.
--
-- Everything is inside one transaction, ROLLED BACK at the end, the migration
-- included.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :migration

-- ── Fixture ───────────────────────────────────────────────────────────────
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('a7310000-0000-4000-8000-0000000000a1', 'owner@dog-cap.proof.invalid'),
  ('a7310000-0000-4000-8000-0000000000a2', 'ann@dog-cap.proof.invalid'),
  ('a7310000-0000-4000-8000-0000000000a3', 'bo@dog-cap.proof.invalid');
INSERT INTO public.organizations (id, name, timezone, work_days, service_lines) VALUES
  ('07310000-0000-4000-8000-0000000000aa', 'Dog Cap Proof', 'America/Chicago',
   '{0,1,2,3,4,5,6}', '{dog_walking}');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a7310000-0000-4000-8000-0000000000a1', '07310000-0000-4000-8000-0000000000aa', 'owner'),
  ('a7310000-0000-4000-8000-0000000000a2', '07310000-0000-4000-8000-0000000000aa', 'tech'),
  ('a7310000-0000-4000-8000-0000000000a3', '07310000-0000-4000-8000-0000000000aa', 'tech');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.staff (id, organization_id, user_id, role, display_name, active,
                          is_field_tech, is_field_tech_overridden) VALUES
  ('5e731000-0000-4000-8000-0000000000a2', '07310000-0000-4000-8000-0000000000aa',
   'a7310000-0000-4000-8000-0000000000a2', 'tech', 'Ann Cap', true, true, true),
  ('5e731000-0000-4000-8000-0000000000a3', '07310000-0000-4000-8000-0000000000aa',
   'a7310000-0000-4000-8000-0000000000a3', 'tech', 'Bo Cap', true, true, true);

INSERT INTO public.services (id, organization_id, name, service_line, price_unit,
                             base_price_cents, extra_pet_cents, default_duration_min, max_dogs, active) VALUES
  ('55731000-0000-4000-8000-0000000000a1', '07310000-0000-4000-8000-0000000000aa',
   'Pack walk', 'dog_walking', 'visit', 2000, 0, 60, 6, true);

-- A day well clear of today, so nothing nightly touches it.
CREATE TEMP TABLE proof_day ON COMMIT DROP AS
  SELECT (now() AT TIME ZONE 'America/Chicago')::date + 20 AS d;

-- Five clients, one yard each, a plan each carrying its dog count, and one
-- visit each on D. A: 2 dogs, B: 1, C: 2, D: 1, E: 1.
INSERT INTO public.clients (id, organization_id, account_type, display_name)
SELECT ('c7310000-0000-4000-8000-0000000000a' || k)::uuid, '07310000-0000-4000-8000-0000000000aa',
       'residential', 'Dog Cap Client ' || k
  FROM unnest(ARRAY['1','2','3','4','5']) AS k;
INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code, latitude, longitude)
SELECT ('e7310000-0000-4000-8000-0000000000a' || k)::uuid, '07310000-0000-4000-8000-0000000000aa',
       ('c7310000-0000-4000-8000-0000000000a' || k)::uuid, k || ' Pack St', 'Chicago', '60614',
       41.92 + k::int * 0.001, -87.65
  FROM unnest(ARRAY['1','2','3','4','5']) AS k;
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency,
                                  price_cents, dog_count, started_on, service_id)
SELECT ('d7310000-0000-4000-8000-0000000000a' || x.k)::uuid, '07310000-0000-4000-8000-0000000000aa',
       ('c7310000-0000-4000-8000-0000000000a' || x.k)::uuid,
       ('e7310000-0000-4000-8000-0000000000a' || x.k)::uuid,
       'residential', 'weekly', 2000 + x.k::int, x.dogs, p.d, '55731000-0000-4000-8000-0000000000a1'
  FROM proof_day p, (VALUES ('1', 2), ('2', 1), ('3', 2), ('4', 1), ('5', 1)) AS x(k, dogs);
-- Whatever a plan generated for D is not ours; our five are named.
DELETE FROM public.visits
 WHERE organization_id = '07310000-0000-4000-8000-0000000000aa'
   AND scheduled_on = (SELECT d FROM proof_day);
INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id, service_id,
                           scheduled_on, status)
SELECT ('f7310000-0000-4000-8000-0000000000a' || k)::uuid, '07310000-0000-4000-8000-0000000000aa',
       ('d7310000-0000-4000-8000-0000000000a' || k)::uuid,
       ('c7310000-0000-4000-8000-0000000000a' || k)::uuid,
       ('e7310000-0000-4000-8000-0000000000a' || k)::uuid,
       '55731000-0000-4000-8000-0000000000a1', p.d, 'scheduled'
  FROM proof_day p, unnest(ARRAY['1','2','3','4','5']) AS k;

-- Two groups on D: G1 with Ann, G2 with nobody yet.
INSERT INTO public.walk_groups (id, organization_id, service_id, scheduled_on, assigned_staff_id)
SELECT x.id::uuid, '07310000-0000-4000-8000-0000000000aa', '55731000-0000-4000-8000-0000000000a1', p.d, x.walker::uuid
  FROM proof_day p, (VALUES
    ('97310000-0000-4000-8000-0000000000b1', '5e731000-0000-4000-8000-0000000000a2'),
    ('97310000-0000-4000-8000-0000000000b2', NULL)
  ) AS x(id, walker);

-- ── 1. No cap unless set ──────────────────────────────────────────────────
DO $$
BEGIN
  IF (SELECT max_dogs_per_walk FROM public.staff WHERE id = '5e731000-0000-4000-8000-0000000000a2') IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [default]: a new walker came with a dog cap';
  END IF;
  UPDATE public.staff SET max_dogs_per_walk = 3 WHERE id = '5e731000-0000-4000-8000-0000000000a2';
  BEGIN
    UPDATE public.staff SET max_dogs_per_walk = 0 WHERE id = '5e731000-0000-4000-8000-0000000000a3';
    RAISE EXCEPTION 'PROOF FAILED [default]: a cap of 0 was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'ok: no walker has a cap until one is set, and a cap is 1 to 50';
END $$;

-- ── 2. Ann's group stops at her cap, not the service's ────────────────────
DO $$
DECLARE _msg text;
BEGIN
  UPDATE public.visits SET walk_group_id = '97310000-0000-4000-8000-0000000000b1'
   WHERE id IN ('f7310000-0000-4000-8000-0000000000a1', 'f7310000-0000-4000-8000-0000000000a2');
  IF (SELECT count(*) FROM public.visits WHERE walk_group_id = '97310000-0000-4000-8000-0000000000b1'
        AND assigned_staff_id = '5e731000-0000-4000-8000-0000000000a2') <> 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [cap]: three dogs under a cap of three did not join Ann''s group';
  END IF;
  BEGIN
    UPDATE public.visits SET walk_group_id = '97310000-0000-4000-8000-0000000000b1'
     WHERE id = 'f7310000-0000-4000-8000-0000000000a3';
    RAISE EXCEPTION 'PROOF FAILED [cap]: a fifth dog joined Ann''s group past her cap of three';
  EXCEPTION WHEN check_violation THEN _msg := SQLERRM;
  END;
  IF _msg NOT LIKE 'Ann Cap walks up to 3 dogs at a time. This group would have 5.' THEN
    RAISE EXCEPTION 'PROOF FAILED [cap]: the refusal said "%"', _msg;
  END IF;
  RAISE NOTICE 'ok: a group stops at its walker''s cap below the service''s size';
END $$;

-- ── 3. A group is given only to a walker it fits ──────────────────────────
DO $$
DECLARE _msg text;
BEGIN
  UPDATE public.visits SET walk_group_id = '97310000-0000-4000-8000-0000000000b2'
   WHERE id IN ('f7310000-0000-4000-8000-0000000000a3', 'f7310000-0000-4000-8000-0000000000a4',
                'f7310000-0000-4000-8000-0000000000a5');
  BEGIN
    UPDATE public.walk_groups SET assigned_staff_id = '5e731000-0000-4000-8000-0000000000a2'
     WHERE id = '97310000-0000-4000-8000-0000000000b2';
    RAISE EXCEPTION 'PROOF FAILED [assign]: a four-dog group was given to a walker capped at three';
  EXCEPTION WHEN check_violation THEN _msg := SQLERRM;
  END;
  IF _msg NOT LIKE 'Ann Cap walks up to 3 dogs at a time. This group has 4.' THEN
    RAISE EXCEPTION 'PROOF FAILED [assign]: the refusal said "%"', _msg;
  END IF;
  UPDATE public.walk_groups SET assigned_staff_id = '5e731000-0000-4000-8000-0000000000a3'
   WHERE id = '97310000-0000-4000-8000-0000000000b2';
  IF (SELECT count(*) FROM public.visits WHERE walk_group_id = '97310000-0000-4000-8000-0000000000b2'
        AND assigned_staff_id = '5e731000-0000-4000-8000-0000000000a3') <> 3 THEN
    RAISE EXCEPTION 'PROOF FAILED [assign]: Bo, with no cap, did not get the four-dog group';
  END IF;
  RAISE NOTICE 'ok: a group goes to a walker it fits and is refused to one it does not';
END $$;

-- ── 4. Lowering a cap moves and refuses nothing ───────────────────────────
DO $$
BEGIN
  UPDATE public.staff SET max_dogs_per_walk = 1 WHERE id = '5e731000-0000-4000-8000-0000000000a2';
  IF (SELECT count(*) FROM public.visits WHERE walk_group_id = '97310000-0000-4000-8000-0000000000b1'
        AND assigned_staff_id = '5e731000-0000-4000-8000-0000000000a2' AND status = 'scheduled') <> 2
    OR (SELECT assigned_staff_id FROM public.walk_groups WHERE id = '97310000-0000-4000-8000-0000000000b1')
       IS DISTINCT FROM '5e731000-0000-4000-8000-0000000000a2' THEN
    RAISE EXCEPTION 'PROOF FAILED [lower]: lowering a cap changed a group already booked';
  END IF;
  UPDATE public.staff SET max_dogs_per_walk = 3 WHERE id = '5e731000-0000-4000-8000-0000000000a2';
  RAISE NOTICE 'ok: lowering a cap leaves booked groups as they are';
END $$;

-- ── 5. A completed walk gives its place back ──────────────────────────────
DO $$
BEGIN
  -- Bo's group: C (2), D (1), E (1). Move E out, then complete C, and Ann's
  -- group (A 2 + B 1 = 3, full) takes nobody until A is completed.
  UPDATE public.visits SET walk_group_id = NULL WHERE id = 'f7310000-0000-4000-8000-0000000000a5';
  UPDATE public.visits SET status = 'completed', completed_at = now()
   WHERE id = 'f7310000-0000-4000-8000-0000000000a1';
  UPDATE public.visits SET walk_group_id = '97310000-0000-4000-8000-0000000000b1'
   WHERE id = 'f7310000-0000-4000-8000-0000000000a5';
  IF (SELECT walk_group_id FROM public.visits WHERE id = 'f7310000-0000-4000-8000-0000000000a5')
     IS DISTINCT FROM '97310000-0000-4000-8000-0000000000b1' THEN
    RAISE EXCEPTION 'PROOF FAILED [completed]: a completed walk still held its place under the cap';
  END IF;
  RAISE NOTICE 'ok: a completed walk no longer counts toward the cap';
END $$;

-- ── 6. Five clients, five visits, one bill line each at most ──────────────
DO $$
BEGIN
  IF (SELECT count(DISTINCT client_id) FROM public.visits
       WHERE walk_group_id IN ('97310000-0000-4000-8000-0000000000b1', '97310000-0000-4000-8000-0000000000b2'))
     <> (SELECT count(*) FROM public.visits
       WHERE walk_group_id IN ('97310000-0000-4000-8000-0000000000b1', '97310000-0000-4000-8000-0000000000b2')) THEN
    RAISE EXCEPTION 'PROOF FAILED [billing]: a group member is not its own client''s visit';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
                  AND indexname = 'invoice_line_items_visit_unique') THEN
    RAISE EXCEPTION 'PROOF FAILED [billing]: nothing stops a visit being billed twice';
  END IF;
  RAISE NOTICE 'ok: each member is its own client''s visit, billed at most once';
END $$;

ROLLBACK;
\echo ALL DOG CAP PROOFS PASSED
