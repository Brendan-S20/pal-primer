-- Five walks a week (the service catalog, phase 3: weekday cadence), proved
-- against a real Postgres rather than read off the migration's text. Run by
-- tests/five-walks-a-week-in-a-real-database.test.ts, which passes
--   :lines      20261008120000_a-dog-walker-should-not-have-to-learn-about-dump-sites.sql
--   :p1         20261009200000_a-walk-is-not-a-cleanup.sql (the catalog itself)
--   :p2         20261009230000_a-visit-knows-its-service.sql
--   :durations  20261009230100_a-walk-takes-as-long-as-the-walk.sql
--   :migration  20261010010000_five-walks-a-week.sql
-- The first four are applied only when the database does not have them yet:
-- the shared stack CI runs proofs against follows main, which may have none
-- of them (#358, #381, #384).
--
-- Everything happens inside one transaction that is ROLLED BACK at the end,
-- the migrations included. Each group prints "ok: ..." only when every check
-- in it passed, or raises "PROOF FAILED [...]", and ON_ERROR_STOP turns the
-- first failure into a non-zero exit.
--
-- Days are relative to the org's own today (America/Chicago), never
-- hard-coded, so this passes on any date. M is next week's Monday.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

-- The bases, in order, inside this same rolled-back transaction, each only
-- where the stack was built before it: organizations.service_lines (#358),
-- public.services (#381), then service_id on plans and visits (#384).
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
SELECT NOT EXISTS (
  SELECT 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'visits' AND column_name = 'service_id'
) AS need_service_ids \gset
\if :need_service_ids
\i :p2
\i :durations
\endif

-- ── Fixture ───────────────────────────────────────────────────────────────
-- One business that scoops and walks, open Monday to Friday. Client L has
-- six pet-waste plans of every older cadence; W1, W2 and W3 are walked.
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO public.organizations (id, name, timezone, work_days, service_lines) VALUES
  ('05300000-0000-4000-8000-0000000000aa', 'Five Walks Proof A', 'America/Chicago',
   '{1,2,3,4,5}', '{pet_waste,dog_walking}');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('c5300000-0000-4000-8000-0000000000a0', '05300000-0000-4000-8000-0000000000aa', 'residential', 'Five Walks Client L'),
  ('c5300000-0000-4000-8000-0000000000a1', '05300000-0000-4000-8000-0000000000aa', 'residential', 'Five Walks Client W1'),
  ('c5300000-0000-4000-8000-0000000000a2', '05300000-0000-4000-8000-0000000000aa', 'residential', 'Five Walks Client W2'),
  ('c5300000-0000-4000-8000-0000000000a3', '05300000-0000-4000-8000-0000000000aa', 'residential', 'Five Walks Client W3');

INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code, latitude, longitude) VALUES
  ('e5300000-0000-4000-8000-0000000000a0', '05300000-0000-4000-8000-0000000000aa',
   'c5300000-0000-4000-8000-0000000000a0', '10 Legacy Ln', 'Chicago', '60614', 41.92, -87.65),
  ('e5300000-0000-4000-8000-0000000000a1', '05300000-0000-4000-8000-0000000000aa',
   'c5300000-0000-4000-8000-0000000000a1', '11 Walk St', 'Chicago', '60614', 41.93, -87.66),
  ('e5300000-0000-4000-8000-0000000000a2', '05300000-0000-4000-8000-0000000000aa',
   'c5300000-0000-4000-8000-0000000000a2', '12 Walk St', 'Chicago', '60614', 41.94, -87.67),
  ('e5300000-0000-4000-8000-0000000000a3', '05300000-0000-4000-8000-0000000000aa',
   'c5300000-0000-4000-8000-0000000000a3', '13 Walk St', 'Chicago', '60614', 41.95, -87.68);

INSERT INTO public.services (id, organization_id, name, service_line, price_unit, base_price_cents, default_duration_min, active)
VALUES ('55300000-0000-4000-8000-0000000000a1', '05300000-0000-4000-8000-0000000000aa',
        '30-minute walk', 'dog_walking', 'visit', 2500, 30, true);

CREATE TEMP TABLE proof_day ON COMMIT DROP AS
  SELECT (now() AT TIME ZONE 'America/Chicago')::date AS today,
         date_trunc('week', (now() AT TIME ZONE 'America/Chicago')::date + 7)::date AS m;

-- Next week's Monday + 7 is closed.
INSERT INTO public.blackout_dates (organization_id, blackout_on, reason)
SELECT '05300000-0000-4000-8000-0000000000aa', m + 7, 'Five walks proof' FROM proof_day;

-- The older cadences, one plan each, all starting on M.
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency,
                                  price_cents, dog_count, started_on, preferred_weekdays, interval_days)
SELECT x.id::uuid, '05300000-0000-4000-8000-0000000000aa', 'c5300000-0000-4000-8000-0000000000a0',
       'e5300000-0000-4000-8000-0000000000a0', 'residential', x.freq::service_frequency,
       2500, 1, p.m + x.start_offs, x.prefs::int[], x.ndays
  FROM proof_day p, (VALUES
    ('d5300000-0000-4000-8000-0000000000a1', 'weekly',       0, NULL,    NULL),
    ('d5300000-0000-4000-8000-0000000000a2', 'weekly',       0, '{4}',   NULL),
    ('d5300000-0000-4000-8000-0000000000a3', 'biweekly',     0, NULL,    NULL),
    ('d5300000-0000-4000-8000-0000000000a4', 'twice_weekly', 0, '{1,4}', NULL),
    ('d5300000-0000-4000-8000-0000000000a5', 'monthly',      0, NULL,    NULL),
    ('d5300000-0000-4000-8000-0000000000a6', 'every_n_days', 0, NULL,    3),
    ('d5300000-0000-4000-8000-0000000000a7', 'one_time',     7, NULL,    NULL)
  ) AS x(id, freq, start_offs, prefs, ndays);

-- What the generator made of them BEFORE this migration, where this stack is
-- still before it. On a stack that already has it there is nothing to compare
-- against, and the group below says so rather than passing quietly.
CREATE TEMP TABLE before_gen (subscription_id uuid, scheduled_on date) ON COMMIT DROP;
SELECT NOT EXISTS (
  SELECT 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'subscriptions' AND column_name = 'weekdays'
) AS can_compare \gset
\if :can_compare
SELECT public.generate_visits_core('05300000-0000-4000-8000-0000000000aa', m + 42, NULL) FROM proof_day \gset before_
INSERT INTO before_gen
SELECT subscription_id, scheduled_on FROM public.visits
 WHERE organization_id = '05300000-0000-4000-8000-0000000000aa';
DELETE FROM public.visits WHERE organization_id = '05300000-0000-4000-8000-0000000000aa';
\endif

\i :migration

-- ── 1. Every older cadence generates exactly what it did ──────────────────
DO $$
DECLARE
  _m date := (SELECT m FROM proof_day);
  _pw uuid := (SELECT id FROM public.services
                WHERE organization_id = '05300000-0000-4000-8000-0000000000aa'
                  AND service_line = 'pet_waste');
  _got int[];
  _n integer;
BEGIN
  PERFORM public.generate_visits_core('05300000-0000-4000-8000-0000000000aa', _m + 42, NULL);

  IF EXISTS (SELECT 1 FROM before_gen) THEN
    SELECT count(*) INTO _n FROM (
      (SELECT subscription_id, scheduled_on FROM public.visits
        WHERE organization_id = '05300000-0000-4000-8000-0000000000aa'
       EXCEPT SELECT subscription_id, scheduled_on FROM before_gen)
      UNION ALL
      (SELECT subscription_id, scheduled_on FROM before_gen
       EXCEPT SELECT subscription_id, scheduled_on FROM public.visits
               WHERE organization_id = '05300000-0000-4000-8000-0000000000aa')
    ) d;
    IF _n <> 0 OR NOT EXISTS (SELECT 1 FROM before_gen) THEN
      RAISE EXCEPTION 'PROOF FAILED [unchanged]: % visit(s) of the older cadences differ from what the generator made before this migration', _n;
    END IF;
  ELSE
    RAISE WARNING 'unchanged: this stack already has weekday sets, so the before/after comparison did NOT run; only the weekly plan''s exact dates were checked';
  END IF;

  -- And independent of any comparison: the weekly plan, by hand. M is a
  -- Monday; M+7 is a blackout, so that visit moves to the next work day and
  -- the series chains on from it, as it always has.
  SELECT array_agg(scheduled_on - _m ORDER BY scheduled_on) INTO _got
    FROM public.visits WHERE subscription_id = 'd5300000-0000-4000-8000-0000000000a1';
  IF _got IS DISTINCT FROM ARRAY[0, 8, 15, 22, 29, 36] THEN
    RAISE EXCEPTION 'PROOF FAILED [unchanged]: the weekly plan generated day offsets %, not {0,8,15,22,29,36}', _got;
  END IF;

  IF EXISTS (SELECT 1 FROM public.subscriptions
              WHERE organization_id = '05300000-0000-4000-8000-0000000000aa' AND weekdays IS NOT NULL) THEN
    RAISE EXCEPTION 'PROOF FAILED [unchanged]: an existing plan was given a weekday set';
  END IF;
  SELECT count(*) INTO _n FROM public.visits
   WHERE organization_id = '05300000-0000-4000-8000-0000000000aa' AND service_id IS DISTINCT FROM _pw;
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [unchanged]: % pet-waste visit(s) do not carry the pet-waste service', _n;
  END IF;
  RAISE NOTICE 'ok: weekly, a preferred day, biweekly, twice weekly, monthly, every 3 days and one time generate exactly as before';
END $$;

-- ── 2. Monday to Friday is five walks a week, each a walk ─────────────────
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency,
                                  price_cents, dog_count, started_on, weekdays, service_id)
