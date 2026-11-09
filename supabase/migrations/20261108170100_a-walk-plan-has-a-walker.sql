-- A walk plan has a walker, and a one-person walking business walks its own
-- walks (#731, audit F-17).
--
-- F-17 found that a walk plan's time window works, but the plan could not say
-- who walks it, so every generated walk arrived unassigned; and that in a
-- business whose only person is the owner, those walks stayed unassigned
-- until somebody opened Routes, though there was nobody else they could go to.
--
-- ── WHAT THIS ADDS ───────────────────────────────────────────────────────
--
-- subscriptions.assigned_staff_id: the plan's walker. NULL, the default for
-- every plan, means no walker on the plan, which is how every plan works
-- today.
--
-- One BEFORE INSERT trigger on visits. A new visit that arrives with nobody
-- on it gets, in this order:
--
--   1. its plan's walker, when the plan names one who is in this business,
--      active, runs routes and is not off that day;
--   2. otherwise, for a dog walk only, the business's one person, when the
--      business has exactly one active staff member, who runs routes and is
--      not off that day.
--
-- Otherwise it stays unassigned, as now. Every condition is a reason not to
-- assign, never a reason to fail: a nightly generator that raised because a
-- walker was on leave would lose the whole night's schedule.
--
-- ── WHAT IT NEVER DOES ───────────────────────────────────────────────────
--
--   * It never overwrites. A visit that arrives with someone on it (the
--     office booked it to a person, a stay's sitter, an import) keeps them,
--     and it runs on INSERT only, so no later assignment is ever touched
--     (#609, D10: a hand assignment is a decision the planner cannot see).
--   * Changing a plan's walker does not move visits already generated. Only
--     visits created after the change get the new walker. Whether to also move
--     a plan's future unassigned visits is an owner question on the PR.
--   * A stay's plan is left to the stay (tg_visits_stay_sitter).
--   * A walk joining a group with a walker still takes the group's walker:
--     visits_validate_walk_group runs after this trigger, by name, and a
--     group's walker wins.
--   * The solo fallback is for dog walks only, the line F-17 audited. Whether
--     a one-person cleanup or grooming business should get the same is an
--     owner question; until answered they behave as before.
--
-- A walker set on a plan is checked like a group's walker: they must be in the
-- plan's business. Runs-routes is not required to SAVE the plan (a person can
-- be ticked later); it is required for a visit to be given to them, matching
-- assert_runs_routes.
--
-- Replays into an empty database: the tables and is_staff_off exist by this
-- point, nothing reads or writes rows, and the check reads the catalog.

ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS assigned_staff_id uuid
  REFERENCES public.staff(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS subscriptions_assigned_staff_idx
  ON public.subscriptions(assigned_staff_id);
COMMENT ON COLUMN public.subscriptions.assigned_staff_id IS
  'The plan''s walker. New visits from this plan that arrive unassigned are given to them when they are active, run routes and are not off that day. NULL means none. Never moves a visit already made. Migration 20261108170100.';

-- ── The plan's walker is from the plan's business ────────────────────────
CREATE OR REPLACE FUNCTION public.validate_plan_walker()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.assigned_staff_id IS NOT NULL
    AND (TG_OP = 'INSERT' OR NEW.assigned_staff_id IS DISTINCT FROM OLD.assigned_staff_id
         OR NEW.organization_id IS DISTINCT FROM OLD.organization_id)
    AND NOT EXISTS (
      SELECT 1 FROM public.staff s
       WHERE s.id = NEW.assigned_staff_id AND s.organization_id = NEW.organization_id
    ) THEN
    RAISE EXCEPTION 'Choose a walker from this business.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.validate_plan_walker() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS subscriptions_validate_plan_walker ON public.subscriptions;
CREATE TRIGGER subscriptions_validate_plan_walker
  BEFORE INSERT OR UPDATE OF assigned_staff_id, organization_id ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.validate_plan_walker();

-- ── A new visit takes its plan's walker, or the one person ───────────────
CREATE OR REPLACE FUNCTION public.fill_visit_walker()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _plan_walker uuid;
  _stay uuid;
  _line text;
  _only uuid;
  _people integer;
BEGIN
  IF NEW.assigned_staff_id IS NOT NULL OR NEW.subscription_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT s.assigned_staff_id, s.stay_id INTO _plan_walker, _stay
    FROM public.subscriptions s
   WHERE s.id = NEW.subscription_id AND s.organization_id = NEW.organization_id;
  IF NOT FOUND OR _stay IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- 1. The plan's walker.
  IF _plan_walker IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.staff st
       WHERE st.id = _plan_walker AND st.organization_id = NEW.organization_id
         AND COALESCE(st.active, true) AND COALESCE(st.is_field_tech, false)
    ) AND NOT public.is_staff_off(_plan_walker, NEW.scheduled_on) THEN
      NEW.assigned_staff_id := _plan_walker;
    END IF;
    -- A plan that names a walker who cannot take this day leaves the walk for
    -- the office, rather than handing it to someone the plan did not name.
    RETURN NEW;
  END IF;

  -- 2. A dog walk in a one-person business.
  SELECT sv.service_line INTO _line
    FROM public.services sv
   WHERE sv.id = COALESCE(NEW.service_id,
                          (SELECT s.service_id FROM public.subscriptions s WHERE s.id = NEW.subscription_id));
  IF _line IS DISTINCT FROM 'dog_walking' THEN
    RETURN NEW;
  END IF;
  SELECT count(*)::integer, (array_agg(st.id))[1] INTO _people, _only
    FROM public.staff st
   WHERE st.organization_id = NEW.organization_id AND COALESCE(st.active, true);
  IF _people = 1 AND EXISTS (
       SELECT 1 FROM public.staff st WHERE st.id = _only AND COALESCE(st.is_field_tech, false)
     ) AND NOT public.is_staff_off(_only, NEW.scheduled_on) THEN
    NEW.assigned_staff_id := _only;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.fill_visit_walker() FROM PUBLIC, anon, authenticated;

-- Named to sort before visits_stay_sitter and visits_validate_walk_group:
-- those see the walker this sets, and a group's walker overrides it.
DROP TRIGGER IF EXISTS visits_plan_walker ON public.visits;
CREATE TRIGGER visits_plan_walker
  BEFORE INSERT ON public.visits
  FOR EACH ROW EXECUTE FUNCTION public.fill_visit_walker();

-- ── What this file establishes ───────────────────────────────────────────
DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'subscriptions'
       AND column_name = 'assigned_staff_id' AND is_nullable = 'YES' AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'subscriptions.assigned_staff_id must exist, nullable, with no default.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.visits'::regclass AND t.tgname = 'visits_plan_walker'
       AND NOT t.tgisinternal
       -- tgtype bits: BEFORE = 2, INSERT = 4, UPDATE = 16. INSERT only, so
       -- it never touches a visit that already exists.
       AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 AND (t.tgtype & 16) = 0
  ) THEN
    RAISE EXCEPTION 'visits_plan_walker must be BEFORE INSERT only.';
  END IF;
  IF has_function_privilege('anon', 'public.fill_visit_walker()', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.fill_visit_walker()', 'EXECUTE')
    OR has_function_privilege('anon', 'public.validate_plan_walker()', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.validate_plan_walker()', 'EXECUTE') THEN
    RAISE EXCEPTION 'A plan walker trigger function is callable by a client role.';
  END IF;
END
$check$;
