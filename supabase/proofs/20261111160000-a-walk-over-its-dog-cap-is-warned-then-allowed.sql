-- Proof for 20261111160000 — a walk over its dog cap is warned, then allowed (#731).
--
-- Brendan, 2026-11-10 2:24 PM ET: "Warn but allow going over the dog cap".
-- Run by the database job in .github/workflows/sandboxes.yml against the
-- database it has just replayed from every migration. Locally:
--   supabase db reset
--   psql "postgresql://postgres:postgres@127.0.0.1:54422/postgres" -v ON_ERROR_STOP=1 \
--     -f supabase/proofs/20261111160000-a-walk-over-its-dog-cap-is-warned-then-allowed.sql
--
-- One business that walks dogs; Ann, capped at three dogs at once; Bo, with no
-- cap. Proves, through the same functions the app's buttons call:
--
--   1. one dog over the cap, not confirmed, is refused with the owner's
--      sentence ("This walk will have 4 dogs; the cap is 3.", hint dog_cap)
--      and nothing changes: the walk is not in the group and nothing is
--      recorded. That refusal is what the app turns into the warning, and
--      Cancel is this state;
--   2. the same write, confirmed (the request header the app sends on "Assign
--      anyway"), is saved and recorded: who, the dogs, the cap, over by one;
--   3. drag (reassign_visit), bulk assign (bulk_reassign_visits) and Cover
--      (redistribute_staff_work) meet the same check: refused unconfirmed with
--      nothing moved, saved and recorded confirmed. Handing a group's walks to
--      a walker one at a time is checked too, which 20261108170000 missed;
--   4. walks_over_dog_cap lists an over-cap walk for the office and for its
--      walker, not for another walker, and the record is the office's to read;
--   5. back under the cap, it is no longer listed;
--   6. mutation: with the cap triggers dropped, an over-cap write lands with
--      no refusal and no record.
--
-- Everything is inside one transaction, ROLLED BACK at the end.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

-- ── Fixture ───────────────────────────────────────────────────────────────
SELECT set_config('request.jwt.claims', '{}', true);
SELECT set_config('request.headers', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('a7311000-0000-4000-8000-0000000000a1', 'owner@dog-cap-warn.proof.invalid'),
  ('a7311000-0000-4000-8000-0000000000a2', 'ann@dog-cap-warn.proof.invalid'),
  ('a7311000-0000-4000-8000-0000000000a3', 'bo@dog-cap-warn.proof.invalid');
INSERT INTO public.organizations (id, name, timezone, work_days, service_lines) VALUES
  ('07311000-0000-4000-8000-0000000000aa', 'Dog Cap Warn Proof', 'America/Chicago',
   '{0,1,2,3,4,5,6}', '{dog_walking}');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a7311000-0000-4000-8000-0000000000a1', '07311000-0000-4000-8000-0000000000aa', 'owner'),
  ('a7311000-0000-4000-8000-0000000000a2', '07311000-0000-4000-8000-0000000000aa', 'tech'),
  ('a7311000-0000-4000-8000-0000000000a3', '07311000-0000-4000-8000-0000000000aa', 'tech');
SET LOCAL app.allow_protected_org_write = '';
DO $closed$ BEGIN
  IF coalesce(current_setting('app.allow_protected_org_write', true), '') <> '' THEN
    RAISE EXCEPTION 'PROOF SETUP: the protected-org hatch is still open';
  END IF;
END $closed$;

INSERT INTO public.staff (id, organization_id, user_id, role, display_name, active,
                          is_field_tech, is_field_tech_overridden, max_dogs_per_walk) VALUES
  ('5e731100-0000-4000-8000-0000000000a2', '07311000-0000-4000-8000-0000000000aa',
   'a7311000-0000-4000-8000-0000000000a2', 'tech', 'Ann Warn', true, true, true, 3),
  ('5e731100-0000-4000-8000-0000000000a3', '07311000-0000-4000-8000-0000000000aa',
   'a7311000-0000-4000-8000-0000000000a3', 'tech', 'Bo Warn', true, true, true, NULL);

INSERT INTO public.services (id, organization_id, name, service_line, price_unit,
                             base_price_cents, extra_pet_cents, default_duration_min, max_dogs, active) VALUES
  ('55731100-0000-4000-8000-0000000000a1', '07311000-0000-4000-8000-0000000000aa',
   'Pack walk', 'dog_walking', 'visit', 2000, 0, 60, 8, true);

CREATE TEMP TABLE proof_day ON COMMIT DROP AS
  SELECT (now() AT TIME ZONE 'America/Chicago')::date + 20 AS d;
GRANT SELECT ON proof_day TO authenticated;

-- Five clients, a plan each carrying its dog count, one visit each on D.
-- A: 2 dogs, B: 1, C: 1, D: 2, E: 2.
INSERT INTO public.clients (id, organization_id, account_type, display_name)
SELECT ('c7311000-0000-4000-8000-0000000000a' || k)::uuid, '07311000-0000-4000-8000-0000000000aa',
       'residential', 'Warn Client ' || k
  FROM unnest(ARRAY['1','2','3','4','5']) AS k;
INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code, latitude, longitude)
SELECT ('e7311000-0000-4000-8000-0000000000a' || k)::uuid, '07311000-0000-4000-8000-0000000000aa',
       ('c7311000-0000-4000-8000-0000000000a' || k)::uuid, k || ' Warn St', 'Chicago', '60614',
       41.93 + k::int * 0.001, -87.66
  FROM unnest(ARRAY['1','2','3','4','5']) AS k;
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency,
                                  price_cents, dog_count, started_on, service_id)
SELECT ('d7311000-0000-4000-8000-0000000000a' || x.k)::uuid, '07311000-0000-4000-8000-0000000000aa',
       ('c7311000-0000-4000-8000-0000000000a' || x.k)::uuid,
       ('e7311000-0000-4000-8000-0000000000a' || x.k)::uuid,
       'residential', 'weekly', 2000, x.dogs, p.d, '55731100-0000-4000-8000-0000000000a1'
  FROM proof_day p, (VALUES ('1', 2), ('2', 1), ('3', 1), ('4', 2), ('5', 2)) AS x(k, dogs);
-- Whatever the plans generated is not ours; our five are named.
DELETE FROM public.visits WHERE organization_id = '07311000-0000-4000-8000-0000000000aa';
INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id, service_id,
                           scheduled_on, status)
