-- #729: the owner's vaccine Start rule holds against a direct write too.
--
-- 20261108153100 put the BLOCK check inside start_visit_as, which is the only
-- door the app uses. It is not the only door there is: the visits UPDATE
-- policy lets the assigned tech write their own row (20260810120000), and
-- visits_guard_privileged_columns (20260928020000) does not cover status. So
-- PATCH /rest/v1/visits?id=eq.<id> {"status":"in_progress"} with a tech's
-- token started a visit the owner had set to stop, with no RPC involved.
--
-- This adds the same check as a BEFORE UPDATE OF status trigger, for a
-- signed-in caller who is not office, moving a visit into in_progress from
-- any other status (scheduled, or a detour through missed, skipped or
-- canceled first). start_visit marks the one visit it is starting, the way
-- skip_visit marks the one it is charging (houndstack.trusted_skip_visit), so
-- the RPC's own decision stands unchanged, including its deliberate pass for
-- a replayed start stamped before the rule was set.
--
-- Unchanged: WARN (the default), office roles, the service role, pg_cron, and
-- every line other than mobile grooming (visit_missing_vaccines_unchecked is
-- empty for them). No data is touched; nothing to backfill.

CREATE OR REPLACE FUNCTION public.visits_vaccine_start_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  _rule text;
  _rule_set_at timestamptz;
  _missing text;
BEGIN
  -- No JWT: service role (the lock-screen hook calls start_visit_as with its
  -- own check), pg_cron, the nightly runner.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  -- Every move INTO in_progress, not only the one from scheduled: otherwise
  -- a tech parks the visit on missed, skipped or canceled first (a status
  -- this guard has no reason to refuse) and starts it from there.
  IF NEW.status::text IS DISTINCT FROM 'in_progress'
     OR OLD.status::text = 'in_progress' THEN
    RETURN NEW;
  END IF;
  -- start_visit already decided, for this visit, in this transaction.
  IF COALESCE(current_setting('houndstack.trusted_start_visit', true), '') = NEW.id::text THEN
    RETURN NEW;
  END IF;
  -- Owner / office manager / dispatcher: the rule is about a tech's Start.
  IF public.can_write_org(auth.uid(), OLD.organization_id) THEN
    RETURN NEW;
  END IF;

  SELECT o.vaccine_start_rule, o.vaccine_start_rule_set_at
    INTO _rule, _rule_set_at
    FROM public.organizations o
   WHERE o.id = OLD.organization_id;
  IF _rule IS DISTINCT FROM 'block' OR (_rule_set_at IS NOT NULL AND now() < _rule_set_at) THEN
    RETURN NEW;
  END IF;

  SELECT string_agg(m.dog_name || ' (' || m.vaccine || ')', ', ')
    INTO _missing
    FROM public.visit_missing_vaccines_unchecked(NEW.id) m;
  IF _missing IS NOT NULL THEN
    RAISE EXCEPTION 'VACCINE_START_BLOCKED: required vaccine missing or expired: %', _missing
      USING ERRCODE = 'P0001',
            HINT = 'The owner has set a missing vaccine to stop a Start. Update the pet''s vaccine record first.';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.visits_vaccine_start_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS visits_vaccine_start_guard ON public.visits;
CREATE TRIGGER visits_vaccine_start_guard
  BEFORE UPDATE OF status ON public.visits
  FOR EACH ROW EXECUTE FUNCTION public.visits_vaccine_start_guard();

-- start_visit marks the visit it is starting, then does exactly what it did.
-- set_config(..., true) is transaction-local, and PostgREST runs each request
-- in its own transaction, so the mark cannot outlive this call or be set by a
-- caller for a PATCH of their own.
CREATE OR REPLACE FUNCTION public.start_visit(
  _visit_id uuid,
  _started_at timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM set_config('houndstack.trusted_start_visit', _visit_id::text, true);
  PERFORM public.start_visit_as(auth.uid(), _visit_id, _started_at);
  PERFORM set_config('houndstack.trusted_start_visit', '', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.start_visit(uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_visit(uuid, timestamptz) TO authenticated, service_role;

COMMENT ON FUNCTION public.start_visit(uuid, timestamptz) IS
  'Starts a visit. _started_at carries the time a QUEUED action was actually performed, bounded the same way as complete_visit. COALESCE keeps the first start, so a replay never overwrites a real one. The body is start_visit_as, with the caller as the actor. Marks the visit for visits_vaccine_start_guard, which applies the owner''s BLOCK rule to any other signed-in write (#729).';

-- ── what this file establishes ──────────────────────────────────────────────
DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.visits'::regclass
       AND tgname = 'visits_vaccine_start_guard'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'visits_vaccine_start_guard is not on public.visits';
  END IF;
  IF has_function_privilege('authenticated', 'public.visits_vaccine_start_guard()', 'EXECUTE') THEN
    RAISE EXCEPTION 'visits_vaccine_start_guard() is callable by authenticated';
  END IF;
  IF position('houndstack.trusted_start_visit' IN
       (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.start_visit(uuid, timestamptz)'::regprocedure)) = 0
  THEN
    RAISE EXCEPTION 'start_visit does not mark the visit it starts';
  END IF;
END;
$check$;
