-- A plan does not backfill the days before it existed (#631).
--
-- generate_visits_core walks an interval plan (weekly, biweekly, every N
-- days, monthly), a twice-weekly plan and a one-time plan from started_on.
-- When started_on is earlier than the day the plan was entered, every date in
-- between is inserted already behind schedule, and the nightly
-- admin_transition_missed_visits marks each one Missed. That is history
-- nobody had: found on the Camille Ueda audit, and the demo seed built its
-- history the same way.
--
-- The weekday-set branch (20261010010000) and the stay branch
-- (20261024080100) already start at the later of started_on and the
-- business's today. The three older branches now skip any date before the
-- plan's created day in the business's timezone (organizations.timezone, as
-- the weekday branch reads it). The floor is the created day, not today:
-- a plan entered on the 1st whose first generate runs on the 3rd still gets
-- the 1st and the 2nd, because those were on its schedule from the day it
-- existed. Only the days before that are skipped.
--
-- The walk itself is unchanged. An interval plan still steps from started_on
-- and through the same blackout and work-day shifts, and only the INSERT is
-- skipped for a date before the floor. So every date on or after the floor is
-- the date it was before this file, and a plan's cadence does not move.
--
-- What this file does not touch:
--   * visits already in the table, Missed or Never on a route. No delete, no
--     rewrite. A later, separate change decides about those.
--   * admin_transition_missed_visits. A visit that was on the schedule before
--     its day and was never closed is still Missed.
--   * the weekday and stay branches, which already start at today.
--
-- ── THE DEMO SEED ────────────────────────────────────────────────────────
--
-- seed_demo_org inserts ten plans with started_on 42 to 119 days ago and
-- then calls generate_visits_core once for the history and the next three
-- weeks. With the floor alone it would get the next three weeks and no
-- history. The seed now writes each plan's created_at as 08:00 business time
-- on its started_on: the demo business has had these plans since they
-- started, which is what the history is meant to show. The generator then
-- builds the same history it did, through the same rule as every other plan.
--
-- ── HOW ──────────────────────────────────────────────────────────────────
--
-- Both functions are spliced by name against their live bodies, as every
-- change to them since 20260806050000 has been: generate_visits_core carries
-- the blackout skip, the hold skip, the work-day fallback, the preference
-- snap and two later branches, and seed_demo_org is ~600 lines. Each anchor
-- is asserted to appear exactly once. A body already spliced is a no-op.
--
-- Replays into an empty database: both functions exist by this point in the
-- sequence, nothing here reads or writes rows, and the check reads bodies.

-- ── 1. generate_visits_core ──────────────────────────────────────────────

DO $gen$
DECLARE
  _def text;
  _n int;
  _decl_from   CONSTANT text := '_base date;';
  _decl_to     CONSTANT text := '_base date;
  _floor date;';
  _cursor_from CONSTANT text := 's.interval_weeks, s.interval_days, s.weekdays, s.stay_id';
  _cursor_to   CONSTANT text := 's.interval_weeks, s.interval_days, s.weekdays, s.stay_id, s.created_at';
  _stop_from   CONSTANT text := 'IF _stop < _sub.started_on THEN CONTINUE; END IF;';
  _stop_to     CONSTANT text := 'IF _stop < _sub.started_on THEN CONTINUE; END IF;
    -- not before the plan existed: no visit on a date before the plan''s
    -- created day in the business''s timezone, so a late started_on does not
    -- backfill days that are already past. The weekday and stay branches
    -- start at today and are not affected. Migration 20261031120000.
    _floor := (COALESCE(_sub.created_at, now()) AT TIME ZONE COALESCE(
                 (SELECT o.timezone FROM public.organizations o WHERE o.id = _org_id),
                 ''America/Chicago''))::date;';
  _one_from    CONSTANT text := 'IF (_sub.ends_on IS NULL OR _candidate <= _sub.ends_on)';
  _one_to      CONSTANT text := 'IF (_sub.ends_on IS NULL OR _candidate <= _sub.ends_on)
         AND _candidate >= _floor';
  _twice_from  CONSTANT text := 'IF _next >= _sub.started_on AND _next <= _stop';
  _twice_to    CONSTANT text := 'IF _next >= _sub.started_on AND _next >= _floor AND _next <= _stop';
  _step_from   CONSTANT text := 'IF NOT EXISTS (SELECT 1 FROM public.client_holds h';
  _step_to     CONSTANT text := 'IF _candidate >= _floor AND NOT EXISTS (SELECT 1 FROM public.client_holds h';
  _anchors text[];
  _a text;
BEGIN
  -- A named function, never a set.
  _def := pg_get_functiondef('public.generate_visits_core(uuid, date, uuid)'::regprocedure);

  IF strpos(_def, '_floor := ') > 0 THEN
    RAISE NOTICE 'generate_visits_core already skips dates before a plan existed; leaving it alone.';
    RETURN;
  END IF;

  _anchors := ARRAY[_decl_from, _cursor_from, _stop_from, _one_from, _twice_from, _step_from];
  FOREACH _a IN ARRAY _anchors LOOP
    _n := (length(_def) - length(replace(_def, _a, ''))) / length(_a);
    IF _n <> 1 THEN
      RAISE EXCEPTION 'expected exactly 1 "%" in generate_visits_core, found %', _a, _n;
    END IF;
  END LOOP;

  _def := replace(_def, _decl_from, _decl_to);
  _def := replace(_def, _cursor_from, _cursor_to);
  _def := replace(_def, _stop_from, _stop_to);
  _def := replace(_def, _one_from, _one_to);
  _def := replace(_def, _twice_from, _twice_to);
  _def := replace(_def, _step_from, _step_to);

  EXECUTE _def;
END
$gen$;

-- CREATE OR REPLACE keeps the grants; restated so the file is safe on its own.
REVOKE EXECUTE ON FUNCTION public.generate_visits_core(uuid, date, uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.generate_visits_core(uuid, date, uuid) IS
  'Generates visits from active subscriptions. preferred_weekdays is honoured '
  'on every run (20260806050000). No visit is inserted on a date before the '
  'plan''s created day in the business''s timezone, so a plan entered with an '
  'earlier started_on does not backfill past days that then go Missed '
  '(20261031120000).';

-- ── 2. seed_demo_org ─────────────────────────────────────────────────────

DO $seed$
DECLARE
  _def text;
  _n int;
  _cols_from CONSTANT text := 'preferred_weekdays, status, started_on)';
  _cols_to   CONSTANT text := 'preferred_weekdays, status, started_on, created_at)';
  _vals_from CONSTANT text := $o$'active'::subscription_status, today - d.age$o$;
  _vals_to   CONSTANT text := $n$'active'::subscription_status, today - d.age,
         -- The demo has had each plan since it started, so the generator
         -- builds its history (20261031120000).
         ((today - d.age) + time '08:00') AT TIME ZONE _tz$n$;
BEGIN
  _def := pg_get_functiondef('public.seed_demo_org(uuid)'::regprocedure);

  IF strpos(_def, 'preferred_weekdays, status, started_on, created_at)') > 0 THEN
    RAISE NOTICE 'seed_demo_org already dates its plans from their start; leaving it alone.';
    RETURN;
  END IF;

  _n := (length(_def) - length(replace(_def, _cols_from, ''))) / length(_cols_from);
  IF _n <> 1 THEN
    RAISE EXCEPTION 'expected the seed''s plan column list exactly once in seed_demo_org, found %', _n;
  END IF;
  _n := (length(_def) - length(replace(_def, _vals_from, ''))) / length(_vals_from);
  IF _n <> 1 THEN
    RAISE EXCEPTION 'expected the seed''s plan start value exactly once in seed_demo_org, found %', _n;
  END IF;

  _def := replace(_def, _cols_from, _cols_to);
  _def := replace(_def, _vals_from, _vals_to);

  EXECUTE _def;
END
$seed$;

REVOKE ALL ON FUNCTION public.seed_demo_org(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seed_demo_org(uuid) TO authenticated, service_role;

-- ── What this file establishes, checked from any starting state ──────────
DO $check$
DECLARE
  _src text;
  _seed text;
BEGIN
  -- Comments stripped first: prosrc keeps them.
  SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g') INTO _src
    FROM pg_proc p
   WHERE p.oid = 'public.generate_visits_core(uuid, date, uuid)'::regprocedure;

  IF strpos(_src, 's.stay_id, s.created_at') = 0 THEN
    RAISE EXCEPTION 'generate_visits_core does not read the plan''s created_at';
  END IF;
  IF strpos(_src, '_floor := (COALESCE(_sub.created_at, now()) AT TIME ZONE') = 0 THEN
    RAISE EXCEPTION 'generate_visits_core does not compute the created-day floor';
  END IF;
  IF strpos(_src, 'AND _candidate >= _floor') = 0
     OR strpos(_src, 'AND _next >= _floor') = 0
     OR strpos(_src, 'IF _candidate >= _floor AND NOT EXISTS') = 0 THEN
    RAISE EXCEPTION 'generate_visits_core does not apply the floor in the one-time, twice-weekly and interval branches';
  END IF;
  -- The floor is set before any branch can insert.
  IF strpos(_src, '_floor := ') > strpos(_src, 'IF _sub.stay_id IS NOT NULL THEN')
     OR strpos(_src, '_floor := ') > strpos(_src, 'IF _sub.frequency = ''one_time'' THEN') THEN
    RAISE EXCEPTION 'generate_visits_core sets the floor after a branch that inserts';
  END IF;
  -- The two branches that already started at today still do.
  IF strpos(_src, 'GREATEST(_sub.started_on, COALESCE(_today, CURRENT_DATE))') = 0
     OR strpos(_src, 'GREATEST(_sub.started_on, COALESCE(_stay_today, CURRENT_DATE))') = 0 THEN
    RAISE EXCEPTION 'the weekday or stay branch no longer starts at the business''s today';
  END IF;
  IF has_function_privilege('anon', 'public.generate_visits_core(uuid, date, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.generate_visits_core(uuid, date, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'generate_visits_core is callable through the API';
  END IF;

  SELECT prosrc INTO _seed FROM pg_proc WHERE oid = 'public.seed_demo_org(uuid)'::regprocedure;
  IF strpos(_seed, 'preferred_weekdays, status, started_on, created_at)') = 0
     OR strpos(_seed, '((today - d.age) + time ''08:00'') AT TIME ZONE _tz') = 0 THEN
    RAISE EXCEPTION 'seed_demo_org does not date its plans from their start';
  END IF;
  IF has_function_privilege('anon', 'public.seed_demo_org(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can reseed an organization';
  END IF;
END
$check$;
