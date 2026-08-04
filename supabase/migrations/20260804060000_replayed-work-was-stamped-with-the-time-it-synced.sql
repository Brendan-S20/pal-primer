-- A visit finished at 9:15am in a dead zone and synced at 4pm was recorded as
-- completed at 4pm — and labelled `completion_source = 'tech_live'`, which
-- asserts it was measured live.
--
-- ── WHY THAT IS WORSE THAN AN INACCURATE CLOCK ────────────────────────────
--
-- `completed_at` is not decoration. It drives the day's completion rate, the
-- "2 of 7 done" progress bar, route timing, the tech's own history, and the
-- completion time a customer is shown. Stamping it with the sync time moves
-- every offline visit to whenever signal came back — usually in a cluster, at
-- the end of the day, in the wrong order.
--
-- And `tech_live` is a claim about PROVENANCE. This schema already knows the
-- difference: `late_confirmation` exists for BUILD-11's close-out, whose audit
-- line reads "finish time entered by the tech, not measured". A replayed
-- action is the same kind of fact — a time asserted rather than observed — and
-- it was being filed as the strongest kind.
--
-- ── WHAT THE CLIENT MAY AND MAY NOT DECIDE ────────────────────────────────
--
-- The device supplies the time; the server decides whether to believe it. A
-- queued action's `ts` comes from a phone whose clock the tech can set, so:
--
--   * A future time is refused outright and falls back to now(). A visit
--     completed "tomorrow" corrupts every forward-looking figure.
--   * A time before the visit started is refused the same way — it would
--     produce a negative duration.
--   * More than 7 days old is refused: the queue holds hours of work, not
--     weeks, and a date that far back is a broken clock rather than a long
--     dead zone.
--
-- Every rejection falls back to now() rather than failing the call, because
-- the completion itself is real and refusing it would lose the tech's work
-- over a clock they cannot fix in the field. The provenance still records that
-- the time was replayed, so a wrong-looking timestamp is explainable rather
-- than mysterious.
--
-- Defaults on both new parameters, so the online path calls these exactly as
-- before and behaves exactly as before.

-- `completion_source` is constrained to a known set. Adding a value to the
-- function without adding it here fails at the UPDATE — which the live probe
-- caught, and which would otherwise have broken the FIRST offline sync in
-- production, dead-lettering the tech's queue after five attempts.
ALTER TABLE public.visits DROP CONSTRAINT IF EXISTS visits_completion_source_check;
ALTER TABLE public.visits ADD CONSTRAINT visits_completion_source_check
  CHECK (completion_source IS NULL OR completion_source = ANY (ARRAY[
    'tech_live'::text,            -- measured here, live
    'office'::text,               -- entered by office staff
    'late_confirmation'::text,    -- BUILD-11 close-out: asserted after the fact
    'tech_offline_replay'::text   -- queued in the field, replayed on reconnect
  ]));

CREATE OR REPLACE FUNCTION public.complete_visit(
  _visit_id uuid,
  -- When the tech actually finished, from the queued action. NULL means "now",
  -- which is the live path.
  _completed_at timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _has_photo boolean;
  _started timestamptz;
  _when timestamptz := now();
  _source text := 'tech_live';
BEGIN
  IF NOT public.is_visit_tech(auth.uid(), _visit_id) THEN
    RAISE EXCEPTION 'Not authorized for this visit';
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.visit_photos WHERE visit_id = _visit_id AND kind = 'completion') INTO _has_photo;
  IF NOT _has_photo THEN
    RAISE EXCEPTION 'A completion photo is required before completing this visit';
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
     SET status='completed', completed_at = _when, updated_at = now(),
         completion_source = _source
   WHERE id = _visit_id AND status IN ('scheduled','in_progress','missed');
  IF NOT FOUND THEN RETURN; END IF;

  PERFORM public.finalize_visit_completion(_visit_id);
END;
$function$;

COMMENT ON FUNCTION public.complete_visit(uuid, timestamptz) IS
  'Completes a visit. _completed_at carries the time a QUEUED action was actually performed; it is accepted only if it is in the past, no older than 7 days, and not before started_at, and falls back to now() otherwise. Any replay records completion_source = tech_offline_replay — the time was asserted by a device, not measured here.';

CREATE OR REPLACE FUNCTION public.start_visit(
  _visit_id uuid,
  _started_at timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _when timestamptz := now();
BEGIN
  IF NOT public.is_visit_tech(auth.uid(), _visit_id) THEN
    RAISE EXCEPTION 'Not authorized for this visit';
  END IF;

  -- Same bounds as the completion. A start time matters because completed_at
  -- is validated against it — a replayed start stamped with the sync time
  -- makes a legitimately earlier completion look impossible.
  IF _started_at IS NOT NULL
     AND _started_at <= now()
     AND _started_at >= now() - interval '7 days'
  THEN
    _when := _started_at;
  END IF;

  UPDATE public.visits
     SET status='in_progress',
         started_at = COALESCE(started_at, _when),
         updated_at = now()
   WHERE id = _visit_id AND status IN ('scheduled','in_progress');
END;
$function$;

COMMENT ON FUNCTION public.start_visit(uuid, timestamptz) IS
  'Starts a visit. _started_at carries the time a QUEUED action was actually performed, bounded the same way as complete_visit. COALESCE keeps the first start, so a replay never overwrites a real one.';

-- Postgres overloads on the argument list, so the one-argument originals would
-- survive alongside these — and a `complete_visit(_visit_id)` call then becomes
-- AMBIGUOUS rather than resolving to either ("function is not unique"), because
-- the new second parameter has a default. Caught by the live probe on the
-- unchanged live path, which is the call every online completion makes.
--
-- Same reasoning as dropping the old file_reversal_review_item signature: half
-- the callers on a fixed function and half on the old one is the worst of the
-- three possible outcomes.
DROP FUNCTION IF EXISTS public.complete_visit(uuid);
DROP FUNCTION IF EXISTS public.start_visit(uuid);