SELECT 'd5300000-0000-4000-8000-0000000000b1', '05300000-0000-4000-8000-0000000000aa',
       'c5300000-0000-4000-8000-0000000000a1', 'e5300000-0000-4000-8000-0000000000a1',
       'residential', 'weekly', 2500, 1, m, '{1,2,3,4,5}', '55300000-0000-4000-8000-0000000000a1'
  FROM proof_day;

DO $$
DECLARE
  _m date := (SELECT m FROM proof_day);
  _made integer;
  _wk integer;
  _n integer;
BEGIN
  _made := public.generate_visits_core('05300000-0000-4000-8000-0000000000aa', _m + 20,
                                       'd5300000-0000-4000-8000-0000000000b1');
  FOR _wk IN 0..2 LOOP
    SELECT count(*) INTO _n FROM public.visits
     WHERE subscription_id = 'd5300000-0000-4000-8000-0000000000b1'
       AND scheduled_on BETWEEN _m + 7 * _wk AND _m + 7 * _wk + 6;
    -- Week 2's Monday is the blackout (group 3).
    IF _n <> (CASE _wk WHEN 1 THEN 4 ELSE 5 END) THEN
      RAISE EXCEPTION 'PROOF FAILED [mon-fri]: week % has % walks', _wk + 1, _n;
    END IF;
  END LOOP;
  IF _made <> 14 THEN
    RAISE EXCEPTION 'PROOF FAILED [mon-fri]: the generator reported % inserted, not 14', _made;
  END IF;
  SELECT count(*) INTO _n FROM public.visits
   WHERE subscription_id = 'd5300000-0000-4000-8000-0000000000b1'
     AND EXTRACT(ISODOW FROM scheduled_on) NOT BETWEEN 1 AND 5;
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [mon-fri]: % walk(s) landed on a weekend', _n;
  END IF;
  SELECT count(*) INTO _n FROM public.visits
   WHERE subscription_id = 'd5300000-0000-4000-8000-0000000000b1'
     AND service_id IS DISTINCT FROM '55300000-0000-4000-8000-0000000000a1';
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [mon-fri]: % visit(s) do not carry the plan''s walk service', _n;
  END IF;
  RAISE NOTICE 'ok: a Monday-to-Friday plan generates five walks a week, none on a weekend, each the plan''s walk';
