-- A plan does not backfill the days before it existed (#631), proved in a
-- real Postgres. Run by tests/a-plan-does-not-backfill-before-it-existed.test.ts
-- with :migration (20261031120000).
--
-- One business, one client, plans of every older cadence that started 30
-- days ago but were entered today, one entered back when it started, and one
-- that starts next week. The generator runs once BEFORE the migration (where
-- the stack is still before it) and once after, and the two are compared.
--
-- Everything happens inside one transaction that is ROLLED BACK at the end,
-- the migration included. Each group prints "ok: ..." only when every check
-- in it passed, or raises "PROOF FAILED [...]". Days are relative to the
-- org's own today (America/Chicago), so this passes on any date.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

-- The seed group replaces nothing, but it seeds, and the other seed proofs
-- queue on this lock; take it too so two seeds never cross.
SELECT pg_advisory_xact_lock(hashtext('houndstack.proof.seed_demo_org'));

-- ── Fixture ───────────────────────────────────────────────────────────────
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO public.organizations (id, name, timezone, work_days) VALUES
  ('06310000-0000-4000-8000-0000000000aa', 'Backfill Proof', 'America/Chicago', '{1,2,3,4,5}');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('c6310000-0000-4000-8000-0000000000a0', '06310000-0000-4000-8000-0000000000aa', 'residential', 'Backfill Proof Client');
INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code, latitude, longitude) VALUES
  ('e6310000-0000-4000-8000-0000000000a0', '06310000-0000-4000-8000-0000000000aa',
   'c6310000-0000-4000-8000-0000000000a0', '31 Backfill Ln', 'Chicago', '60614', 41.92, -87.65);

CREATE TEMP TABLE proof_day ON COMMIT DROP AS
  SELECT (now() AT TIME ZONE 'America/Chicago')::date AS today;

-- a1..a7: started 30 days ago, entered today (created_at defaults to now()).
-- b1:     started 30 days ago, entered on that day.
-- f1:     starts in 3 days, entered today.
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency,
                                  price_cents, dog_count, started_on, preferred_weekdays, interval_days)
SELECT x.id::uuid, '06310000-0000-4000-8000-0000000000aa', 'c6310000-0000-4000-8000-0000000000a0',
       'e6310000-0000-4000-8000-0000000000a0', 'residential', x.freq::service_frequency,
       2500, 1, p.today + x.start_offs, x.prefs::int[], x.ndays
  FROM proof_day p, (VALUES
    ('d6310000-0000-4000-8000-0000000000a1', 'weekly',       -30, NULL,    NULL),
    ('d6310000-0000-4000-8000-0000000000a2', 'weekly',       -30, '{4}',   NULL),
    ('d6310000-0000-4000-8000-0000000000a3', 'biweekly',     -30, NULL,    NULL),
    ('d6310000-0000-4000-8000-0000000000a4', 'twice_weekly', -30, '{1,4}', NULL),
    ('d6310000-0000-4000-8000-0000000000a5', 'monthly',      -30, NULL,    NULL),
    ('d6310000-0000-4000-8000-0000000000a6', 'every_n_days', -30, NULL,    3),
    ('d6310000-0000-4000-8000-0000000000a7', 'one_time',     -30, NULL,    NULL),
    ('d6310000-0000-4000-8000-0000000000b1', 'weekly',       -30, NULL,    NULL),
    ('d6310000-0000-4000-8000-0000000000f1', 'weekly',         3, NULL,    NULL)
  ) AS x(id, freq, start_offs, prefs, ndays);

UPDATE public.subscriptions
   SET created_at = ((SELECT today FROM proof_day) - 30 + time '08:00') AT TIME ZONE 'America/Chicago'
 WHERE id = 'd6310000-0000-4000-8000-0000000000b1';

-- What the generator made BEFORE this migration, where this stack is still
-- before it. On a stack that already has it there is nothing to compare
-- against, and group 2 says so rather than passing quietly.
CREATE TEMP TABLE before_gen (subscription_id uuid, scheduled_on date) ON COMMIT DROP;
SELECT NOT EXISTS (
  SELECT 1 FROM pg_proc
   WHERE oid = 'public.generate_visits_core(uuid, date, uuid)'::regprocedure
     AND prosrc LIKE '%_floor := %'
) AS can_compare \gset
\if :can_compare
SELECT public.generate_visits_core('06310000-0000-4000-8000-0000000000aa', today + 42, NULL)
  FROM proof_day \gset before_
INSERT INTO before_gen
SELECT subscription_id, scheduled_on FROM public.visits
 WHERE organization_id = '06310000-0000-4000-8000-0000000000aa';
DELETE FROM public.visits WHERE organization_id = '06310000-0000-4000-8000-0000000000aa';
\endif

