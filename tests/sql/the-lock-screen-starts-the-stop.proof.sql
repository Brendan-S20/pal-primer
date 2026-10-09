-- Start on the lock screen, proved against a real Postgres rather than read
-- off the migration's text. Run by tests/the-lock-screen-start-is-the-apps-start.test.ts,
-- which passes the migration's path as :migration.
--
-- Everything happens inside one transaction that is ROLLED BACK at the end,
-- the migration included, so this can be pointed at a shared local stack
-- without leaving a table, a function or a row behind. Each group prints
-- "ok: ..." only when every check in it passed, or raises "PROOF FAILED
-- [...]", and ON_ERROR_STOP turns the first failure into a non-zero exit.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :migration

-- ── Fixture: org A with techs Sam and Priya, org B with Omar ───────────────
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('a4000000-0000-4000-8000-00000000a001', 'sam-a@lockstart.proof.invalid'),
  ('a4000000-0000-4000-8000-00000000a002', 'priya-a@lockstart.proof.invalid'),
  ('b4000000-0000-4000-8000-00000000b001', 'omar-b@lockstart.proof.invalid');
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a400000-0000-4000-8000-0000000000aa', 'Lock Start Proof A', 'America/Chicago'),
  ('0b400000-0000-4000-8000-0000000000bb', 'Lock Start Proof B', 'America/Chicago');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a4000000-0000-4000-8000-00000000a001', '0a400000-0000-4000-8000-0000000000aa', 'tech'),
  ('a4000000-0000-4000-8000-00000000a002', '0a400000-0000-4000-8000-0000000000aa', 'tech'),
  ('b4000000-0000-4000-8000-00000000b001', '0b400000-0000-4000-8000-0000000000bb', 'tech');

INSERT INTO public.staff (id, organization_id, user_id, role, display_name) VALUES
  ('5a400000-0000-4000-8000-0000000000a1', '0a400000-0000-4000-8000-0000000000aa',
   'a4000000-0000-4000-8000-00000000a001', 'tech', 'Sam'),
  ('5a400000-0000-4000-8000-0000000000a2', '0a400000-0000-4000-8000-0000000000aa',
   'a4000000-0000-4000-8000-00000000a002', 'tech', 'Priya'),
  ('5b400000-0000-4000-8000-0000000000b1', '0b400000-0000-4000-8000-0000000000bb',
   'b4000000-0000-4000-8000-00000000b001', 'tech', 'Omar');

INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('ca400000-0000-4000-8000-0000000000a1', '0a400000-0000-4000-8000-0000000000aa', 'residential', 'Proof Client A');
INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code) VALUES
  ('9a400000-0000-4000-8000-0000000000a1', '0a400000-0000-4000-8000-0000000000aa',
   'ca400000-0000-4000-8000-0000000000a1', '1 Proof Lane', 'Chicago', '60601');
-- One subscription per visit: a subscription has one visit a day.
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency, price_cents, dog_count)
SELECT ('5ba40000-0000-4000-8000-00000000000' || n)::uuid, '0a400000-0000-4000-8000-0000000000aa',
       'ca400000-0000-4000-8000-0000000000a1', '9a400000-0000-4000-8000-0000000000a1',
       'residential', 'weekly', 2000, 1
  FROM generate_series(1, 3) n;

-- v1 and v2 are Sam's, scheduled today; v3 is Priya's.
INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id,
                           scheduled_on, status, assigned_staff_id)
VALUES
  ('7a400000-0000-4000-8000-000000000001', '0a400000-0000-4000-8000-0000000000aa',
   '5ba40000-0000-4000-8000-000000000001', 'ca400000-0000-4000-8000-0000000000a1',
   '9a400000-0000-4000-8000-0000000000a1', current_date, 'scheduled', '5a400000-0000-4000-8000-0000000000a1'),
  ('7a400000-0000-4000-8000-000000000002', '0a400000-0000-4000-8000-0000000000aa',
   '5ba40000-0000-4000-8000-000000000002', 'ca400000-0000-4000-8000-0000000000a1',
   '9a400000-0000-4000-8000-0000000000a1', current_date, 'scheduled', '5a400000-0000-4000-8000-0000000000a1'),
  ('7a400000-0000-4000-8000-000000000003', '0a400000-0000-4000-8000-0000000000aa',
   '5ba40000-0000-4000-8000-000000000003', 'ca400000-0000-4000-8000-0000000000a1',
   '9a400000-0000-4000-8000-0000000000a1', current_date, 'scheduled', '5a400000-0000-4000-8000-0000000000a2');