END $$;

-- ── 3. Generating again makes nothing new ─────────────────────────────────
DO $$
DECLARE
  _m date := (SELECT m FROM proof_day);
  _made integer;
  _n integer;
  _distinct integer;
BEGIN
  _made := public.generate_visits_core('05300000-0000-4000-8000-0000000000aa', _m + 20,
                                       'd5300000-0000-4000-8000-0000000000b1')
         + public.generate_visits_core('05300000-0000-4000-8000-0000000000aa', _m + 20, NULL);
  SELECT count(*), count(DISTINCT scheduled_on) INTO _n, _distinct FROM public.visits
   WHERE subscription_id = 'd5300000-0000-4000-8000-0000000000b1';
  IF _made <> 0 OR _n <> 14 OR _distinct <> 14 THEN
    RAISE EXCEPTION 'PROOF FAILED [idempotent]: a second run inserted %, leaving % walks on % days', _made, _n, _distinct;
  END IF;
  RAISE NOTICE 'ok: running generation again creates no duplicates';
END $$;

-- ── 4. A blackout and a client hold are skipped, not shifted ──────────────
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency,
                                  price_cents, dog_count, started_on, weekdays, service_id)
SELECT 'd5300000-0000-4000-8000-0000000000b2', '05300000-0000-4000-8000-0000000000aa',
       'c5300000-0000-4000-8000-0000000000a2', 'e5300000-0000-4000-8000-0000000000a2',
       'residential', 'weekly', 2500, 1, m, '{1,3,5}', '55300000-0000-4000-8000-0000000000a1'
  FROM proof_day;