\i :migration

-- c1: a plan entered today with a start 30 days ago, carrying a Missed visit
-- already on the books from before this change. It must survive the
-- generator untouched. Kept on its own plan so it does not move the chains
-- group 2 compares.
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency,
                                  price_cents, dog_count, started_on)
SELECT 'd6310000-0000-4000-8000-0000000000c1', '06310000-0000-4000-8000-0000000000aa',
       'c6310000-0000-4000-8000-0000000000a0', 'e6310000-0000-4000-8000-0000000000a0',
       'residential', 'weekly', 2500, 1, today - 30
  FROM proof_day;
INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id, scheduled_on, status)
SELECT 'a6310000-0000-4000-8000-0000000000a1', '06310000-0000-4000-8000-0000000000aa',
       'd6310000-0000-4000-8000-0000000000c1', 'c6310000-0000-4000-8000-0000000000a0',
       'e6310000-0000-4000-8000-0000000000a0', today - 9, 'missed'
  FROM proof_day;

DO $$
DECLARE _today date := (SELECT today FROM proof_day);
BEGIN
  PERFORM public.generate_visits_core('06310000-0000-4000-8000-0000000000aa', _today + 42, NULL);
END $$;

-- ── 1. A late started_on does not backfill the days before the plan ──────
DO $$
DECLARE _today date := (SELECT today FROM proof_day); _n int; _empty text;
BEGIN
  SELECT count(*) INTO _n FROM public.visits
   WHERE organization_id = '06310000-0000-4000-8000-0000000000aa'
     AND (subscription_id::text LIKE 'd6310000-0000-4000-8000-0000000000a%'
          OR subscription_id = 'd6310000-0000-4000-8000-0000000000c1')
     AND scheduled_on < _today
     AND id <> 'a6310000-0000-4000-8000-0000000000a1';
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [late start]: % visit(s) generated before the day the plan was entered', _n;
  END IF;

  -- Every recurring cadence still has its visits from today on.
  SELECT string_agg(s.frequency::text, ', ') INTO _empty
    FROM public.subscriptions s
   WHERE s.id IN ('d6310000-0000-4000-8000-0000000000a1', 'd6310000-0000-4000-8000-0000000000a2',
                  'd6310000-0000-4000-8000-0000000000a3', 'd6310000-0000-4000-8000-0000000000a4',
                  'd6310000-0000-4000-8000-0000000000a5', 'd6310000-0000-4000-8000-0000000000a6')
     AND NOT EXISTS (SELECT 1 FROM public.visits v
                      WHERE v.subscription_id = s.id AND v.scheduled_on >= _today);
  IF _empty IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [late start]: no visit from today on for: %', _empty;
  END IF;

  -- A one-time plan whose day had passed before it was entered gets nothing.
  IF EXISTS (SELECT 1 FROM public.visits WHERE subscription_id = 'd6310000-0000-4000-8000-0000000000a7') THEN
    RAISE EXCEPTION 'PROOF FAILED [late start]: a one-time plan entered after its day generated a visit';
  END IF;
  RAISE NOTICE 'ok: plans entered today with a start 30 days ago generate nothing before today, of every older cadence';
END $$;

-- ── 2. Every date on or after the plan existed is the date it was ────────
DO $$
DECLARE _today date := (SELECT today FROM proof_day); _n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM before_gen) THEN
    RAISE WARNING 'unchanged: this stack already has the floor, so the before/after comparison did NOT run';
    RAISE NOTICE 'ok: comparison skipped (see warning)';
    RETURN;
  END IF;

  SELECT count(*) INTO _n FROM (
    (SELECT v.subscription_id, v.scheduled_on FROM public.visits v
      WHERE v.organization_id = '06310000-0000-4000-8000-0000000000aa'
        AND v.subscription_id <> 'd6310000-0000-4000-8000-0000000000c1'
     EXCEPT
     SELECT b.subscription_id, b.scheduled_on FROM before_gen b)
    UNION ALL
    (SELECT b.subscription_id, b.scheduled_on FROM before_gen b
      JOIN public.subscriptions s ON s.id = b.subscription_id
      WHERE b.scheduled_on >= (s.created_at AT TIME ZONE 'America/Chicago')::date
     EXCEPT
     SELECT v.subscription_id, v.scheduled_on FROM public.visits v
      WHERE v.organization_id = '06310000-0000-4000-8000-0000000000aa')
  ) d;
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [unchanged]: % visit(s) on or after a plan''s created day differ from what the generator made before', _n;
  END IF;

  -- And the before set did reach back, or this comparison proved nothing.
  IF NOT EXISTS (SELECT 1 FROM before_gen
                  WHERE subscription_id::text LIKE 'd6310000-0000-4000-8000-0000000000a%'
                    AND scheduled_on < _today) THEN
    RAISE EXCEPTION 'PROOF FAILED [unchanged]: the generator before this change did not backfill, so nothing was compared';
  END IF;
  RAISE NOTICE 'ok: every date on or after a plan''s created day is generated exactly as before';
