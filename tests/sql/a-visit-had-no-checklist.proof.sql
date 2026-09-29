-- The visit checklist, proved against a real Postgres rather than read off
-- the migration's text. Run by tests/a-required-item-left-unchecked-refuses-
-- the-visit.test.ts, which passes the migration's path as :migration.
--
-- Everything happens inside one transaction that is ROLLED BACK at the end,
-- the migration included, so this can be pointed at a shared local stack
-- without leaving a column, a function or a row behind. Each check prints
-- "ok: ..." or raises "PROOF FAILED [...]", and ON_ERROR_STOP turns the first
-- failure into a non-zero exit.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

BEGIN;

-- Two test files run this proof, and vitest runs files in parallel. Both
-- transactions create the same function, drop the same overload and insert
-- the same fixture ids, so one waits on the other mid-migration; taking a
-- lock first makes the second wait at the door instead.
SELECT pg_advisory_xact_lock(hashtext('a-visit-had-no-checklist.proof'));

\i :migration

-- ── Fixture: one tenant, an owner, a tech, and three visits in progress ────
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('c1000000-0000-4000-8000-00000000c001', 'owner@checklist.proof.invalid'),
  ('c1000000-0000-4000-8000-00000000c002', 'tech@checklist.proof.invalid');

INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0c000000-0000-4000-8000-0000000000cc', 'Checklist Proof', 'America/Chicago');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('c1000000-0000-4000-8000-00000000c001', '0c000000-0000-4000-8000-0000000000cc', 'owner'),
  ('c1000000-0000-4000-8000-00000000c002', '0c000000-0000-4000-8000-0000000000cc', 'tech');

INSERT INTO public.staff (id, organization_id, user_id, role, display_name) VALUES
  ('5c000000-0000-4000-8000-0000000000c2', '0c000000-0000-4000-8000-0000000000cc',
   'c1000000-0000-4000-8000-00000000c002', 'tech', 'Proof Tech');

INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('cc000000-0000-4000-8000-0000000000c1', '0c000000-0000-4000-8000-0000000000cc',
   'residential', 'Proof Client');
INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code) VALUES
  ('9c000000-0000-4000-8000-0000000000c1', '0c000000-0000-4000-8000-0000000000cc',
   'cc000000-0000-4000-8000-0000000000c1', '1 Proof Lane', 'Chicago', '60601');
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency, price_cents, dog_count) VALUES
  ('5b000000-0000-4000-8000-0000000000c1', '0c000000-0000-4000-8000-0000000000cc',
   'cc000000-0000-4000-8000-0000000000c1', '9c000000-0000-4000-8000-0000000000c1',
   'residential', 'weekly', 2000, 1);

-- v1: completed with no checklist. v2: completed with one. v3: a replay.
INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id,
                           scheduled_on, status, started_at, assigned_staff_id)
SELECT ('7c000000-0000-4000-8000-00000000000' || n)::uuid, '0c000000-0000-4000-8000-0000000000cc',
       '5b000000-0000-4000-8000-0000000000c1', 'cc000000-0000-4000-8000-0000000000c1',
       '9c000000-0000-4000-8000-0000000000c1', current_date - (n - 1), 'in_progress',
       now() - interval '30 minutes', '5c000000-0000-4000-8000-0000000000c2'
  FROM generate_series(1, 3) n;

-- The photo rule is not what is under test here.
UPDATE public.organizations SET require_completion_photo = false
 WHERE id = '0c000000-0000-4000-8000-0000000000cc';

-- ── An existing organization changes nothing ────────────────────────────────
DO $$
DECLARE _list jsonb;
BEGIN
  SELECT visit_checklist INTO _list FROM public.organizations
   WHERE id = '0c000000-0000-4000-8000-0000000000cc';
  IF _list IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'PROOF FAILED [default]: a new organization starts with %', _list;
  END IF;
  RAISE NOTICE 'ok: an organization starts with an empty checklist';
END $$;

-- ── The owner writes the list, through RLS, and the shape rule holds ───────
SET LOCAL request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-00000000c001","role":"authenticated"}';
SET ROLE authenticated;
DO $$
DECLARE _err text;
BEGIN
  UPDATE public.organizations
     SET visit_checklist = '[
       {"id":"gate","label":"Gate latched","required":true},
       {"id":"walk","label":"All areas walked","required":true},
       {"id":"bowl","label":"Water bowl checked","required":false}
     ]'::jsonb,
         email_visit_checklist = true
   WHERE id = '0c000000-0000-4000-8000-0000000000cc';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROOF FAILED [owner write]: the owner could not save a checklist';
  END IF;

  BEGIN
    UPDATE public.organizations
       SET visit_checklist = (SELECT jsonb_agg(jsonb_build_object('id', g::text, 'label', 'x', 'required', false))
                                FROM generate_series(1, 13) g)
     WHERE id = '0c000000-0000-4000-8000-0000000000cc';
  EXCEPTION WHEN check_violation THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [shape]: a thirteen-item checklist was saved';
  END IF;
  _err := NULL;
  BEGIN
    UPDATE public.organizations
       SET visit_checklist = '[{"id":"gate","label":"   ","required":true}]'::jsonb
     WHERE id = '0c000000-0000-4000-8000-0000000000cc';
  EXCEPTION WHEN check_violation THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [shape]: an item with a blank label was saved';
  END IF;
  RAISE NOTICE 'ok: the owner saves a checklist, and twelve items with labels is the limit';
END $$;
RESET ROLE;

-- ── The tech ────────────────────────────────────────────────────────────────
SET LOCAL request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-00000000c002","role":"authenticated"}';
SET ROLE authenticated;

