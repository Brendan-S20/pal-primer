-- BUILD-11: close out visits a tech started and never finished.
--
-- A visit left `in_progress` overnight is currently immortal: the nightly
-- missed-visit job deliberately skips anything with a started_at (it only
-- transitions untouched 'scheduled' rows), so nothing ever resolves it. The
-- tech's day rolls over and the open job silently drops off their list.
--
-- The obvious fix — auto-complete it with now() — is precisely how the BUG-9
-- records were manufactured: a completion timestamp invented by the system for
-- a service nobody measured. An older office-completion path did exactly that
-- and left two rows whose start and completion are identical to the
-- microsecond, one of them stamped fourteen days after its scheduled date.
-- This migration is deliberately built so that cannot happen again:
--
--   1. Nothing auto-completes. A human confirms, or the visit does not close.
--   2. A confirmed completion time is CHECKED against the start time in the
--      database, so the identical-pair signature is rejected by construction
--      rather than by convention.
--   3. Every completion records HOW it was captured, so a retrospectively
--      confirmed visit can never be read back as measured service time.
--
-- Idempotent.

-- ── 1. Provenance ───────────────────────────────────────────────────────────
-- Deliberately NULL for every existing row. Backfilling 'tech_live' would
-- assert provenance nobody recorded — the same class of invention this whole
-- item exists to prevent (guardrail 10.6). NULL means "captured before we
-- tracked this", which is the truth.
ALTER TABLE public.visits
  ADD COLUMN IF NOT EXISTS completion_source text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'visits_completion_source_check'
  ) THEN
    ALTER TABLE public.visits
      ADD CONSTRAINT visits_completion_source_check
      CHECK (completion_source IS NULL
             OR completion_source IN ('tech_live', 'office', 'late_confirmation'));
  END IF;
END $$;

COMMENT ON COLUMN public.visits.completion_source IS
  'How the completion was captured: tech_live (tech closed it in the field), office (marked complete by office staff), late_confirmation (tech confirmed after the fact via the end-of-day close-out). NULL on rows completed before this was tracked — unknown, not assumed. A late_confirmation completed_at is asserted by a human, not measured, and must not be read as service duration.';

-- ── 2. One finalizer, not three ─────────────────────────────────────────────
-- complete_visit and office_complete_visit already carried identical copies of
-- the post-completion work (station service + the prepaid ledger debit). A
-- third completion path would have made three. Extracted so the money side has
-- exactly one implementation (guardrail 10.2).
--
-- Callers MUST have already flipped the row to 'completed' and confirmed the
-- UPDATE matched, so this never double-posts: the guard lives in the caller's
-- `IF NOT FOUND THEN RETURN`, which a second concurrent call cannot pass.
CREATE OR REPLACE FUNCTION public.finalize_visit_completion(_visit_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid; _client uuid; _cadence public.billing_cadence; _price integer;
BEGIN
  PERFORM public.record_visit_station_service(_visit_id);

  SELECT v.organization_id, v.client_id, s.billing_cadence, s.price_cents
    INTO _org, _client, _cadence, _price
    FROM public.visits v JOIN public.subscriptions s ON s.id = v.subscription_id
   WHERE v.id = _visit_id;

  IF _cadence = 'prepaid' AND COALESCE(_price, 0) > 0 THEN
    PERFORM public.post_credit_entry(_org, _client, -_price, 'visit_debit', NULL, _visit_id, 'Visit completed');
  END IF;
END;
$function$;

-- Behaviour unchanged: same guard, same order, same ledger call — the body is
-- the previous inline copy, moved. Also stamps provenance.
CREATE OR REPLACE FUNCTION public.complete_visit(_visit_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _has_photo boolean;
BEGIN
  IF NOT public.is_visit_tech(auth.uid(), _visit_id) THEN
    RAISE EXCEPTION 'Not authorized for this visit';
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.visit_photos WHERE visit_id = _visit_id AND kind = 'completion') INTO _has_photo;
  IF NOT _has_photo THEN
    RAISE EXCEPTION 'A completion photo is required before completing this visit';
  END IF;

  UPDATE public.visits
     SET status='completed', completed_at = now(), updated_at = now(),
         completion_source = 'tech_live'
   WHERE id = _visit_id AND status IN ('scheduled','in_progress','missed');
  IF NOT FOUND THEN RETURN; END IF;

  PERFORM public.finalize_visit_completion(_visit_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.office_complete_visit(_visit_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid; _status public.visit_status;
BEGIN
  SELECT organization_id, status INTO _org, _status
    FROM public.visits WHERE id = _visit_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Visit not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _status NOT IN ('scheduled','in_progress','missed') THEN
    RAISE EXCEPTION 'Only scheduled, in-progress, or missed visits can be completed';
  END IF;

  -- Note it still does NOT touch started_at. Writing now() into both start and
  -- completion is what produced the BUG-9 rows; that was fixed earlier and must
  -- stay fixed.
  UPDATE public.visits
     SET status='completed', completed_at = now(), updated_at = now(),
         completion_source = 'office'
   WHERE id = _visit_id AND status IN ('scheduled','in_progress','missed');
  IF NOT FOUND THEN RETURN; END IF;

  PERFORM public.finalize_visit_completion(_visit_id);
END;
$function$;

-- ── 3. The close-out itself ─────────────────────────────────────────────────
-- Called only from the tech's end-of-day prompt. Never from a job, never on a
-- timer — "requesting confirmation" is the whole point, so the system asks and
-- a human answers.
--
-- _completed_at is the time the TECH states they finished. It is validated
-- against the recorded start: strictly after it, and not in the future. That
-- makes the BUG-9 signature (completion == start) impossible to write through
-- this path, enforced by the database rather than by the caller remembering.
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
DECLARE _started timestamptz; _status public.visit_status;
BEGIN
  IF NOT public.is_visit_tech(auth.uid(), _visit_id) THEN
    RAISE EXCEPTION 'Not authorized for this visit';
  END IF;

  SELECT started_at, status INTO _started, _status
    FROM public.visits WHERE id = _visit_id;
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

    UPDATE public.visits
       SET status = 'completed',
           completed_at = _completed_at,
           completion_source = 'late_confirmation',
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

REVOKE ALL ON FUNCTION public.finalize_visit_completion(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_open_visit(uuid, boolean, timestamptz, text) TO authenticated;
