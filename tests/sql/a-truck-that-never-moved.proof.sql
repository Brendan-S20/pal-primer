-- A truck that never moved: what 20261007160000 establishes, proved against a
-- real Postgres. Run by tests/a-truck-that-never-moved.test.ts, which passes
-- the migration's path as :migration.
--
-- One transaction, ROLLED BACK at the end, the migration included, so nothing
-- is left behind: no index, no function, no cron job, no row. Each group
-- prints "ok: ..." only when every check in it passed, or raises
-- "PROOF FAILED [...]"; ON_ERROR_STOP makes the first failure the exit code.
--
-- late_check_due() reads every visit in the database, and the database this
-- runs on is shared and has rows of its own. So every instant asked about is
-- in 2099, where nothing but this fixture can be.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :migration

-- ── Fixture ─────────────────────────────────────────────────────────────────
-- One organization, one tech, one customer. Each visit on its own day, so no
-- uniqueness on (subscription, day) can get in the way; the gate does not
-- read the day, only the window.

SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('a7000000-0000-4000-8000-00000000a001', 'owner@stuck.proof.invalid'),
  ('a7000000-0000-4000-8000-00000000a002', 'tech@stuck.proof.invalid');
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a700000-0000-4000-8000-0000000000aa', 'Stuck Truck Proof', 'America/Chicago');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a7000000-0000-4000-8000-00000000a001', '0a700000-0000-4000-8000-0000000000aa', 'owner'),
  ('a7000000-0000-4000-8000-00000000a002', '0a700000-0000-4000-8000-0000000000aa', 'tech');
INSERT INTO public.staff (id, organization_id, user_id, role, display_name) VALUES
  ('5e700000-0000-4000-8000-000000000002', '0a700000-0000-4000-8000-0000000000aa',
   'a7000000-0000-4000-8000-00000000a002', 'tech', 'Stuck Tech');
INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('c7000000-0000-4000-8000-0000000000a1', '0a700000-0000-4000-8000-0000000000aa', 'residential', 'Stuck Customer');
INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code) VALUES
  ('e7000000-0000-4000-8000-0000000000a1', '0a700000-0000-4000-8000-0000000000aa',
   'c7000000-0000-4000-8000-0000000000a1', '12 Elm St', 'Chicago', '60614');
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency, price_cents, dog_count) VALUES
  ('d7000000-0000-4000-8000-0000000000a1', '0a700000-0000-4000-8000-0000000000aa',
   'c7000000-0000-4000-8000-0000000000a1', 'e7000000-0000-4000-8000-0000000000a1', 'residential', 'weekly', 2500, 1);
SET LOCAL app.allow_protected_org_write = '';

-- Each visit: an id suffix, its day, its status, whether it is assigned, and
-- when its window closes.
CREATE FUNCTION pg_temp.visit(_n text, _day date, _status public.visit_status, _assigned boolean, _end timestamptz)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id,
                             assigned_staff_id, scheduled_on, status, eta_start, eta_end)
  VALUES (('f7000000-0000-4000-8000-0000000000' || _n)::uuid, '0a700000-0000-4000-8000-0000000000aa',
          'd7000000-0000-4000-8000-0000000000a1', 'c7000000-0000-4000-8000-0000000000a1',
          'e7000000-0000-4000-8000-0000000000a1',
          CASE WHEN _assigned THEN '5e700000-0000-4000-8000-000000000002'::uuid END,
          _day, _status, _end - interval '1 hour', _end)
$$;

-- ── Nothing near: no request ────────────────────────────────────────────────
-- A week of 2099 holds only visits that must NOT open the gate: canceled,
-- completed, skipped and unassigned, each with a window closing half an hour
-- after the instant asked about.

SELECT pg_temp.visit('b1', '2099-06-08', 'canceled', true, '2099-06-08 15:30:00+00');
SELECT pg_temp.visit('b2', '2099-06-09', 'completed', true, '2099-06-09 15:30:00+00');
SELECT pg_temp.visit('b3', '2099-06-10', 'skipped', true, '2099-06-10 15:30:00+00');
SELECT pg_temp.visit('b4', '2099-06-11', 'scheduled', false, '2099-06-11 15:30:00+00');

DO $$
DECLARE _d date;
BEGIN
  IF public.late_check_due('2099-06-01 15:00:00+00') THEN
    RAISE EXCEPTION 'PROOF FAILED [idle]: the gate is open with nothing in 2099';
  END IF;
  FOREACH _d IN ARRAY ARRAY['2099-06-08', '2099-06-09', '2099-06-10', '2099-06-11']::date[] LOOP
    IF public.late_check_due((_d + time '15:00')::timestamp AT TIME ZONE 'UTC') THEN
      RAISE EXCEPTION 'PROOF FAILED [not open]: the gate opened on % for a stop that is canceled, done, skipped or nobody''s', _d;
    END IF;
  END LOOP;
  RAISE NOTICE 'ok: no request when nothing is near, or when what is near is canceled, completed, skipped or unassigned';