SELECT ('f7311000-0000-4000-8000-0000000000a' || k)::uuid, '07311000-0000-4000-8000-0000000000aa',
       ('d7311000-0000-4000-8000-0000000000a' || k)::uuid,
       ('c7311000-0000-4000-8000-0000000000a' || k)::uuid,
       ('e7311000-0000-4000-8000-0000000000a' || k)::uuid,
       '55731100-0000-4000-8000-0000000000a1', p.d, 'scheduled'
  FROM proof_day p, unnest(ARRAY['1','2','3','4','5']) AS k;

-- G1 with Ann; G2 with nobody.
INSERT INTO public.walk_groups (id, organization_id, service_id, scheduled_on, assigned_staff_id)
SELECT x.id::uuid, '07311000-0000-4000-8000-0000000000aa', '55731100-0000-4000-8000-0000000000a1', p.d, x.walker::uuid
  FROM proof_day p, (VALUES
    ('97311000-0000-4000-8000-0000000000b1', '5e731100-0000-4000-8000-0000000000a2'),
    ('97311000-0000-4000-8000-0000000000b2', NULL)
  ) AS x(id, walker);
-- D (2) and E (2) are G2's walks, with nobody holding them yet. Steps 3
-- and 6 hand them to a walker.
UPDATE public.visits SET walk_group_id = '97311000-0000-4000-8000-0000000000b2'
 WHERE id IN ('f7311000-0000-4000-8000-0000000000a4', 'f7311000-0000-4000-8000-0000000000a5');
