-- A lesson series skips the days the business is closed, and can stop after
-- a number of lessons (R2-49, train-r2-08).
--
-- The audit's weekly Friday lesson series, made through Add Service, put a
-- lesson on Fri Dec 25 and had no end and no count. A package governs its
-- own dates and count; a plain series had neither setting.
--
-- 1. organizations.training_series_skip_closed (default true): the business
--    default. Set in Settings beside the other training rules, through
--    set_training_series_skip_closed (owner or office manager, as the other
--    training settings are).
-- 2. subscriptions.skip_closed_days (NULL = the business default for a
--    training series, off for every other line) and
--    subscriptions.session_limit (NULL = open-ended; 1 to 520).
-- 3. visits_follow_series_rules, a BEFORE INSERT trigger on visits. For a
--    new scheduled visit of a recurring plan that is not a package's or a
--    stay's:
--      * skip-closed on, and the date is in blackout_dates (closed) or
--        holiday_dates (a holiday): the row is not inserted.
--      * a session limit, and the plan already holds that many lessons: the
--        row is not inserted. A lesson holds a session the way a package
--        lesson does (training-packages.ts holdsSession): scheduled, in
--        progress, completed, missed, or skipped and billable. A lesson the
--        client canceled without charge frees its place, and the next
--        generate adds a date at the end.
--    The generator is not edited. Every path that inserts a plan's visit
--    meets the same rule, and a skipped date stays skipped on every run.
--    A one-time plan, a package plan and a stay are never touched: the
--    office chose those dates.
--
-- Defaults: skip-closed ON (the business default is true and a series
-- inherits it unless it says otherwise); session count empty = open-ended.
-- Existing training series inherit skip-closed from now on. Visits already
-- generated are not deleted here; editing the series removes the upcoming
-- ones that break its rules (subscriptions.functions.ts).
--
-- One new trigger function, revoked from the API roles.
--
-- Replays into an empty database: columns, two functions, a trigger and a
-- check on what this file creates.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS training_series_skip_closed boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN public.organizations.training_series_skip_closed IS
  'Whether a new training lesson series skips blackout and holiday dates unless the series says otherwise. Migration 20261102172500.';

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS skip_closed_days boolean,
  ADD COLUMN IF NOT EXISTS session_limit integer;
ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_session_limit_range;
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_session_limit_range
  CHECK (session_limit IS NULL OR session_limit BETWEEN 1 AND 520);
COMMENT ON COLUMN public.subscriptions.skip_closed_days IS
  'Skip blackout and holiday dates when generating. NULL: the business default for a training series (organizations.training_series_skip_closed), off for other lines.';
COMMENT ON COLUMN public.subscriptions.session_limit IS
  'Stop generating once the plan holds this many lessons. NULL: open-ended.';

-- ── The business default ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_training_series_skip_closed(_org_id uuid, _skip boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (
    public.has_role((select auth.uid()), _org_id, 'owner')
    OR public.has_role((select auth.uid()), _org_id, 'office_manager')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege', MESSAGE = 'Not authorized to update training settings';
  END IF;
  IF _skip IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Choose whether lesson series skip closed days.';
  END IF;
  UPDATE public.organizations SET training_series_skip_closed = _skip WHERE id = _org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization not found';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.set_training_series_skip_closed(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_training_series_skip_closed(uuid, boolean) TO authenticated, service_role;

-- ── The rule every inserted visit meets ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.visits_follow_series_rules()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  _skip boolean;
  _limit integer;
  _held integer;
BEGIN
  IF NEW.subscription_id IS NULL OR NEW.status IS DISTINCT FROM 'scheduled' THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(
           s.skip_closed_days,
           CASE WHEN svc.service_line = 'training' THEN o.training_series_skip_closed ELSE false END
         ),
         s.session_limit
    INTO _skip, _limit
    FROM public.subscriptions s
    JOIN public.organizations o ON o.id = s.organization_id
    LEFT JOIN public.services svc ON svc.id = s.service_id
   WHERE s.id = NEW.subscription_id
     AND s.frequency <> 'one_time'
     AND s.client_package_id IS NULL
     AND s.stay_id IS NULL;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF _skip AND (
    EXISTS (SELECT 1 FROM public.blackout_dates b
             WHERE b.organization_id = NEW.organization_id AND b.blackout_on = NEW.scheduled_on)
    OR EXISTS (SELECT 1 FROM public.holiday_dates h
                WHERE h.organization_id = NEW.organization_id AND h.holiday_on = NEW.scheduled_on)
  ) THEN
    RETURN NULL;
  END IF;
  IF _limit IS NOT NULL THEN
    SELECT count(*) INTO _held
      FROM public.visits v
     WHERE v.subscription_id = NEW.subscription_id
       AND (v.status IN ('scheduled', 'in_progress', 'completed', 'missed')
            OR (v.status = 'skipped' AND v.skip_billable));
    IF _held >= _limit THEN
      RETURN NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.visits_follow_series_rules() FROM PUBLIC, anon, authenticated;

-- "aa_" so it runs before the other BEFORE INSERT triggers on visits: a row
-- that is not going to exist need not be priced, guarded or numbered.
DROP TRIGGER IF EXISTS aa_visits_follow_series_rules ON public.visits;
CREATE TRIGGER aa_visits_follow_series_rules BEFORE INSERT ON public.visits
FOR EACH ROW EXECUTE FUNCTION public.visits_follow_series_rules();

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
       AND table_name = 'subscriptions' AND column_name = 'session_limit')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
       AND table_name = 'subscriptions' AND column_name = 'skip_closed_days')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
       AND table_name = 'organizations' AND column_name = 'training_series_skip_closed') THEN
    RAISE EXCEPTION 'Lesson series columns are missing.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'aa_visits_follow_series_rules'
       AND tgrelid = 'public.visits'::regclass AND NOT tgisinternal AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'aa_visits_follow_series_rules is missing on visits.';
  END IF;
  IF has_function_privilege('anon', 'public.visits_follow_series_rules()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.visits_follow_series_rules()', 'EXECUTE') THEN
    RAISE EXCEPTION 'visits_follow_series_rules is reachable by an API role.';
  END IF;
  IF has_function_privilege('anon', 'public.set_training_series_skip_closed(uuid, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'set_training_series_skip_closed is reachable by anon.';
  END IF;
END $post$;