-- W2 is away on M+2, a Wednesday.
INSERT INTO public.client_holds (organization_id, client_id, starts_on, ends_on, reason)
SELECT '05300000-0000-4000-8000-0000000000aa', 'c5300000-0000-4000-8000-0000000000a2', m + 2, m + 2, 'Five walks proof'
  FROM proof_day;

DO $$
DECLARE
  _m date := (SELECT m FROM proof_day);
  _got int[];
BEGIN
  IF EXISTS (SELECT 1 FROM public.visits
              WHERE subscription_id = 'd5300000-0000-4000-8000-0000000000b1' AND scheduled_on = _m + 7)
     OR (SELECT count(*) FROM public.visits
          WHERE subscription_id = 'd5300000-0000-4000-8000-0000000000b1' AND scheduled_on = _m + 8) <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [skips]: the blackout Monday has a walk, or Tuesday does not have exactly one';
  END IF;

  PERFORM public.generate_visits_core('05300000-0000-4000-8000-0000000000aa', _m + 13,
                                      'd5300000-0000-4000-8000-0000000000b2');
  SELECT array_agg(scheduled_on - _m ORDER BY scheduled_on) INTO _got
    FROM public.visits WHERE subscription_id = 'd5300000-0000-4000-8000-0000000000b2';
  -- Mon, (Wed held), Fri; (Mon blacked out), Wed, Fri.
  IF _got IS DISTINCT FROM ARRAY[0, 4, 9, 11] THEN
    RAISE EXCEPTION 'PROOF FAILED [skips]: Mon/Wed/Fri with a hold and a blackout generated day offsets %, not {0,4,9,11}', _got;
  END IF;
  RAISE NOTICE 'ok: a blackout day and a client hold are skipped, and nothing moves onto another day';
END $$;

-- ── 5. A weekday plan never generates in the past ─────────────────────────
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency,
                                  price_cents, dog_count, started_on, weekdays, service_id)
SELECT 'd5300000-0000-4000-8000-0000000000b3', '05300000-0000-4000-8000-0000000000aa',
       'c5300000-0000-4000-8000-0000000000a3', 'e5300000-0000-4000-8000-0000000000a3',
       'residential', 'weekly', 2500, 1, today - 10, '{0,1,2,3,4,5,6}', '55300000-0000-4000-8000-0000000000a1'
  FROM proof_day;

DO $$
DECLARE
  _today date := (SELECT today FROM proof_day);
  _got int[];
BEGIN
  PERFORM public.generate_visits_core('05300000-0000-4000-8000-0000000000aa', _today + 2,
                                      'd5300000-0000-4000-8000-0000000000b3');
  SELECT array_agg(scheduled_on - _today ORDER BY scheduled_on) INTO _got
    FROM public.visits WHERE subscription_id = 'd5300000-0000-4000-8000-0000000000b3';
  IF _got IS DISTINCT FROM ARRAY[0, 1, 2] THEN
    RAISE EXCEPTION 'PROOF FAILED [today]: a daily plan that started ten days ago generated day offsets % from the business''s today, not {0,1,2}', _got;
  END IF;
  RAISE NOTICE 'ok: a plan entered with a past start walks from the business''s today, not from its start';
END $$;

