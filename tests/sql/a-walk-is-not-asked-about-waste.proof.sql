-- The visit checklist per line (#565), proved against a real Postgres. Run by
-- tests/visit-checklist-per-line.test.tsx, which passes the migration's path
-- as :migration.
--
-- Everything happens inside one transaction that is ROLLED BACK at the end,
-- the migration included. Each check prints "ok: ..." or raises
-- "PROOF FAILED [...]", and ON_ERROR_STOP turns the first failure into a
-- non-zero exit.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :migration

-- ── Fixture: a business that scoops and walks, a tech, four visits ─────────
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('c2000000-0000-4000-8000-00000000c001', 'owner@per-line.proof.invalid'),
  ('c2000000-0000-4000-8000-00000000c002', 'tech@per-line.proof.invalid');

INSERT INTO public.organizations (id, name, timezone, service_lines) VALUES
  ('0d000000-0000-4000-8000-0000000000dd', 'Per-line Checklist Proof', 'America/Chicago',
   '{pet_waste,dog_walking}');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('c2000000-0000-4000-8000-00000000c001', '0d000000-0000-4000-8000-0000000000dd', 'owner'),
  ('c2000000-0000-4000-8000-00000000c002', '0d000000-0000-4000-8000-0000000000dd', 'tech');

INSERT INTO public.staff (id, organization_id, user_id, role, display_name) VALUES
  ('5d000000-0000-4000-8000-0000000000d2', '0d000000-0000-4000-8000-0000000000dd',
   'c2000000-0000-4000-8000-00000000c002', 'tech', 'Proof Tech');

INSERT INTO public.services
  (id, organization_id, name, service_line, price_unit, base_price_cents, default_duration_min, active)
VALUES
  ('5e000000-0000-4000-8000-0000000000d1', '0d000000-0000-4000-8000-0000000000dd',
   'Proof walk', 'dog_walking', 'visit', 2500, 30, true);

INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('cd000000-0000-4000-8000-0000000000d1', '0d000000-0000-4000-8000-0000000000dd',
   'residential', 'Proof Client');
INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code) VALUES
  ('9d000000-0000-4000-8000-0000000000d1', '0d000000-0000-4000-8000-0000000000dd',
   'cd000000-0000-4000-8000-0000000000d1', '1 Proof Lane', 'Chicago', '60601');
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency, price_cents, dog_count) VALUES
  ('5f000000-0000-4000-8000-0000000000d1', '0d000000-0000-4000-8000-0000000000dd',
   'cd000000-0000-4000-8000-0000000000d1', '9d000000-0000-4000-8000-0000000000d1',
   'residential', 'weekly', 2000, 1);

-- v1, v4: walks. v2: a scoop (the plan's pet-waste service). v3: no service.
INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id,
                           scheduled_on, status, started_at, assigned_staff_id, service_id)
SELECT ('7d000000-0000-4000-8000-00000000000' || n)::uuid, '0d000000-0000-4000-8000-0000000000dd',
       '5f000000-0000-4000-8000-0000000000d1', 'cd000000-0000-4000-8000-0000000000d1',
       '9d000000-0000-4000-8000-0000000000d1', current_date - (n - 1), 'in_progress',
       now() - interval '30 minutes', '5d000000-0000-4000-8000-0000000000d2',
       CASE WHEN n IN (1, 4) THEN '5e000000-0000-4000-8000-0000000000d1'::uuid END
  FROM generate_series(1, 4) n;
UPDATE public.visits SET service_id = NULL WHERE id = '7d000000-0000-4000-8000-000000000003';

DO $$
BEGIN
  IF (SELECT s.service_line FROM public.visits v JOIN public.services s ON s.id = v.service_id
       WHERE v.id = '7d000000-0000-4000-8000-000000000002') IS DISTINCT FROM 'pet_waste'
     OR (SELECT service_id FROM public.visits WHERE id = '7d000000-0000-4000-8000-000000000003') IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [fixture]: the scoop is not pet waste, or the no-service visit has one';
  END IF;
END $$;