DO $$
DECLARE _err text; _status text;
BEGIN
  -- Nothing checked at all.
  BEGIN
    PERFORM public.complete_visit('7c000000-0000-4000-8000-000000000002');
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL OR _err NOT LIKE 'Check off every required item%Gate latched, All areas walked' THEN
    RAISE EXCEPTION 'PROOF FAILED [refuse]: nothing checked gave %', COALESCE(_err, 'a completion');
  END IF;

  -- One of two required, plus the optional one.
  _err := NULL;
  BEGIN
    PERFORM public.complete_visit('7c000000-0000-4000-8000-000000000002', NULL, NULL, NULL,
                                  ARRAY['gate', 'bowl']);
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL OR _err NOT LIKE '%: All areas walked' THEN
    RAISE EXCEPTION 'PROOF FAILED [refuse]: one required unchecked gave %', COALESCE(_err, 'a completion');
  END IF;

  SELECT status::text INTO _status FROM public.visits WHERE id = '7c000000-0000-4000-8000-000000000002';
  IF _status <> 'in_progress' THEN
    RAISE EXCEPTION 'PROOF FAILED [refuse]: a refused completion left the visit %', _status;
  END IF;
  RAISE NOTICE 'ok: completing is refused while a required item is unchecked, and names it';
END $$;

DO $$
DECLARE _err text; _status text; _answers jsonb;
BEGIN
  -- The replay path is held to the same rule: a timestamp is not a way round it.
  BEGIN
    PERFORM public.complete_visit('7c000000-0000-4000-8000-000000000003', now() - interval '5 minutes',
                                  NULL, NULL, ARRAY['walk']);
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL OR _err NOT LIKE '%: Gate latched' THEN
    RAISE EXCEPTION 'PROOF FAILED [replay]: an offline replay skipped the checklist: %', COALESCE(_err, 'completed');
  END IF;

  PERFORM public.complete_visit('7c000000-0000-4000-8000-000000000003', now() - interval '5 minutes',
                                'Bags by the shed', NULL, ARRAY['walk', 'gate']);
  SELECT status::text, visit_checklist INTO _status, _answers
    FROM public.visits WHERE id = '7c000000-0000-4000-8000-000000000003';
  IF _status <> 'completed' OR jsonb_array_length(_answers) <> 3 THEN
    RAISE EXCEPTION 'PROOF FAILED [replay]: %, %', _status, _answers;
  END IF;
  RAISE NOTICE 'ok: a replayed completion is held to the checklist and records its answers';
END $$;

DO $$
DECLARE _status text; _answers jsonb;
BEGIN
  PERFORM public.complete_visit('7c000000-0000-4000-8000-000000000002', NULL, NULL, NULL,
                                ARRAY['walk', 'gate', 'not-on-the-list']);
  SELECT status::text, visit_checklist INTO _status, _answers
    FROM public.visits WHERE id = '7c000000-0000-4000-8000-000000000002';
  IF _status <> 'completed' THEN
    RAISE EXCEPTION 'PROOF FAILED [complete]: every required item checked left the visit %', _status;
  END IF;
  -- In the owner's order, every item answered, an unknown id ignored.
  IF _answers IS DISTINCT FROM '[
       {"id":"gate","label":"Gate latched","required":true,"checked":true},
       {"id":"walk","label":"All areas walked","required":true,"checked":true},
       {"id":"bowl","label":"Water bowl checked","required":false,"checked":false}
     ]'::jsonb THEN
    RAISE EXCEPTION 'PROOF FAILED [answers]: recorded %', _answers;
  END IF;
  RAISE NOTICE 'ok: every required item checked completes, and records every item answered';
END $$;
RESET ROLE;

-- ── Editing the list later does not rewrite what was answered ──────────────
UPDATE public.organizations
   SET visit_checklist = '[{"id":"gate","label":"Gate latched and chained","required":true}]'::jsonb
 WHERE id = '0c000000-0000-4000-8000-0000000000cc';
DO $$
DECLARE _answers jsonb;
BEGIN
  SELECT visit_checklist INTO _answers FROM public.visits
   WHERE id = '7c000000-0000-4000-8000-000000000002';
  IF _answers -> 0 ->> 'label' <> 'Gate latched' OR jsonb_array_length(_answers) <> 3 THEN
    RAISE EXCEPTION 'PROOF FAILED [snapshot]: renaming the item changed the visit to %', _answers;
  END IF;
  RAISE NOTICE 'ok: the label on a completed visit is the one it had that day';
END $$;

-- ── An organization with no checklist completes as it always has ───────────
UPDATE public.organizations SET visit_checklist = '[]'::jsonb
 WHERE id = '0c000000-0000-4000-8000-0000000000cc';
SET LOCAL request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-00000000c002","role":"authenticated"}';
SET ROLE authenticated;
DO $$
DECLARE _status text; _answers jsonb;
BEGIN
  PERFORM public.complete_visit('7c000000-0000-4000-8000-000000000001');
  SELECT status::text, visit_checklist INTO _status, _answers
    FROM public.visits WHERE id = '7c000000-0000-4000-8000-000000000001';
  IF _status <> 'completed' OR _answers IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [no checklist]: %, %', _status, _answers;
  END IF;
  RAISE NOTICE 'ok: with no checklist, a visit completes with nothing asked and nothing recorded';
END $$;
RESET ROLE;

-- ── Nobody else ─────────────────────────────────────────────────────────────
SET ROLE anon;
DO $$
DECLARE _err text;
BEGIN
  BEGIN
    PERFORM public.complete_visit('7c000000-0000-4000-8000-000000000001', NULL, NULL, NULL, ARRAY['gate']);
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [anon]: anon can call complete_visit'; END IF;
  RAISE NOTICE 'ok: anon cannot call complete_visit';
END $$;
RESET ROLE;

\echo ALL CHECKLIST PROOFS PASSED
ROLLBACK;