DO $g2$ BEGIN
  IF (SELECT count(*) FROM public.visits WHERE walk_group_id = '97311000-0000-4000-8000-0000000000b2'
        AND assigned_staff_id IS NULL) <> 2 THEN
    RAISE EXCEPTION 'PROOF SETUP: G2 does not hold D and E, unheld';
  END IF;
END $g2$;

-- The office (the owner) is who presses the buttons.
SELECT set_config('request.jwt.claims',
  '{"sub":"a7311000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1"}', true);

-- ── 1. One dog over, not confirmed: refused, nothing changes ──────────────
DO $$
DECLARE _m text; _h text; _d text;
BEGIN
  UPDATE public.visits SET walk_group_id = '97311000-0000-4000-8000-0000000000b1'
   WHERE id IN ('f7311000-0000-4000-8000-0000000000a1', 'f7311000-0000-4000-8000-0000000000a2');
  BEGIN
    UPDATE public.visits SET walk_group_id = '97311000-0000-4000-8000-0000000000b1'
     WHERE id = 'f7311000-0000-4000-8000-0000000000a3';
    RAISE EXCEPTION 'PROOF FAILED [warn]: a fourth dog joined Ann''s walk past her cap of three with nothing said';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS _m = MESSAGE_TEXT, _h = PG_EXCEPTION_HINT, _d = PG_EXCEPTION_DETAIL;
  END;
  IF _m IS DISTINCT FROM 'This walk will have 4 dogs; the cap is 3.' OR _h IS DISTINCT FROM 'dog_cap'
     OR (_d::jsonb ->> 'dogs')::int <> 4 OR (_d::jsonb ->> 'cap')::int <> 3
     OR (_d::jsonb ->> 'walker') IS DISTINCT FROM 'Ann Warn' THEN
    RAISE EXCEPTION 'PROOF FAILED [warn]: the refusal said "%", hint "%", detail %', _m, _h, _d;
  END IF;
  IF (SELECT walk_group_id FROM public.visits WHERE id = 'f7311000-0000-4000-8000-0000000000a3') IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.walk_dog_cap_overrides WHERE organization_id = '07311000-0000-4000-8000-0000000000aa') THEN
    RAISE EXCEPTION 'PROOF FAILED [cancel]: a refused over-cap write changed something';
  END IF;
  RAISE NOTICE 'ok: one dog over, unconfirmed, is refused with "%" and nothing changes', _m;
END $$;

-- ── 2. Confirmed: saved and recorded ──────────────────────────────────────
SELECT set_config('request.headers', '{"x-dog-cap-acknowledged":"yes"}', true);
UPDATE public.visits SET walk_group_id = '97311000-0000-4000-8000-0000000000b1'
 WHERE id = 'f7311000-0000-4000-8000-0000000000a3';
SELECT set_config('request.headers', '{}', true);
DO $$
DECLARE r public.walk_dog_cap_overrides%ROWTYPE;
BEGIN
  IF (SELECT walk_group_id FROM public.visits WHERE id = 'f7311000-0000-4000-8000-0000000000a3')
     IS DISTINCT FROM '97311000-0000-4000-8000-0000000000b1' THEN
    RAISE EXCEPTION 'PROOF FAILED [confirm]: the confirmed assignment was not saved';
  END IF;
  SELECT * INTO r FROM public.walk_dog_cap_overrides
   WHERE walk_group_id = '97311000-0000-4000-8000-0000000000b1';
  IF r.id IS NULL OR r.staff_id <> '5e731100-0000-4000-8000-0000000000a2' OR r.dogs <> 4 OR r.cap <> 3
     OR r.over_by <> 1 OR r.recorded_by IS DISTINCT FROM 'a7311000-0000-4000-8000-0000000000a1' THEN
    RAISE EXCEPTION 'PROOF FAILED [record]: %', row_to_json(r);
  END IF;
  RAISE NOTICE 'ok: confirmed, it is saved and recorded: the owner took Ann to 4 dogs, over by 1';