UPDATE public.organizations
   SET require_completion_photo = false,
       visit_checklist = '[
         {"id":"all","label":"All areas walked","required":true},
         {"id":"waste","label":"Waste bagged and disposed","required":true,"line":"pet_waste"},
         {"id":"dog","label":"Dog collected and returned","required":true,"line":"dog_walking"}
       ]'::jsonb
 WHERE id = '0d000000-0000-4000-8000-0000000000dd';

-- ── The tech ────────────────────────────────────────────────────────────────
SET LOCAL request.jwt.claims = '{"sub":"c2000000-0000-4000-8000-00000000c002","role":"authenticated"}';
SET ROLE authenticated;

DO $$
DECLARE _err text; _status text; _answers jsonb;
BEGIN
  -- The walk is still asked its own required item.
  BEGIN
    PERFORM public.complete_visit('7d000000-0000-4000-8000-000000000001', NULL, NULL, NULL, ARRAY['all']);
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL OR _err NOT LIKE '%: Dog collected and returned' THEN
    RAISE EXCEPTION 'PROOF FAILED [walk]: the walk''s own item was not asked: %', COALESCE(_err, 'completed');
  END IF;

  PERFORM public.complete_visit('7d000000-0000-4000-8000-000000000001', NULL, NULL, NULL, ARRAY['all', 'dog']);
  SELECT status::text, visit_checklist INTO _status, _answers
    FROM public.visits WHERE id = '7d000000-0000-4000-8000-000000000001';
  IF _status <> 'completed' THEN
    RAISE EXCEPTION 'PROOF FAILED [walk]: a walk with its items checked was left %', _status;
  END IF;
  IF _answers IS DISTINCT FROM '[
       {"id":"all","label":"All areas walked","required":true,"checked":true},
       {"id":"dog","label":"Dog collected and returned","required":true,"checked":true}
     ]'::jsonb THEN
    RAISE EXCEPTION 'PROOF FAILED [walk answers]: recorded %', _answers;
  END IF;
  RAISE NOTICE 'ok: a walk completes without the waste item, and records only what it was asked';
END $$;

DO $$
DECLARE _err text; _status text; _answers jsonb;
BEGIN
  BEGIN
    PERFORM public.complete_visit('7d000000-0000-4000-8000-000000000002', NULL, NULL, NULL, ARRAY['all', 'dog']);
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL OR _err NOT LIKE 'Check off every required item%: Waste bagged and disposed' THEN
    RAISE EXCEPTION 'PROOF FAILED [scoop]: a scoop finished without the waste item: %', COALESCE(_err, 'completed');
  END IF;
  SELECT status::text INTO _status FROM public.visits WHERE id = '7d000000-0000-4000-8000-000000000002';
  IF _status <> 'in_progress' THEN
    RAISE EXCEPTION 'PROOF FAILED [scoop]: a refused completion left the visit %', _status;
  END IF;

  PERFORM public.complete_visit('7d000000-0000-4000-8000-000000000002', NULL, NULL, NULL, ARRAY['all', 'waste']);
  SELECT status::text, visit_checklist INTO _status, _answers
    FROM public.visits WHERE id = '7d000000-0000-4000-8000-000000000002';
  IF _status <> 'completed' OR jsonb_array_length(_answers) <> 2
     OR _answers -> 1 ->> 'id' <> 'waste' THEN
    RAISE EXCEPTION 'PROOF FAILED [scoop]: %, %', _status, _answers;
  END IF;
  RAISE NOTICE 'ok: a scoop is still refused without the waste item, and completes with it';
END $$;

DO $$
DECLARE _err text;
BEGIN
  BEGIN
    PERFORM public.complete_visit('7d000000-0000-4000-8000-000000000003', NULL, NULL, NULL, ARRAY['all', 'dog']);
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL OR _err NOT LIKE '%: Waste bagged and disposed' THEN
    RAISE EXCEPTION 'PROOF FAILED [no service]: a visit with no service was not asked as pet waste: %',
      COALESCE(_err, 'completed');
  END IF;
  RAISE NOTICE 'ok: a visit with no service is asked the pet-waste items';
END $$;
RESET ROLE;