END $$;

-- ── A window near: a request, inside exactly the band ───────────────────────
-- One open, assigned stop whose window closes at 15:00 on 2099-06-15. The gate
-- is open from 180 minutes before that to 120 minutes after it, and shut
-- either side: LATE_LOOKAHEAD_MIN and LATE_GIVE_UP_MIN.

SELECT pg_temp.visit('a1', '2099-06-15', 'scheduled', true, '2099-06-15 15:00:00+00');

DO $$
DECLARE _end timestamptz := '2099-06-15 15:00:00+00';
BEGIN
  IF NOT public.late_check_due(_end - interval '179 minutes') THEN
    RAISE EXCEPTION 'PROOF FAILED [band]: shut 179 minutes before a window closes';
  END IF;
  IF public.late_check_due(_end - interval '181 minutes') THEN
    RAISE EXCEPTION 'PROOF FAILED [band]: open 181 minutes before a window closes';
  END IF;
  IF NOT public.late_check_due(_end) OR NOT public.late_check_due(_end + interval '119 minutes') THEN
    RAISE EXCEPTION 'PROOF FAILED [band]: shut while a window is closing or just closed';
  END IF;
  IF public.late_check_due(_end + interval '121 minutes') THEN
    RAISE EXCEPTION 'PROOF FAILED [band]: open 121 minutes after a window closed';
  END IF;
  RAISE NOTICE 'ok: a near window opens the gate, from 180 minutes before it closes to 120 after';
END $$;

-- ── The index the band reads ────────────────────────────────────────────────

DO $$
DECLARE _def text;
BEGIN
  SELECT indexdef INTO _def FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'idx_visits_open_window_end';
  IF _def IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [index]: idx_visits_open_window_end is missing';
  END IF;
  IF _def NOT LIKE '%(eta_end)%' OR _def NOT LIKE '%scheduled%'
     OR _def NOT LIKE '%assigned_staff_id IS NOT NULL%' THEN
    RAISE EXCEPTION 'PROOF FAILED [index]: not the partial index on open, assigned windows: %', _def;
  END IF;
  RAISE NOTICE 'ok: the band is read from a partial index on open, assigned windows';
END $$;

-- ── Who may ask ─────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.late_check_due(timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.late_check_due(timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PROOF FAILED [grants]: anon or authenticated can ask whether any truck is near a window';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.late_check_due(timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PROOF FAILED [grants]: service_role cannot ask';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.late_check_due(timestamptz)'::regprocedure) THEN
    RAISE EXCEPTION 'PROOF FAILED [grants]: late_check_due runs as its owner';
  END IF;
  RAISE NOTICE 'ok: only the service role and the cron job''s owner can ask, and it runs as its caller';
END $$;

SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.late_check_due('2099-06-15 15:00:00+00');
    RAISE EXCEPTION 'PROOF FAILED [grants]: a signed-in user called late_check_due';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok: a signed-in user who calls it is refused';
END $$;
RESET ROLE;

-- ── The schedule ────────────────────────────────────────────────────────────

DO $$
DECLARE _cmd text; _sched text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    SELECT command, schedule INTO _cmd, _sched FROM cron.job WHERE jobname = 'late-check' AND active;
    IF _cmd IS NULL THEN
      RAISE EXCEPTION 'PROOF FAILED [cron]: late-check is not scheduled';
    END IF;
    IF _sched <> '*/5 * * * *'
       OR _cmd NOT LIKE '%https://app.houndstack.com/api/public/hooks/late-check%'
       OR _cmd NOT LIKE '%cron_service_role_key%'
       OR _cmd NOT LIKE '%public.late_check_due()%' THEN
      RAISE EXCEPTION 'PROOF FAILED [cron]: late-check is not the five-minute, gated, Vault-authorized job: % %', _sched, _cmd;
    END IF;
    IF (SELECT count(*) FROM cron.job WHERE jobname = 'late-check') <> 1 THEN
      RAISE EXCEPTION 'PROOF FAILED [cron]: more than one late-check job';
    END IF;
    RAISE NOTICE 'ok: late-check runs every five minutes, gated, with the Vault credential';
  ELSE
    RAISE WARNING 'pg_cron is not installed here, so the schedule was not checked';
    RAISE NOTICE 'ok: late-check runs every five minutes, gated, with the Vault credential (not checked: no pg_cron)';
  END IF;
END $$;

ROLLBACK;

DO $$ BEGIN RAISE NOTICE 'ALL LATE-CHECK PROOFS PASSED'; END $$;