END $$;

-- ── 3. Forward generation still works ───────────────────────────────────
DO $$
DECLARE _today date := (SELECT today FROM proof_day); _first date; _past int;
BEGIN
  SELECT min(scheduled_on) INTO _first FROM public.visits
   WHERE subscription_id = 'd6310000-0000-4000-8000-0000000000f1';
  IF _first IS NULL OR _first < _today + 3 THEN
    RAISE EXCEPTION 'PROOF FAILED [forward]: the plan starting in 3 days begins on %', _first;
  END IF;

  -- A plan entered on the day it started still has its whole history.
  SELECT count(*) INTO _past FROM public.visits
   WHERE subscription_id = 'd6310000-0000-4000-8000-0000000000b1' AND scheduled_on < _today;
  IF _past < 4 THEN
    RAISE EXCEPTION 'PROOF FAILED [forward]: a plan that existed 30 days ago has % past visit(s), expected at least 4', _past;
  END IF;
  RAISE NOTICE 'ok: a future plan and a plan that existed since its start both generate as before';
END $$;

-- ── 4. A visit already on the books is left alone ───────────────────────
DO $$
DECLARE _today date := (SELECT today FROM proof_day); _v record;
BEGIN
  SELECT status::text AS status, scheduled_on INTO _v
    FROM public.visits WHERE id = 'a6310000-0000-4000-8000-0000000000a1';
  IF NOT FOUND OR _v.status <> 'missed' OR _v.scheduled_on <> _today - 9 THEN
    RAISE EXCEPTION 'PROOF FAILED [existing]: the existing Missed visit was changed or removed (%)', _v;
  END IF;
  RAISE NOTICE 'ok: an existing Missed visit before the plan''s created day is untouched';
END $$;

-- ── 5. The demo seed still builds its history ───────────────────────────
INSERT INTO auth.users (id, email) VALUES
  ('a0000000-0000-4000-8000-00000000b631', 'owner@backfill.proof.invalid');
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a000000-0000-4000-8000-0000000000b6', 'Backfill Seed Proof', 'America/Chicago');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a0000000-0000-4000-8000-00000000b631', '0a000000-0000-4000-8000-0000000000b6', 'owner');
SET LOCAL app.allow_protected_org_write = '';
INSERT INTO public.staff (organization_id, user_id, display_name, role, active,
                          is_field_tech, is_field_tech_overridden)
VALUES ('0a000000-0000-4000-8000-0000000000b6', 'a0000000-0000-4000-8000-00000000b631',
        'Owner Operator', 'owner', true, true, true);

SELECT set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-00000000b631","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT public.seed_demo_org('0a000000-0000-4000-8000-0000000000b6') IS NOT NULL AS seeded \gset
RESET ROLE;

DO $$
DECLARE _today date := (now() AT TIME ZONE 'America/Chicago')::date;
  _past int; _done int; _missed int; _future int; _early int;
BEGIN
  SELECT count(*) FILTER (WHERE scheduled_on < _today),
         count(*) FILTER (WHERE scheduled_on < _today AND status = 'completed'),
         count(*) FILTER (WHERE scheduled_on < _today AND status = 'missed'),
         count(*) FILTER (WHERE scheduled_on >= _today)
    INTO _past, _done, _missed, _future
    FROM public.visits WHERE organization_id = '0a000000-0000-4000-8000-0000000000b6';
  IF _past < 40 OR _done = 0 OR _missed = 0 OR _future = 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [seed]: % past visits (% completed, % missed), % from today on',
      _past, _done, _missed, _future;
  END IF;

  -- Every seeded plan existed by its first visit: the history comes from
  -- the plans' own dates, not from a backfill.
  SELECT count(*) INTO _early
    FROM public.visits v JOIN public.subscriptions s ON s.id = v.subscription_id
   WHERE v.organization_id = '0a000000-0000-4000-8000-0000000000b6'
     AND v.scheduled_on < (s.created_at AT TIME ZONE 'America/Chicago')::date;
  IF _early <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [seed]: % seeded visit(s) fall before their plan existed', _early;
  END IF;
  RAISE NOTICE 'ok: the demo seed builds its history (% past, % completed, % missed) from plans dated from their start', _past, _done, _missed;
END $$;

DO $$ BEGIN RAISE NOTICE 'ALL BACKFILL PROOFS PASSED'; END $$;

ROLLBACK;