-- ── 6. A walk moved to another day does not grow back ─────────────────────
DO $$
DECLARE
  _m date := (SELECT m FROM proof_day);
  _n integer;
BEGIN
  UPDATE public.visits SET scheduled_on = _m + 5, rescheduled_from = _m + 1
   WHERE subscription_id = 'd5300000-0000-4000-8000-0000000000b1' AND scheduled_on = _m + 1;
  PERFORM public.generate_visits_core('05300000-0000-4000-8000-0000000000aa', _m + 20,
                                      'd5300000-0000-4000-8000-0000000000b1');
  IF EXISTS (SELECT 1 FROM public.visits
              WHERE subscription_id = 'd5300000-0000-4000-8000-0000000000b1' AND scheduled_on = _m + 1) THEN
    RAISE EXCEPTION 'PROOF FAILED [moved]: the Tuesday a walk was moved away from was generated again';
  END IF;
  SELECT count(*) INTO _n FROM public.visits WHERE subscription_id = 'd5300000-0000-4000-8000-0000000000b1';
  IF _n <> 14 THEN
    RAISE EXCEPTION 'PROOF FAILED [moved]: moving a walk left % walks, not 14', _n;
  END IF;
  RAISE NOTICE 'ok: a walk rescheduled to another day is not generated again on its old day';
END $$;

-- ── 7. Changing the days reshapes what has not happened yet ───────────────
DO $$
DECLARE
  _m date := (SELECT m FROM proof_day);
  _monday uuid;
  _n integer;
BEGIN
  SELECT id INTO _monday FROM public.visits
   WHERE subscription_id = 'd5300000-0000-4000-8000-0000000000b1' AND scheduled_on = _m;

  -- Mon-Fri to Mon/Wed/Fri: Tuesdays, Thursdays and the moved Saturday go;
  -- the days that stay keep their visit (and so its route and tech).
  UPDATE public.subscriptions SET weekdays = '{1,3,5}' WHERE id = 'd5300000-0000-4000-8000-0000000000b1';
  IF EXISTS (SELECT 1 FROM public.visits
              WHERE subscription_id = 'd5300000-0000-4000-8000-0000000000b1'
                AND EXTRACT(DOW FROM scheduled_on)::int NOT IN (1, 3, 5)) THEN
    RAISE EXCEPTION 'PROOF FAILED [reshape]: a walk is left on a day the plan no longer runs';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.visits WHERE id = _monday) THEN
    RAISE EXCEPTION 'PROOF FAILED [reshape]: the Monday walk was deleted although Monday stayed';
  END IF;
  PERFORM public.generate_visits_core('05300000-0000-4000-8000-0000000000aa', _m + 20,
                                      'd5300000-0000-4000-8000-0000000000b1');
  SELECT count(*) INTO _n FROM public.visits WHERE subscription_id = 'd5300000-0000-4000-8000-0000000000b1';
  IF _n <> 8 THEN
    RAISE EXCEPTION 'PROOF FAILED [reshape]: Mon/Wed/Fri over three weeks with one blackout Monday is 8 walks, got %', _n;
  END IF;

  -- And back: the added days appear on the next run, not after the horizon.
  UPDATE public.subscriptions SET weekdays = '{1,2,3,4,5}' WHERE id = 'd5300000-0000-4000-8000-0000000000b1';
  PERFORM public.generate_visits_core('05300000-0000-4000-8000-0000000000aa', _m + 20,
                                      'd5300000-0000-4000-8000-0000000000b1');
  SELECT count(*) INTO _n FROM public.visits WHERE subscription_id = 'd5300000-0000-4000-8000-0000000000b1';
  IF _n <> 14 THEN
    RAISE EXCEPTION 'PROOF FAILED [reshape]: going back to Mon-Fri gave % walks, not 14', _n;
  END IF;

  -- Clearing the set hands the plan back to its frequency: weekly from M.
  UPDATE public.subscriptions SET weekdays = NULL WHERE id = 'd5300000-0000-4000-8000-0000000000b1';
  PERFORM public.generate_visits_core('05300000-0000-4000-8000-0000000000aa', _m + 20,
                                      'd5300000-0000-4000-8000-0000000000b1');
  SELECT count(*) INTO _n FROM public.visits WHERE subscription_id = 'd5300000-0000-4000-8000-0000000000b1';
  IF _n <> 3 THEN
    RAISE EXCEPTION 'PROOF FAILED [reshape]: a cleared set should be weekly again (3 visits), got %', _n;
  END IF;
  UPDATE public.subscriptions SET weekdays = '{1,2,3,4,5}' WHERE id = 'd5300000-0000-4000-8000-0000000000b1';
  PERFORM public.generate_visits_core('05300000-0000-4000-8000-0000000000aa', _m + 20,
                                      'd5300000-0000-4000-8000-0000000000b1');
  RAISE NOTICE 'ok: changing the days removes upcoming walks only on days that went, and adds new days at once';
