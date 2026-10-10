-- Five walks a week: the service catalog, phase 3 (weekday cadence).
--
-- A dog walker sells "Monday to Friday" or "Mon/Wed/Fri". Until now a plan had
-- one frequency (weekly, every N weeks, twice weekly, monthly, every X days,
-- one time) and the only day-array loop was twice_weekly's. This file lets a
-- plan name the days of the week it runs on, and teaches generate_visits_core
-- to put one visit on each of them. See docs/other-trades-service-catalog.md,
-- "Migration order", step 4.
--
-- ── THE SCHEMA ───────────────────────────────────────────────────────────
--
--   subscriptions.weekdays smallint[]   the days the plan runs on, 0 = Sunday
--                                       ... 6 = Saturday. NULL (every existing
--                                       plan) means the plan's frequency
--                                       decides, exactly as before.
--
-- 0-6 and not ISO 1-7, because every other weekday in this schema already is:
-- subscriptions.preferred_weekdays, organizations.work_days and the generator's
-- own EXTRACT(DOW ...) all count from Sunday = 0. A second numbering beside them
-- is a conversion somebody forgets.
--
-- A weekday plan is stored as frequency 'weekly' with the set beside it
-- (subscriptions_weekdays_are_weekly), NOT as a new service_frequency value:
--
--   * ALTER TYPE ... ADD VALUE cannot be used in the transaction that adds it,
--     and every SQL proof here applies its migration inside a transaction it
--     rolls back. A new enum value could not be proved the way everything else
--     in this repo is.
--   * Every reader that switches on frequency already does the right thing
--     with 'weekly': the frequency multiplier is the weekly baseline (1.0 for
--     every line, and a missing key falls back to 1 in SQL and TypeScript), the
--     estimate's cadence gap is 7 days, the pricing-drift report, the portal and
--     the CSV export all know the word. An enum value would have been an
--     unknown frequency in each of them.
--
-- The set is checked (subscriptions_weekdays_valid): one to seven distinct days,
-- each 0-6, a flat array, no NULLs. Duplicates are refused rather than
-- tolerated so the label ("Mon–Fri") and the generator read the same set.
--
-- ── GENERATION ───────────────────────────────────────────────────────────
--
-- generate_visits_core gains one branch, spliced into its live definition
-- (20260801004000, as patched by 20260806050000) rather than restated, for the
-- reason 20260806050000 gives: the body carries the blackout skip, the
-- client-hold skip, the work-days fallback and the twice-weekly branch, and
-- retyping it is how one of those disappears. Two anchors, each asserted to
-- appear exactly once; the splice is a no-op on a second run.
--
-- For a plan with a weekday set it walks every day from the later of the
-- plan's start and the BUSINESS's today (organizations.timezone, as
-- tg_subscriptions_service_reaches_upcoming_visits reads it) to the horizon,
-- and inserts one visit on each listed day that is
--   * not a blackout date (skipped, not shifted: shifting a Monday walk onto
--     Tuesday would collide with Tuesday's own walk),
--   * not inside a client hold,
--   * not a day a visit of this plan was rescheduled away from
--     (visits.rescheduled_from), so moving a walk does not grow it back.
-- Then ON CONFLICT (subscription_id, scheduled_on) DO NOTHING, the same target
-- as the other three INSERTs: one visit per plan per day, which a weekday plan
-- satisfies by construction. Several visits a day is phase 8 (sitting
-- drop-ins), not this.
--
-- It walks from today rather than chaining off the plan's last visit, which is
-- what the interval branches do. Chaining is right for "every 7 days" because
-- the gap is the cadence; for a set of days it would mean a day added to the
-- set does not appear until after the 60-day horizon already generated, the
-- defect 20260806050000 fixed for preferred_weekdays. And it never generates a
-- walk in the past: a plan entered with last month's start date gets walks
-- from today, not twenty open visits nobody did.
--
-- Organization work_days are not consulted for a weekday plan, as they are not
-- for twice_weekly with chosen days: the set IS the business's choice of days.
--
-- The service is not this file's concern: visits_service (20261009230000)
-- copies the plan's service onto every inserted visit, whichever INSERT made it.
--
-- ── CHANGING THE SET ─────────────────────────────────────────────────────
--
-- subscriptions_weekdays_reshape: when a plan's weekdays change, its visits
-- that are still 'scheduled', after the business's today, not on an invoice,
-- and on a day the new set no longer lists come off the board (all of them
-- when the set is cleared and the plan goes back to its frequency). The same
-- predicate request_frequency_change uses when a client's cadence changes.
-- Visits on days that stay keep their route, tech and ETA. The generator then
-- fills the new days on its next run; updateSubscription runs it at once.
--
-- ── BILLING (no change, and why none is needed) ──────────────────────────
--
-- A plan's price_cents is per VISIT, everywhere it is read:
-- finalize_visit_completion freezes it onto each completed visit
-- (20260903150000), admin_generate_invoice_for_client bills one line per
-- completed visit at COALESCE(v.price_cents, s.price_cents), and a prepaid plan
-- debits it once per completed visit. So a Monday-to-Friday walk at $25 is five
-- $25 lines a week, and a week with a blackout is four. That is the per-visit
-- path the app already bills by; the plan form prefills price_cents from the
-- service's price (servicePriceCents), so a walk plan is priced at its
-- service's per-visit price.

-- ── 1. The column and its rules ──────────────────────────────────────────

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS weekdays smallint[];

COMMENT ON COLUMN public.subscriptions.weekdays IS
  'The days of the week this plan runs on, 0 = Sunday ... 6 = Saturday (the numbering preferred_weekdays and organizations.work_days use). One visit on each listed day. NULL means the plan''s frequency decides, as before. Only with frequency ''weekly'' and no interval. Migration 20261010010000.';

-- A valid weekday set: a flat array of one to seven distinct days, 0-6, no
-- NULLs. IMMUTABLE so a CHECK can use it; a function rather than an inline
-- expression because "distinct" needs a subquery, which a CHECK cannot hold.
CREATE OR REPLACE FUNCTION public.is_weekday_set(_days smallint[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO 'pg_catalog'
AS $function$
  SELECT _days IS NOT NULL
     AND COALESCE(array_ndims(_days), 0) = 1
     AND cardinality(_days) BETWEEN 1 AND 7
     AND _days <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[]
     AND cardinality(_days) = (SELECT count(DISTINCT d) FROM unnest(_days) AS d)
$function$;

COMMENT ON FUNCTION public.is_weekday_set(smallint[]) IS
  'True for a flat array of one to seven distinct weekdays, each 0 (Sunday) to 6. The rule subscriptions_weekdays_valid holds subscriptions.weekdays to. Migration 20261010010000.';

ALTER TABLE public.subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_weekdays_valid;
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_weekdays_valid
    CHECK (weekdays IS NULL OR public.is_weekday_set(weekdays));

-- A set of days is a week's worth of visits: it rides on 'weekly', with no
-- "every N weeks" beside it (that would be a second cadence the generator does
-- not read).
ALTER TABLE public.subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_weekdays_are_weekly;
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_weekdays_are_weekly
    CHECK (weekdays IS NULL OR (frequency = 'weekly' AND COALESCE(interval_weeks, 1) = 1));

-- ── 2. Generation: one branch, spliced ───────────────────────────────────

DO $mig$
DECLARE
  _def text;
  _n int;
  _cursor_from CONSTANT text := 's.ends_on, s.preferred_weekdays, s.interval_weeks, s.interval_days';
  _cursor_to   CONSTANT text := 's.ends_on, s.preferred_weekdays, s.interval_weeks, s.interval_days, s.weekdays';
  _branch_at   CONSTANT text := '_step := CASE _sub.frequency';
  _branch      CONSTANT text := $branch$-- weekday set (subscriptions.weekdays, 0 = Sunday): one visit on each
    -- listed day, every week, from the later of the plan's start and the
    -- business's today. Skips blackouts, client holds and days a visit was
    -- rescheduled away from. Migration 20261010010000.
    IF _sub.weekdays IS NOT NULL THEN
      DECLARE
        _today date;
      BEGIN
        SELECT (now() AT TIME ZONE COALESCE(o.timezone, 'America/Chicago'))::date INTO _today
          FROM public.organizations o WHERE o.id = _org_id;
        _candidate := GREATEST(_sub.started_on, COALESCE(_today, CURRENT_DATE));
        WHILE _candidate <= _stop LOOP
          IF EXTRACT(DOW FROM _candidate)::int = ANY(_sub.weekdays)
             AND NOT EXISTS (SELECT 1 FROM public.blackout_dates
                              WHERE organization_id = _org_id AND blackout_on = _candidate)
             AND NOT EXISTS (SELECT 1 FROM public.client_holds h
                              WHERE h.client_id = _sub.client_id
                                AND h.organization_id = _org_id
                                AND _candidate BETWEEN h.starts_on AND h.ends_on)
             AND NOT EXISTS (SELECT 1 FROM public.visits rv
                              WHERE rv.subscription_id = _sub.id
                                AND rv.rescheduled_from = _candidate) THEN
            INSERT INTO public.visits
              (organization_id, subscription_id, client_id, property_id, zone_id, scheduled_on)
            VALUES (_org_id, _sub.id, _sub.client_id, _sub.property_id, _sub.zone_id, _candidate)
            ON CONFLICT (subscription_id, scheduled_on) DO NOTHING;
            IF FOUND THEN _inserted := _inserted + 1; END IF;
          END IF;
          _candidate := _candidate + 1;
        END LOOP;
      END;
      CONTINUE;
    END IF;

    $branch$;
BEGIN
  -- A named function, never a set (working agreement: pg_get_functiondef
  -- raises on any pg_proc row that is not a plain function).
  _def := pg_get_functiondef('public.generate_visits_core(uuid, date, uuid)'::regprocedure);

  -- Ordered so a second run is a no-op rather than a failure: the splice
  -- consumes its anchors, so "anchor missing" means either already done or
  -- the body moved underneath us, and only the second is a fault.
  IF strpos(_def, 'IF _sub.weekdays IS NOT NULL THEN') > 0 THEN
    RAISE NOTICE 'generate_visits_core already reads weekday sets; leaving it alone.';
    RETURN;
  END IF;

  _n := (length(_def) - length(replace(_def, _cursor_from, ''))) / length(_cursor_from);
  IF _n <> 1 THEN
    RAISE EXCEPTION 'expected the plan cursor''s column list exactly once in generate_visits_core, found %', _n;
  END IF;
  _n := (length(_def) - length(replace(_def, _branch_at, ''))) / length(_branch_at);
  IF _n <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 "%" in generate_visits_core, found %', _branch_at, _n;
  END IF;

  _def := replace(_def, _cursor_from, _cursor_to);
  _def := replace(_def, _branch_at, _branch || _branch_at);

  EXECUTE _def;
END
$mig$;

-- CREATE OR REPLACE keeps the grants; restated so the file is safe on its own.
-- The core is reached only through wrappers that authorize first.
REVOKE EXECUTE ON FUNCTION public.generate_visits_core(uuid, date, uuid) FROM PUBLIC, anon, authenticated;

-- ── 3. Changing the set ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tg_subscriptions_weekdays_reshape()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _today date;
BEGIN
  -- The business's today, not the server's: an edit at 9 pm in Phoenix must
  -- not reach into a day Phoenix has not finished.
  SELECT (now() AT TIME ZONE COALESCE(o.timezone, 'America/Chicago'))::date INTO _today
    FROM public.organizations o WHERE o.id = NEW.organization_id;
  DELETE FROM public.visits v
   WHERE v.subscription_id = NEW.id
     AND v.status = 'scheduled'
     AND v.scheduled_on > COALESCE(_today, CURRENT_DATE)
     AND (NEW.weekdays IS NULL
          OR NOT (EXTRACT(DOW FROM v.scheduled_on)::int = ANY(NEW.weekdays)))
     AND NOT EXISTS (SELECT 1 FROM public.invoice_line_items li WHERE li.visit_id = v.id);
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_subscriptions_weekdays_reshape() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS subscriptions_weekdays_reshape ON public.subscriptions;
CREATE TRIGGER subscriptions_weekdays_reshape
  AFTER UPDATE OF weekdays ON public.subscriptions
  FOR EACH ROW
  WHEN (OLD.weekdays IS DISTINCT FROM NEW.weekdays)
  EXECUTE FUNCTION public.tg_subscriptions_weekdays_reshape();

-- ── 4. A cadence change lets go of the days ─────────────────────────────
--
-- A set of days only rides on plain weekly. Whatever moves a plan off it — the
-- portal's portal_change_frequency with auto-apply on, the office's
-- applyFrequencyChangeRequest, an import, a script — would otherwise trip
-- subscriptions_weekdays_are_weekly and fail. So a frequency or interval
-- change that leaves weekly clears the set in the same row, BEFORE the CHECK
-- runs. Only when the same UPDATE does not also write weekdays: an update that
-- asks for a set on a biweekly plan is still refused, as rule 8 proves.
-- portal_change_frequency already removes the plan's upcoming scheduled visits
-- itself, and the generator lays the new cadence on its next run.

CREATE OR REPLACE FUNCTION public.tg_subscriptions_weekdays_follow_frequency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.weekdays IS NOT NULL
     AND NEW.weekdays IS NOT DISTINCT FROM OLD.weekdays
     AND (NEW.frequency <> 'weekly' OR COALESCE(NEW.interval_weeks, 1) <> 1) THEN
    NEW.weekdays := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_subscriptions_weekdays_follow_frequency() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS subscriptions_weekdays_follow_frequency ON public.subscriptions;
CREATE TRIGGER subscriptions_weekdays_follow_frequency
  BEFORE UPDATE OF frequency, interval_weeks ON public.subscriptions
  FOR EACH ROW
  WHEN (OLD.frequency IS DISTINCT FROM NEW.frequency
        OR OLD.interval_weeks IS DISTINCT FROM NEW.interval_weeks)
  EXECUTE FUNCTION public.tg_subscriptions_weekdays_follow_frequency();

-- ── What this file establishes, checked from any starting state ───────────
DO $post$
DECLARE
  _src text;
  _n integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'subscriptions'
       AND column_name = 'weekdays' AND data_type = 'ARRAY' AND udt_name = '_int2'
  ) THEN
    RAISE EXCEPTION 'public.subscriptions.weekdays was not added as smallint[]';
  END IF;

  FOREACH _src IN ARRAY ARRAY['subscriptions_weekdays_valid', 'subscriptions_weekdays_are_weekly'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = 'public.subscriptions'::regclass AND conname = _src
         AND contype = 'c' AND convalidated
    ) THEN
      RAISE EXCEPTION 'constraint % is missing or not validated', _src;
    END IF;
  END LOOP;

  -- The rule, as the CHECK will apply it.
  IF NOT public.is_weekday_set('{1,2,3,4,5}')
     OR public.is_weekday_set('{}')
     OR public.is_weekday_set('{1,1}')
     OR public.is_weekday_set('{7}')
     OR public.is_weekday_set('{-1}')
     OR public.is_weekday_set('{1,NULL}')
     OR public.is_weekday_set('{{1,2},{3,4}}')
     OR COALESCE(public.is_weekday_set(NULL), false) THEN
    RAISE EXCEPTION 'is_weekday_set does not hold the rule it documents';
  END IF;

  -- Comments stripped first: prosrc keeps them, and the branch's own comment
  -- names what it reads.
  SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g') INTO _src
    FROM pg_proc p
   WHERE p.oid = 'public.generate_visits_core(uuid, date, uuid)'::regprocedure;
  IF _src NOT LIKE '%s.weekdays%' OR _src NOT LIKE '%IF _sub.weekdays IS NOT NULL THEN%' THEN
    RAISE EXCEPTION 'generate_visits_core does not read weekday sets';
  END IF;
  -- One visit per plan per day, still: every INSERT keeps the same target.
  _n := (length(_src) - length(replace(_src, 'ON CONFLICT (subscription_id, scheduled_on) DO NOTHING', '')))
        / length('ON CONFLICT (subscription_id, scheduled_on) DO NOTHING');
  IF _n <> 4 THEN
    RAISE EXCEPTION 'expected 4 INSERTs with ON CONFLICT (subscription_id, scheduled_on) in generate_visits_core, found %', _n;
  END IF;
  -- The skips the other branches honour, in this one too.
  IF _src NOT LIKE '%_sub.weekdays)%blackout_dates%client_holds%rescheduled_from%' THEN
    RAISE EXCEPTION 'the weekday branch lost a skip (blackout, client hold or reschedule)';
  END IF;

  IF has_function_privilege('anon', 'public.generate_visits_core(uuid, date, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.generate_visits_core(uuid, date, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'generate_visits_core is callable through the API';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.subscriptions'::regclass
       AND tgname = 'subscriptions_weekdays_reshape'
       AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'trigger subscriptions_weekdays_reshape is missing or disabled';
  END IF;
  IF has_function_privilege('anon', 'public.tg_subscriptions_weekdays_reshape()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tg_subscriptions_weekdays_reshape()', 'EXECUTE') THEN
    RAISE EXCEPTION 'tg_subscriptions_weekdays_reshape is callable through the API';
  END IF;
END
$post$;