END $$;

-- ── 3. Drag, bulk assign and Cover meet the same check ────────────────────
-- G2's walks, D (2) and E (2), handed to Ann one at a time: D fits, E does not.
DO $$
DECLARE _m text;
BEGIN
  PERFORM public.reassign_visit('f7311000-0000-4000-8000-0000000000a4', '5e731100-0000-4000-8000-0000000000a2');
  -- Drag.
  BEGIN
    PERFORM public.reassign_visit('f7311000-0000-4000-8000-0000000000a5', '5e731100-0000-4000-8000-0000000000a2');
    RAISE EXCEPTION 'PROOF FAILED [drag]: a drag took Ann past her cap with nothing said';
  EXCEPTION WHEN check_violation THEN _m := SQLERRM;
  END;
  IF _m IS DISTINCT FROM 'This walk will have 4 dogs; the cap is 3.' THEN
    RAISE EXCEPTION 'PROOF FAILED [drag]: the refusal said "%"', _m;
  END IF;
  -- Bulk assign: one statement, so neither of a batch moves.
  _m := NULL;
  BEGIN
    PERFORM public.bulk_reassign_visits(
      ARRAY['f7311000-0000-4000-8000-0000000000a5']::uuid[], '5e731100-0000-4000-8000-0000000000a2');
    RAISE EXCEPTION 'PROOF FAILED [bulk]: bulk assign took Ann past her cap with nothing said';
  EXCEPTION WHEN check_violation THEN _m := SQLERRM;
  END;
  IF _m IS DISTINCT FROM 'This walk will have 4 dogs; the cap is 3.' THEN
    RAISE EXCEPTION 'PROOF FAILED [bulk]: the refusal said "%"', _m;
  END IF;
  IF (SELECT assigned_staff_id FROM public.visits WHERE id = 'f7311000-0000-4000-8000-0000000000a5') IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [cancel]: a refused drag or bulk assign moved the walk';
  END IF;
  RAISE NOTICE 'ok: drag and bulk assign are refused the same way, and handing walks one at a time is checked';
END $$;

-- Confirmed bulk assign: saved, recorded.
SELECT set_config('request.headers', '{"x-dog-cap-acknowledged":"yes"}', true);
SELECT public.bulk_reassign_visits(
  ARRAY['f7311000-0000-4000-8000-0000000000a5']::uuid[], '5e731100-0000-4000-8000-0000000000a2');
SELECT set_config('request.headers', '{}', true);
DO $$
BEGIN
  IF (SELECT assigned_staff_id FROM public.visits WHERE id = 'f7311000-0000-4000-8000-0000000000a5')
     IS DISTINCT FROM '5e731100-0000-4000-8000-0000000000a2'
     OR NOT EXISTS (SELECT 1 FROM public.walk_dog_cap_overrides
                     WHERE walk_group_id = '97311000-0000-4000-8000-0000000000b2' AND dogs = 4 AND cap = 3) THEN
    RAISE EXCEPTION 'PROOF FAILED [bulk confirm]: not saved and recorded';
  END IF;
  RAISE NOTICE 'ok: a confirmed bulk assign is saved and recorded';
END $$;

-- Reopen (Product review, should-fix 1): a completed walk gave its place
-- back, so reopening it can put its walk over the cap. B (1) on G1 is
-- completed, then reopened with Ann at 4 of 3 already: 4 - 1 + 1, still
-- over, so it is refused unconfirmed and stays completed.
UPDATE public.visits SET status = 'completed', completed_at = now()
 WHERE id = 'f7311000-0000-4000-8000-0000000000a2';