-- ── A business that only walks: no service is a walk ───────────────────────
-- v3 is still under way, refused above. The same visit in a walking-only
-- business is asked the walking item, not the waste one.
SET LOCAL app.allow_protected_org_write = '1';
UPDATE public.organizations SET service_lines = '{dog_walking}'
 WHERE id = '0d000000-0000-4000-8000-0000000000dd';
SET LOCAL app.allow_protected_org_write = '';
SET LOCAL request.jwt.claims = '{"sub":"c2000000-0000-4000-8000-00000000c002","role":"authenticated"}';
SET ROLE authenticated;
DO $$
DECLARE _err text; _status text; _answers jsonb;
BEGIN
  BEGIN
    PERFORM public.complete_visit('7d000000-0000-4000-8000-000000000003', NULL, NULL, NULL, ARRAY['all', 'waste']);
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL OR _err NOT LIKE '%: Dog collected and returned' THEN
    RAISE EXCEPTION 'PROOF FAILED [one line]: a no-service visit in a walking-only business was not asked as a walk: %',
      COALESCE(_err, 'completed');
  END IF;
  PERFORM public.complete_visit('7d000000-0000-4000-8000-000000000003', NULL, NULL, NULL, ARRAY['all', 'dog']);
  SELECT status::text, visit_checklist INTO _status, _answers
    FROM public.visits WHERE id = '7d000000-0000-4000-8000-000000000003';
  IF _status <> 'completed' OR jsonb_array_length(_answers) <> 2 OR _answers -> 1 ->> 'id' <> 'dog' THEN
    RAISE EXCEPTION 'PROOF FAILED [one line]: %, %', _status, _answers;
  END IF;
  RAISE NOTICE 'ok: a visit with no service in a one-line business is asked that line''s items';
END $$;
RESET ROLE;

-- ── A list saved before lines existed applies to every line ────────────────
UPDATE public.organizations
   SET visit_checklist = '[
         {"id":"gate","label":"Gate latched","required":true},
         {"id":"waste","label":"Waste bagged and disposed","required":true}
       ]'::jsonb
 WHERE id = '0d000000-0000-4000-8000-0000000000dd';
SET LOCAL request.jwt.claims = '{"sub":"c2000000-0000-4000-8000-00000000c002","role":"authenticated"}';
SET ROLE authenticated;
DO $$
DECLARE _err text;
BEGIN
  BEGIN
    PERFORM public.complete_visit('7d000000-0000-4000-8000-000000000004', NULL, NULL, NULL, ARRAY['gate']);
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL OR _err NOT LIKE '%: Waste bagged and disposed' THEN
    RAISE EXCEPTION 'PROOF FAILED [old list]: a list with no lines changed meaning: %', COALESCE(_err, 'completed');
  END IF;
  RAISE NOTICE 'ok: a list with no lines is asked on every visit, as before';
END $$;
RESET ROLE;

-- ── The owner saves lines through RLS, and only known ones ─────────────────
SET LOCAL request.jwt.claims = '{"sub":"c2000000-0000-4000-8000-00000000c001","role":"authenticated"}';
SET ROLE authenticated;
DO $$
DECLARE _err text;
BEGIN
  UPDATE public.organizations
     SET visit_checklist = '[{"id":"dog","label":"Dog collected and returned","required":true,"line":"dog_walking"}]'::jsonb
   WHERE id = '0d000000-0000-4000-8000-0000000000dd';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROOF FAILED [owner write]: the owner could not save an item with a line';
  END IF;
  BEGIN
    UPDATE public.organizations
       SET visit_checklist = '[{"id":"x","label":"Pipes checked","required":true,"line":"plumbing"}]'::jsonb
     WHERE id = '0d000000-0000-4000-8000-0000000000dd';
  EXCEPTION WHEN check_violation THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [shape]: an item for an unknown line was saved';
  END IF;
  RAISE NOTICE 'ok: the owner saves an item with a line, and an unknown line is refused';
END $$;
RESET ROLE;

\echo ALL PER-LINE CHECKLIST PROOFS PASSED
ROLLBACK;