END $$;

-- ── 8. The set's rules ─────────────────────────────────────────────────────
DO $$
DECLARE
  _bad record;
  _refused boolean;
BEGIN
  FOR _bad IN SELECT * FROM (VALUES
      ('weekly',   NULL::int, '{}'),
      ('weekly',   NULL,      '{1,1}'),
      ('weekly',   NULL,      '{7}'),
      ('weekly',   NULL,      '{1,NULL}'),
      ('monthly',  NULL,      '{1,3,5}'),
      ('weekly',   2,         '{1,3,5}')
    ) AS t(freq, every_weeks, days) LOOP
    _refused := false;
    BEGIN
      INSERT INTO public.subscriptions (organization_id, client_id, property_id, account_type, frequency,
                                        price_cents, dog_count, weekdays, interval_weeks)
      VALUES ('05300000-0000-4000-8000-0000000000aa', 'c5300000-0000-4000-8000-0000000000a3',
              'e5300000-0000-4000-8000-0000000000a3', 'residential', _bad.freq::service_frequency,
              2500, 1, _bad.days::smallint[], _bad.every_weeks);
    EXCEPTION WHEN check_violation THEN
      _refused := true;
    END;
    IF NOT _refused THEN
      RAISE EXCEPTION 'PROOF FAILED [rules]: a % plan with weekdays % (every % weeks) was accepted',
        _bad.freq, _bad.days, COALESCE(_bad.every_weeks, 1);
    END IF;
  END LOOP;
  RAISE NOTICE 'ok: an empty, repeated, out-of-range or NULL day is refused, and so is a set on anything but plain weekly';
END $$;

-- ── 9. Each walk bills as one visit at the plan's per-visit price ──────────
DO $$
DECLARE
  _m date := (SELECT m FROM proof_day);
  _v uuid;
BEGIN
  SELECT id INTO _v FROM public.visits
   WHERE subscription_id = 'd5300000-0000-4000-8000-0000000000b1' AND scheduled_on = _m + 2;
  UPDATE public.visits SET status = 'completed', completed_at = now() WHERE id = _v;
  PERFORM public.finalize_visit_completion(_v);
  IF (SELECT price_cents FROM public.visits WHERE id = _v) IS DISTINCT FROM 2500 THEN
    RAISE EXCEPTION 'PROOF FAILED [billing]: a completed walk was stamped %, not the plan''s 2500 per visit',
      (SELECT price_cents FROM public.visits WHERE id = _v);
  END IF;
  RAISE NOTICE 'ok: a completed walk is priced as one visit at the plan''s price, the path every plan bills by';
END $$;

-- ── 10. Leaving weekly lets go of the days, so a cadence change succeeds ──
-- (the portal's auto-applied frequency change writes frequency alone)
DO $$
BEGIN
  IF (SELECT weekdays FROM public.subscriptions WHERE id = 'd5300000-0000-4000-8000-0000000000b1') IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [cadence change]: the fixture plan has no set of days to let go of';
  END IF;
  UPDATE public.subscriptions SET frequency = 'biweekly'
   WHERE id = 'd5300000-0000-4000-8000-0000000000b1';
  IF (SELECT weekdays FROM public.subscriptions WHERE id = 'd5300000-0000-4000-8000-0000000000b1') IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [cadence change]: a plan moved to biweekly kept its set of days';
  END IF;
  RAISE NOTICE 'ok: moving a set-days plan off weekly clears its days instead of failing';
END $$;

DO $$ BEGIN RAISE NOTICE 'ALL FIVE-WALKS PROOFS PASSED'; END $$;

ROLLBACK;
