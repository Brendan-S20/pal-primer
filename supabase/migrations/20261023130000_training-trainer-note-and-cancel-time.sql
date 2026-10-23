-- Follow-up to 20261023110000 and 20261023120000, from the product
-- re-review of the training packages.
--
-- 1. training_session_notes.trainer_note. A second note on a lesson that only
--    staff read. The portal reads `note` when the business shares progress,
--    and never selects trainer_note. A lesson can have either note or both,
--    so `note` is now nullable.
--
-- 2. A missed lesson for the business's own reason uses no session. The
--    exemptions that applied to a skip (our_fault, weather,
--    unsafe_conditions) now apply to missed too. office_mark_visit_missed
--    takes an optional reason code so the office can say so when it marks
--    the lesson missed.
--
-- 3. visits.client_cancelled_at. When the client called to cancel, as the
--    office recorded it. The late-cancel rule measures the notice from this
--    time when it is set, and from now() when it is not. office_skip_visit
--    takes it as an optional argument. Only an office writer may set it, the
--    same as the skip_billable override.
--
-- 4. On a status change, a skip_billable sent by someone outside the office
--    is ignored. The rule decides.
--
-- Replays into an empty database: two columns, a constraint, three functions,
-- a trigger and their grants. The check block asserts only what this file
-- creates.

-- ── 1. The trainer-only note ─────────────────────────────────────────────

ALTER TABLE public.training_session_notes
  ADD COLUMN IF NOT EXISTS trainer_note text
    CHECK (trainer_note IS NULL OR char_length(btrim(trainer_note)) BETWEEN 1 AND 2000);
ALTER TABLE public.training_session_notes ALTER COLUMN note DROP NOT NULL;
ALTER TABLE public.training_session_notes DROP CONSTRAINT IF EXISTS training_session_notes_has_a_note;
ALTER TABLE public.training_session_notes ADD CONSTRAINT training_session_notes_has_a_note
  CHECK (note IS NOT NULL OR trainer_note IS NOT NULL);

COMMENT ON COLUMN public.training_session_notes.note IS
  'The lesson note. The customer portal shows it when the business shares training progress.';
COMMENT ON COLUMN public.training_session_notes.trainer_note IS
  'Staff only. The customer portal never reads this column.';

-- ── 3. When the client canceled ──────────────────────────────────────────

ALTER TABLE public.visits ADD COLUMN IF NOT EXISTS client_cancelled_at timestamptz;
COMMENT ON COLUMN public.visits.client_cancelled_at IS
  'When the client called to cancel, as the office recorded it. A training lesson''s late-cancel rule measures notice from here.';

