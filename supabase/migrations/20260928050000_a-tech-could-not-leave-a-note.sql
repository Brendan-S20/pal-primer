-- A tech could not leave a note, and the photo rule held in one place only.
--
-- Found 2026-09-27 by the field-tech persona review.
--
-- 1. Completing a visit took nothing but the visit id. "Gate latched, dog
--    barking, bags by the shed" had nowhere to go. Jobber and Housecall Pro
--    both keep a note per visit. visits.tech_note is that note, written by
--    complete_visit and shown to the office.
--
-- 2. The completion photo was required with no exception and no owner
--    setting, so a tech whose camera would not open could not finish the
--    visit at all. And the end-of-day close-out, "Yes, I completed it",
--    completed with no photo and said nothing. Too strict in one place,
--    silently bypassed in another.
--
--    Now one rule, stated in both functions:
--      * organizations.require_completion_photo (default true, which is the
--        behaviour every business has today) decides whether a photo is
--        expected.
--      * When it is, and there is none, the tech can still finish by saying
--        why. The reason lands in visits.completion_photo_waived_reason,
--        where the office can see it, instead of the visit being stuck.
--      * The close-out records "Closed out at end of day without a photo"
--        in that column when it completes a visit that has none, so it is
--        legible instead of silent.
--
-- complete_visit gains two defaulted parameters. The three-argument form
-- replaces the two-argument one, which is dropped so a call with two
-- arguments cannot become ambiguous (see 20260804060000 for that failure).
--
-- Replays into an empty database: three columns, two functions, grants. The
-- assertions are about what this file establishes.

ALTER TABLE public.visits
  ADD COLUMN IF NOT EXISTS tech_note text,
  ADD COLUMN IF NOT EXISTS completion_photo_waived_reason text;

ALTER TABLE public.visits DROP CONSTRAINT IF EXISTS visits_tech_note_length;
ALTER TABLE public.visits ADD CONSTRAINT visits_tech_note_length
  CHECK (tech_note IS NULL OR char_length(tech_note) <= 1000);
ALTER TABLE public.visits DROP CONSTRAINT IF EXISTS visits_photo_waived_reason_length;
ALTER TABLE public.visits ADD CONSTRAINT visits_photo_waived_reason_length
  CHECK (completion_photo_waived_reason IS NULL OR char_length(completion_photo_waived_reason) <= 300);

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS require_completion_photo boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.visits.tech_note IS
  'What the tech wrote when completing the visit. Shown to the office.';
COMMENT ON COLUMN public.visits.completion_photo_waived_reason IS
  'Why a visit was completed without the completion photo the organization requires: the tech''s reason, or the end-of-day close-out.';
COMMENT ON COLUMN public.organizations.require_completion_photo IS
  'Whether a completion photo is expected before a visit is completed. A tech can still finish without one by giving a reason.';

DROP FUNCTION IF EXISTS public.complete_visit(uuid, timestamptz);