DO $$
DECLARE _m text;
BEGIN
  BEGIN
    PERFORM public.office_reopen_visit('f7311000-0000-4000-8000-0000000000a2');
    RAISE EXCEPTION 'PROOF FAILED [reopen]: reopening put Ann back over her cap with nothing said';
  EXCEPTION WHEN check_violation THEN _m := SQLERRM;
  END;
  IF _m IS DISTINCT FROM 'This walk will have 4 dogs; the cap is 3.' THEN
    RAISE EXCEPTION 'PROOF FAILED [reopen]: the refusal said "%"', _m;
  END IF;
  IF (SELECT status FROM public.visits WHERE id = 'f7311000-0000-4000-8000-0000000000a2') <> 'completed' THEN
    RAISE EXCEPTION 'PROOF FAILED [reopen cancel]: a refused reopen changed the visit';
  END IF;
  RAISE NOTICE 'ok: reopening a completed walk onto a full walk is refused the same way and stays completed';
END $$;
SELECT set_config('request.headers', '{"x-dog-cap-acknowledged":"yes"}', true);
SELECT public.office_reopen_visit('f7311000-0000-4000-8000-0000000000a2');
SELECT set_config('request.headers', '{}', true);
DO $$
BEGIN
  IF (SELECT status FROM public.visits WHERE id = 'f7311000-0000-4000-8000-0000000000a2') <> 'scheduled' THEN
    RAISE EXCEPTION 'PROOF FAILED [reopen confirm]: a confirmed reopen did not reopen';
  END IF;
  RAISE NOTICE 'ok: a confirmed reopen goes ahead and is recorded';
END $$;

-- Cover: G2 back to Bo (no cap), Ann's cap lowered to 1, then Cover Bo. The
-- only other walker is Ann, so all of G2 would go to her: 4 dogs over 1.
UPDATE public.visits SET assigned_staff_id = '5e731100-0000-4000-8000-0000000000a3'
 WHERE walk_group_id = '97311000-0000-4000-8000-0000000000b2';
UPDATE public.staff SET max_dogs_per_walk = 1 WHERE id = '5e731100-0000-4000-8000-0000000000a2';
DO $$
DECLARE _m text;
BEGIN
  BEGIN
    PERFORM public.redistribute_staff_work('5e731100-0000-4000-8000-0000000000a3', (SELECT d FROM proof_day));
    RAISE EXCEPTION 'PROOF FAILED [cover]: Cover took Ann past her cap with nothing said';
  EXCEPTION WHEN check_violation THEN _m := SQLERRM;
  END;
  IF _m NOT LIKE 'This walk will have % dogs; the cap is 1.' THEN
    RAISE EXCEPTION 'PROOF FAILED [cover]: the refusal said "%"', _m;
  END IF;
  IF EXISTS (SELECT 1 FROM public.visits WHERE walk_group_id = '97311000-0000-4000-8000-0000000000b2'
              AND assigned_staff_id IS DISTINCT FROM '5e731100-0000-4000-8000-0000000000a3') THEN
    RAISE EXCEPTION 'PROOF FAILED [cover cancel]: a refused Cover moved some of the work';
  END IF;
  RAISE NOTICE 'ok: Cover is refused the same way, as one piece: "%"', _m;
END $$;
SELECT set_config('request.headers', '{"x-dog-cap-acknowledged":"yes"}', true);
SELECT public.redistribute_staff_work('5e731100-0000-4000-8000-0000000000a3', (SELECT d FROM proof_day));
SELECT set_config('request.headers', '{}', true);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.visits WHERE walk_group_id = '97311000-0000-4000-8000-0000000000b2'
              AND assigned_staff_id IS DISTINCT FROM '5e731100-0000-4000-8000-0000000000a2')
     OR NOT EXISTS (SELECT 1 FROM public.walk_dog_cap_overrides
                     WHERE walk_group_id = '97311000-0000-4000-8000-0000000000b2' AND cap = 1 AND dogs = 4) THEN
    RAISE EXCEPTION 'PROOF FAILED [cover confirm]: a confirmed Cover was not saved and recorded';
  END IF;
  RAISE NOTICE 'ok: a confirmed Cover is saved and recorded (4 dogs over a cap of 1)';