-- ── 2, 3 and 4. The rule ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.training_lesson_session_rule()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE _o public.organizations%ROWTYPE; _start time; _starts timestamptz; _office boolean;
BEGIN
  IF NEW.client_cancelled_at IS DISTINCT FROM OLD.client_cancelled_at
     AND (select auth.uid()) IS NOT NULL
     AND NOT public.can_write_org((select auth.uid()), NEW.organization_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Only the office can record when the client canceled.';
  END IF;
  IF NEW.client_package_id IS NULL THEN RETURN NEW; END IF;
  _office := (select auth.uid()) IS NULL
    OR public.can_write_org((select auth.uid()), NEW.organization_id);
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    -- The office override. A trainer records the lesson but does not decide
    -- whether the client loses a session for it.
    IF NEW.skip_billable IS DISTINCT FROM OLD.skip_billable AND NOT _office THEN
      RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
        MESSAGE = 'Only the office can change whether this lesson uses a session.';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status NOT IN ('skipped', 'missed') THEN
    -- Back on the schedule, or completed: a later skip starts from the rule again.
    NEW.skip_billable := false;
    NEW.client_cancelled_at := NULL;
    RETURN NEW;
  END IF;
  -- The business's own reasons never cost the client a session, missed or skipped.
  IF NEW.skip_reason_code IN ('our_fault', 'weather', 'unsafe_conditions') THEN
    NEW.skip_billable := false;
    RETURN NEW;
  END IF;
  SELECT * INTO _o FROM public.organizations WHERE id = NEW.organization_id;
  IF NEW.status = 'missed' THEN
    NEW.skip_billable := COALESCE(_o.training_missed_uses_session, true);
    RETURN NEW;
  END IF;
  -- A lesson starts at its plan's start time, or at midnight when it has none.
  SELECT s.earliest_time INTO _start FROM public.subscriptions s WHERE s.id = NEW.subscription_id;
  _starts := (NEW.scheduled_on + COALESCE(_start, time '00:00'))
    AT TIME ZONE COALESCE(_o.timezone, 'America/Chicago');
  -- Notice runs from when the client called, when the office recorded it.
  -- Only the office's own value is kept on top of the rule.
  NEW.skip_billable := (_office AND COALESCE(NEW.skip_billable, false)) OR (
    COALESCE(_o.training_missed_uses_session, true)
    AND COALESCE(NEW.client_cancelled_at, now())
      >= _starts - make_interval(hours => COALESCE(_o.training_late_cancel_hours, 24))
  );
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.training_lesson_session_rule() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS training_lesson_session_rule ON public.visits;
-- Named to sort before zz_training_visit_package_guard, which then sees the
-- skip_billable this rule chose.
CREATE TRIGGER training_lesson_session_rule
BEFORE UPDATE OF status, skip_billable, client_cancelled_at ON public.visits
FOR EACH ROW EXECUTE FUNCTION public.training_lesson_session_rule();

-- ── The office paths that carry the reason and the time ──────────────────

-- Same body as 20260717160000, plus when the client called. A new argument
-- with a default would be an ambiguous overload, so the old one is dropped.
DROP FUNCTION IF EXISTS public.office_skip_visit(uuid, text, public.skip_reason_code);
CREATE OR REPLACE FUNCTION public.office_skip_visit(
  _visit_id uuid, _reason text, _code public.skip_reason_code DEFAULT 'other'::public.skip_reason_code,
  _client_cancelled_at timestamptz DEFAULT NULL
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid; _price integer; _pct integer; _charge integer;
BEGIN
  SELECT v.organization_id, s.price_cents
    INTO _org, _price
    FROM public.visits v
    JOIN public.subscriptions s ON s.id = v.subscription_id
   WHERE v.id = _visit_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Visit not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _reason IS NULL OR length(trim(_reason)) = 0 THEN
    RAISE EXCEPTION 'A reason is required to cancel a visit';
  END IF;
  IF _client_cancelled_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'The time the client canceled cannot be in the future';
  END IF;

  SELECT billable_pct INTO _pct
    FROM public.skip_billing_rules
   WHERE organization_id = _org AND reason_code = _code;
  IF _pct IS NULL THEN
    _pct := public.default_skip_billable_pct(_code);
  END IF;

  _charge := ROUND(COALESCE(_price, 0) * _pct / 100.0)::int;

  UPDATE public.visits
     SET status = 'skipped',
         skip_reason = _reason,
         skip_reason_code = _code,
         skip_billable = (_charge > 0),
         skip_charge_cents = _charge,
         client_cancelled_at = _client_cancelled_at,
         updated_at = now()
   WHERE id = _visit_id AND status IN ('scheduled','in_progress','missed');
END; $function$;
REVOKE ALL ON FUNCTION public.office_skip_visit(uuid, text, public.skip_reason_code, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.office_skip_visit(uuid, text, public.skip_reason_code, timestamptz) TO authenticated;

-- Same body as 20261012140000, plus the reason. A missed training lesson
-- with our_fault, weather or unsafe_conditions uses no session.
DROP FUNCTION IF EXISTS public.office_mark_visit_missed(uuid);
CREATE OR REPLACE FUNCTION public.office_mark_visit_missed(
  _visit_id uuid, _code public.skip_reason_code DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid;
  _status public.visit_status;
  _blocker text;
BEGIN
  SELECT organization_id, status
    INTO _org, _status
    FROM public.visits
   WHERE id = _visit_id;

  IF _org IS NULL THEN
    RAISE EXCEPTION 'Visit not found';
  END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _status <> 'completed' THEN
    RAISE EXCEPTION 'Only completed visits can be marked missed';
  END IF;

  _blocker := public.visit_completion_billing_blocker(_visit_id);
  IF _blocker IS NOT NULL THEN
    RAISE EXCEPTION '%', _blocker;
  END IF;

  UPDATE public.visits
     SET status = 'missed',
         skip_reason_code = _code,
         started_at = NULL,
         completed_at = NULL,
         completion_source = NULL,
         completion_photo_waived_reason = NULL,
         visit_checklist = NULL,
         price_cents = NULL,
         updated_at = now()
   WHERE id = _visit_id
     AND status = 'completed';
END;
$function$;
REVOKE ALL ON FUNCTION public.office_mark_visit_missed(uuid, public.skip_reason_code) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.office_mark_visit_missed(uuid, public.skip_reason_code) TO authenticated;

DO $check$
DECLARE _src text; _fn text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
       AND table_name = 'training_session_notes' AND column_name = 'trainer_note')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
       AND table_name = 'training_session_notes' AND column_name = 'note' AND is_nullable = 'YES')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.training_session_notes'::regclass
       AND conname = 'training_session_notes_has_a_note') THEN
    RAISE EXCEPTION 'The trainer-only note column or its constraint is missing.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
       AND table_name = 'visits' AND column_name = 'client_cancelled_at') THEN
    RAISE EXCEPTION 'visits.client_cancelled_at is missing.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
       JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = ANY (t.tgattr)
       WHERE t.tgname = 'training_lesson_session_rule' AND t.tgrelid = 'public.visits'::regclass
         AND NOT t.tgisinternal AND t.tgenabled <> 'D' AND a.attname = 'client_cancelled_at') THEN
    RAISE EXCEPTION 'training_lesson_session_rule does not fire on client_cancelled_at.';
  END IF;
  SELECT p.prosrc INTO _src FROM pg_proc p WHERE p.oid = 'public.training_lesson_session_rule()'::regprocedure;
  IF strpos(_src, 'COALESCE(NEW.client_cancelled_at, now())') = 0
     OR strpos(_src, 'Only the office can record when the client canceled.') = 0
     OR strpos(_src, '_office AND COALESCE(NEW.skip_billable, false)') = 0 THEN
    RAISE EXCEPTION 'training_lesson_session_rule is not the version this file writes.';
  END IF;
  -- The reason exemptions come before the missed branch, so they cover both.
  IF strpos(_src, '''our_fault'', ''weather'', ''unsafe_conditions''') = 0
     OR strpos(_src, '''our_fault'', ''weather'', ''unsafe_conditions''') > strpos(_src, 'IF NEW.status = ''missed'' THEN') THEN
    RAISE EXCEPTION 'A missed lesson for the business''s own reason still uses a session.';
  END IF;

  IF to_regprocedure('public.office_skip_visit(uuid, text, public.skip_reason_code)') IS NOT NULL
     OR to_regprocedure('public.office_mark_visit_missed(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'An old office visit action is still defined beside the new one.';
  END IF;
  FOREACH _fn IN ARRAY ARRAY[
    'public.office_skip_visit(uuid, text, public.skip_reason_code, timestamptz)',
    'public.office_mark_visit_missed(uuid, public.skip_reason_code)'
  ] LOOP
    IF has_function_privilege('anon', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% is executable with the publishable key', _fn;
    END IF;
    IF NOT has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% is not callable by a signed-in office user', _fn;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public.training_lesson_session_rule()', 'EXECUTE') THEN
    RAISE EXCEPTION 'training_lesson_session_rule is callable from the API';
  END IF;
END
$check$;