CREATE OR REPLACE FUNCTION public.complete_visit(
  _visit_id uuid,
  -- When the tech actually finished, from the queued action. NULL means "now",
  -- which is the live path.
  _completed_at timestamptz DEFAULT NULL,
  _note text DEFAULT NULL,
  -- Why there is no completion photo, when the organization requires one.
  _no_photo_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _has_photo boolean;
  _required boolean;
  _waived text;
  _started timestamptz;
  _when timestamptz := now();
  _source text := 'tech_live';
BEGIN
  IF NOT public.is_visit_tech(auth.uid(), _visit_id) THEN
    RAISE EXCEPTION 'Not authorized for this visit';
  END IF;

  SELECT COALESCE(o.require_completion_photo, true)
    INTO _required
    FROM public.visits v
    JOIN public.organizations o ON o.id = v.organization_id
   WHERE v.id = _visit_id;

  SELECT EXISTS (SELECT 1 FROM public.visit_photos WHERE visit_id = _visit_id AND kind = 'completion')
    INTO _has_photo;

  IF _required AND NOT _has_photo THEN
    _waived := NULLIF(btrim(COALESCE(_no_photo_reason, '')), '');
    IF _waived IS NULL THEN
      RAISE EXCEPTION 'A completion photo is required before completing this visit. If you could not take one, say why.';
    END IF;
    _waived := left(_waived, 300);
  END IF;

  IF _completed_at IS NOT NULL THEN
    SELECT started_at INTO _started FROM public.visits WHERE id = _visit_id;
    -- Believe it only if it is possible. Each rejection falls back to now()
    -- rather than failing: the completion is real either way, and losing a
    -- tech's work over a phone clock they cannot fix in the field would be a
    -- worse answer than an approximate time that says so.
    IF _completed_at <= now()
       AND _completed_at >= now() - interval '7 days'
       AND (_started IS NULL OR _completed_at >= _started)
    THEN
      _when := _completed_at;
    END IF;
    -- The source records the REPLAY, not whether the timestamp survived
    -- validation. Either way this was not measured live, and that is the fact
    -- every reader of this column needs.
    _source := 'tech_offline_replay';
  END IF;

  UPDATE public.visits
     SET status = 'completed', completed_at = _when, updated_at = now(),
         completion_source = _source,
         tech_note = COALESCE(left(NULLIF(btrim(COALESCE(_note, '')), ''), 1000), tech_note),
         completion_photo_waived_reason = COALESCE(_waived, completion_photo_waived_reason)
   WHERE id = _visit_id AND status IN ('scheduled','in_progress','missed');
  IF NOT FOUND THEN RETURN; END IF;

  PERFORM public.finalize_visit_completion(_visit_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_visit(uuid, timestamptz, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_visit(uuid, timestamptz, text, text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.confirm_open_visit(
  _visit_id uuid,
  _completed boolean,
  _completed_at timestamptz DEFAULT NULL,
  _note text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _started timestamptz; _status public.visit_status; _required boolean; _has_photo boolean;
BEGIN
  IF NOT public.is_visit_tech(auth.uid(), _visit_id) THEN
    RAISE EXCEPTION 'Not authorized for this visit';
  END IF;

  SELECT v.started_at, v.status, COALESCE(o.require_completion_photo, true)
    INTO _started, _status, _required
    FROM public.visits v
    JOIN public.organizations o ON o.id = v.organization_id
   WHERE v.id = _visit_id;
  IF _status IS NULL THEN RAISE EXCEPTION 'Visit not found'; END IF;

  -- Idempotent: a visit already resolved (by this tech on another device, or by
  -- the office) is a no-op rather than an error, so a double-tap or a stale
  -- prompt can't double-post the prepaid debit.
  IF _status <> 'in_progress' THEN
    RETURN 'already_resolved';
  END IF;

  IF _completed THEN
    IF _completed_at IS NULL THEN
      RAISE EXCEPTION 'Tell us what time the visit finished';
    END IF;
    IF _started IS NOT NULL AND _completed_at <= _started THEN
      RAISE EXCEPTION 'The finish time must be after the start time (%).', _started;
    END IF;
    IF _completed_at > now() THEN
      RAISE EXCEPTION 'The finish time cannot be in the future';
    END IF;

    SELECT EXISTS (SELECT 1 FROM public.visit_photos WHERE visit_id = _visit_id AND kind = 'completion')
      INTO _has_photo;

    -- The close-out is for work that happened and was never closed, so it
    -- does not refuse a missing photo. It records that one is missing, where
    -- the office reads it, instead of saying nothing.
    UPDATE public.visits
       SET status = 'completed',
           completed_at = _completed_at,
           completion_source = 'late_confirmation',
           completion_photo_waived_reason = CASE
             WHEN _required AND NOT _has_photo
               THEN COALESCE(completion_photo_waived_reason, 'Closed out at end of day without a photo')
             ELSE completion_photo_waived_reason END,
           updated_at = now()
     WHERE id = _visit_id AND status = 'in_progress';
    IF NOT FOUND THEN RETURN 'already_resolved'; END IF;

    PERFORM public.finalize_visit_completion(_visit_id);
    RETURN 'completed';
  END IF;

  -- Not completed. The start stays on the record — it happened — and the visit
  -- joins the same 'missed' bucket the nightly job uses, so there is one
  -- vocabulary for "this did not get done".
  UPDATE public.visits
     SET status = 'missed',
         skip_reason = COALESCE(NULLIF(btrim(_note), ''), 'Confirmed not completed at end of day'),
         eta_start = NULL,
         eta_end = NULL,
         window_violated = false,
         updated_at = now()
   WHERE id = _visit_id AND status = 'in_progress';
  IF NOT FOUND THEN RETURN 'already_resolved'; END IF;
  RETURN 'missed';
END;
$function$;

REVOKE ALL ON FUNCTION public.confirm_open_visit(uuid, boolean, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_open_visit(uuid, boolean, timestamptz, text)
  TO authenticated, service_role;

-- What this file establishes.
DO $check$
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'complete_visit') <> 1 THEN
    RAISE EXCEPTION 'complete_visit must have exactly one signature, or a two-argument call is ambiguous';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.complete_visit(uuid, timestamptz, text, text)'::regprocedure)
       !~ 'require_completion_photo' THEN
    RAISE EXCEPTION 'complete_visit does not read the organization''s photo rule';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.confirm_open_visit(uuid, boolean, timestamptz, text)'::regprocedure)
       !~ 'completion_photo_waived_reason' THEN
    RAISE EXCEPTION 'confirm_open_visit does not record a missing photo';
  END IF;
  IF has_function_privilege('anon', 'public.complete_visit(uuid, timestamptz, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute complete_visit';
  END IF;
  IF has_function_privilege('anon', 'public.confirm_open_visit(uuid, boolean, timestamptz, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute confirm_open_visit';
  END IF;
END
$check$;