END $$;

-- ── 4. Flagged for the office and the walker; the record is the office's ───
SET LOCAL ROLE authenticated;
DO $$
DECLARE _office int; _records int;
BEGIN
  SELECT count(*) INTO _office FROM public.walks_over_dog_cap(
    '07311000-0000-4000-8000-0000000000aa', (SELECT d FROM proof_day));
  SELECT count(*) INTO _records FROM public.walk_dog_cap_overrides
   WHERE organization_id = '07311000-0000-4000-8000-0000000000aa';
  IF _office <> 2 OR _records < 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [flag office]: % walks flagged, % records readable', _office, _records;
  END IF;
  PERFORM set_config('request.jwt.claims',
    '{"sub":"a7311000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal1"}', true);
  IF (SELECT count(*) FROM public.walks_over_dog_cap(
        '07311000-0000-4000-8000-0000000000aa', (SELECT d FROM proof_day))) <> 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [flag walker]: Ann does not see her own walks flagged';
  END IF;
  IF (SELECT count(*) FROM public.walk_dog_cap_overrides) <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [record]: a walker can read the office''s over-cap records';
  END IF;
  PERFORM set_config('request.jwt.claims',
    '{"sub":"a7311000-0000-4000-8000-0000000000a3","role":"authenticated","aal":"aal1"}', true);
  IF (SELECT count(*) FROM public.walks_over_dog_cap(
        '07311000-0000-4000-8000-0000000000aa', (SELECT d FROM proof_day))) <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [flag other]: Bo sees Ann''s walks flagged';
  END IF;
  PERFORM set_config('request.jwt.claims',
    '{"sub":"a7311000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1"}', true);
  RAISE NOTICE 'ok: flagged for the office and for Ann, not for Bo; only the office reads the record';
END $$;
RESET ROLE;

-- ── 5. Back under the cap: no longer flagged ──────────────────────────────
UPDATE public.staff SET max_dogs_per_walk = 10 WHERE id = '5e731100-0000-4000-8000-0000000000a2';
DO $$
BEGIN
  IF (SELECT count(*) FROM public.walks_over_dog_cap(
        '07311000-0000-4000-8000-0000000000aa', (SELECT d FROM proof_day))) <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [under]: a walk back under its cap is still flagged';
  END IF;
  RAISE NOTICE 'ok: back under the cap, the walk is no longer flagged';
END $$;

-- ── 6. Mutation: without the triggers, an over-cap write is silent ────────
DO $$
DECLARE _before int;
BEGIN
  UPDATE public.staff SET max_dogs_per_walk = 1 WHERE id = '5e731100-0000-4000-8000-0000000000a2';
  DROP TRIGGER visits_validate_walk_group_walker_cap ON public.visits;
  DROP TRIGGER walk_groups_walker_cap ON public.walk_groups;
  SELECT count(*) INTO _before FROM public.walk_dog_cap_overrides;
  BEGIN
    UPDATE public.visits SET walk_group_id = NULL WHERE id = 'f7311000-0000-4000-8000-0000000000a3';
    UPDATE public.visits SET walk_group_id = '97311000-0000-4000-8000-0000000000b1'
     WHERE id = 'f7311000-0000-4000-8000-0000000000a3';
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'PROOF INCONCLUSIVE [mutation]: with the cap triggers gone an over-cap write was still refused: %', SQLERRM;
  END;
  IF (SELECT count(*) FROM public.walk_dog_cap_overrides) <> _before THEN
    RAISE EXCEPTION 'PROOF INCONCLUSIVE [mutation]: something other than the triggers recorded it';
  END IF;
  RAISE NOTICE 'ok: mutation reproduces: without the cap triggers a walk goes over its cap silently and unrecorded';
END $$;

ROLLBACK;
\echo ALL DOG CAP WARNING PROOFS PASSED