-- ── 1. The app's start_visit is unchanged for the tech who calls it ─────────
SELECT set_config('request.jwt.claims',
  '{"sub":"a4000000-0000-4000-8000-00000000a001","role":"authenticated"}', true);
SET ROLE authenticated;
DO $$
DECLARE _s text; _err text;
BEGIN
  PERFORM public.start_visit('7a400000-0000-4000-8000-000000000001');
  SELECT status INTO _s FROM public.visits WHERE id = '7a400000-0000-4000-8000-000000000001';
  IF _s <> 'in_progress' THEN RAISE EXCEPTION 'PROOF FAILED [app]: own visit is %', _s; END IF;
  BEGIN
    PERFORM public.start_visit('7a400000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'PROOF FAILED [app]: Sam started Priya''s visit';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS _err = MESSAGE_TEXT;
    IF _err NOT LIKE 'Not authorized%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'ok: start_visit starts the caller''s own visit and refuses another tech''s';
END $$;

-- ── 2. A browser key cannot reach start_visit_as, or the token tables ──────
DO $$
DECLARE _ok boolean := false;
BEGIN
  BEGIN
    PERFORM public.start_visit_as('a4000000-0000-4000-8000-00000000a002', '7a400000-0000-4000-8000-000000000003');
  EXCEPTION WHEN insufficient_privilege THEN _ok := true;
  END;
  IF NOT _ok THEN RAISE EXCEPTION 'PROOF FAILED [lockdown]: authenticated called start_visit_as'; END IF;
  _ok := false;
  BEGIN
    PERFORM 1 FROM public.live_activity_action_tokens;
  EXCEPTION WHEN insufficient_privilege THEN _ok := true;
  END;
  IF NOT _ok THEN RAISE EXCEPTION 'PROOF FAILED [lockdown]: authenticated read the action tokens'; END IF;
  _ok := false;
  BEGIN
    PERFORM 1 FROM public.live_activity_actions;
  EXCEPTION WHEN insufficient_privilege THEN _ok := true;
  END;
  IF NOT _ok THEN RAISE EXCEPTION 'PROOF FAILED [lockdown]: authenticated read the action log'; END IF;
  RAISE NOTICE 'ok: authenticated can call neither start_visit_as nor read either table';
END $$;
RESET ROLE;

SET ROLE anon;
DO $$
DECLARE _ok boolean := false;
BEGIN
  BEGIN
    PERFORM public.start_visit_as('a4000000-0000-4000-8000-00000000a001', '7a400000-0000-4000-8000-000000000002');
  EXCEPTION WHEN insufficient_privilege THEN _ok := true;
  END;
  IF NOT _ok THEN RAISE EXCEPTION 'PROOF FAILED [lockdown]: anon called start_visit_as'; END IF;
  RAISE NOTICE 'ok: anon cannot call start_visit_as';
END $$;
RESET ROLE;

-- ── 3. The service role starts a visit only for the tech it is assigned to ──
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SET ROLE service_role;
DO $$
DECLARE _s text; _started timestamptz; _again timestamptz; _err text;
BEGIN
  PERFORM public.start_visit_as('a4000000-0000-4000-8000-00000000a001', '7a400000-0000-4000-8000-000000000002');
  SELECT status, started_at INTO _s, _started FROM public.visits WHERE id = '7a400000-0000-4000-8000-000000000002';
  IF _s <> 'in_progress' OR _started IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [as]: Sam''s visit is % at %', _s, _started;
  END IF;
  -- A second press keeps the first start time.
  PERFORM pg_sleep(0.01);
  PERFORM public.start_visit_as('a4000000-0000-4000-8000-00000000a001', '7a400000-0000-4000-8000-000000000002');
  SELECT started_at INTO _again FROM public.visits WHERE id = '7a400000-0000-4000-8000-000000000002';
  IF _again <> _started THEN RAISE EXCEPTION 'PROOF FAILED [as]: a replay moved the start time'; END IF;

  -- Sam's token cannot start Priya's visit, Omar (another business) cannot
  -- start Sam's, and nobody at all cannot start anything.
  BEGIN
    PERFORM public.start_visit_as('a4000000-0000-4000-8000-00000000a001', '7a400000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'PROOF FAILED [as]: Sam started Priya''s visit as the service role';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS _err = MESSAGE_TEXT;
    IF _err NOT LIKE 'Not authorized%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.start_visit_as('b4000000-0000-4000-8000-00000000b001', '7a400000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'PROOF FAILED [as]: another business''s tech started the visit';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS _err = MESSAGE_TEXT;
    IF _err NOT LIKE 'Not authorized%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.start_visit_as(NULL, '7a400000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'PROOF FAILED [as]: a NULL actor started a visit';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS _err = MESSAGE_TEXT;
    IF _err NOT LIKE 'Not authorized%' THEN RAISE; END IF;
  END;
  SELECT status INTO _s FROM public.visits WHERE id = '7a400000-0000-4000-8000-000000000003';
  IF _s <> 'scheduled' THEN RAISE EXCEPTION 'PROOF FAILED [as]: Priya''s visit is %', _s; END IF;
  RAISE NOTICE 'ok: start_visit_as starts only the named tech''s own visit, once, and refuses a NULL actor';
END $$;

-- ── 4. The tables hold what the hook relies on ──────────────────────────────
DO $$
DECLARE _tok uuid; _err text; _ok boolean := false;
BEGIN
  INSERT INTO public.live_activity_action_tokens
    (user_id, organization_id, staff_id, route_date, token_hash, expires_at)
  VALUES ('a4000000-0000-4000-8000-00000000a001', '0a400000-0000-4000-8000-0000000000aa',
          '5a400000-0000-4000-8000-0000000000a1', current_date, repeat('a', 64), now() + interval '8 hours')
  RETURNING id INTO _tok;

  BEGIN
    INSERT INTO public.live_activity_action_tokens
      (user_id, organization_id, staff_id, route_date, token_hash, expires_at)
    VALUES ('a4000000-0000-4000-8000-00000000a001', '0a400000-0000-4000-8000-0000000000aa',
            '5a400000-0000-4000-8000-0000000000a1', current_date, repeat('b', 64), now() + interval '17 hours');
  EXCEPTION WHEN check_violation THEN _ok := true;
  END;
  IF NOT _ok THEN RAISE EXCEPTION 'PROOF FAILED [tables]: a 17-hour token was stored'; END IF;

  _ok := false;
  BEGIN
    INSERT INTO public.live_activity_action_tokens
      (user_id, organization_id, staff_id, route_date, token_hash, expires_at)
    VALUES ('a4000000-0000-4000-8000-00000000a001', '0a400000-0000-4000-8000-0000000000aa',
            '5a400000-0000-4000-8000-0000000000a1', current_date, 'not-a-hash', now() + interval '1 hour');
  EXCEPTION WHEN check_violation THEN _ok := true;
  END;
  IF NOT _ok THEN RAISE EXCEPTION 'PROOF FAILED [tables]: a raw token was stored as its hash'; END IF;

  INSERT INTO public.live_activity_actions (token_id, organization_id, user_id, visit_id, action)
  VALUES (_tok, '0a400000-0000-4000-8000-0000000000aa', 'a4000000-0000-4000-8000-00000000a001',
          '7a400000-0000-4000-8000-000000000002', 'start');
  _ok := false;
  BEGIN
    INSERT INTO public.live_activity_actions (token_id, organization_id, user_id, visit_id, action)
    VALUES (_tok, '0a400000-0000-4000-8000-0000000000aa', 'a4000000-0000-4000-8000-00000000a001',
            '7a400000-0000-4000-8000-000000000002', 'start');
  EXCEPTION WHEN unique_violation THEN _ok := true;
  END;
  IF NOT _ok THEN RAISE EXCEPTION 'PROOF FAILED [tables]: the same press was recorded twice'; END IF;

  _ok := false;
  BEGIN
    INSERT INTO public.live_activity_actions (token_id, organization_id, user_id, visit_id, action)
    VALUES (_tok, '0a400000-0000-4000-8000-0000000000aa', 'a4000000-0000-4000-8000-00000000a001',
            '7a400000-0000-4000-8000-000000000002', 'complete');
  EXCEPTION WHEN check_violation THEN _ok := true;
  END;
  IF NOT _ok THEN RAISE EXCEPTION 'PROOF FAILED [tables]: an action other than start was recorded'; END IF;
  RAISE NOTICE 'ok: tokens live at most 16 hours and are stored as hashes; a press is recorded once; only start';
END $$;
RESET ROLE;

ROLLBACK;
