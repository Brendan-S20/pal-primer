-- #729: a replayed Start older than a day is held to today's rules.
--
-- Brendan, 2026-11-10 8:11 PM ET: "#729: cap at 24 hours."
--
-- start_visit_as believes a queued Start's own time (_started_at) for up to
-- 7 days, and 20261108153100 skips the owner's BLOCK check for a Start whose
-- time is before vaccine_start_rule_set_at, because a tech who really started
-- before the rule existed should not be refused for it. Together those meant
-- that for a week after an owner turned BLOCK on, a Start stamped before that
-- moment went through: a phone offline for six days, or a queued action whose
-- time was simply asserted, started a visit the owner had set to stop.
--
-- The window for THAT decision is now 24 hours. A Start whose asserted time
-- is more than 24 hours old is checked as if it happened now, against the
-- rule as it stands now. A normal offline replay (minutes to hours, the same
-- working day) is honoured exactly as before.
--
-- Deliberately unchanged: the 7-day window for STAMPING started_at. That
-- stamp is what complete_visit validates a replayed completion against
-- (_completed_at >= started_at), so shrinking it would make a legitimate
-- 2-day-old offline start-and-complete pair fall back to the sync time with
-- no safety gain: the safety question is answered by the check below, and a
-- Start the check refuses is never stamped at all. Also unchanged: the
-- direct-write guard (visits_vaccine_start_guard, 20261110140000), which
-- already judges every non-RPC write at now(), and complete_visit, which has
-- no vaccine check of its own (see the PR).
--
-- The body below is 20261108153100's start_visit_as, line for line, with
-- _rule_when added and used in the rule comparison. Grants and comment are
-- restated so this file stands alone. Replays into an empty database: one
-- function, no rows.

CREATE OR REPLACE FUNCTION public.start_visit_as(
  _actor uuid,
  _visit_id uuid,
  _started_at timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _when timestamptz := now();
  _rule_when timestamptz;
  _status text;
  _rule text;
  _rule_set_at timestamptz;
  _missing text;
BEGIN
  IF _actor IS NULL OR NOT public.is_visit_tech(_actor, _visit_id) THEN
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

  -- The time the owner's rule is judged at (#729, capped at 24 hours on
  -- 2026-11-10). A replay from the last day keeps its own time, so a start
  -- made before BLOCK was turned on is honoured; anything older is judged
  -- now, against the rule as it stands now.
  _rule_when := CASE WHEN _when >= now() - interval '24 hours' THEN _when ELSE now() END;

  -- The owner's vaccine Start rule (#729). Only a visit not yet started, and
  -- not a replay of a start made (within the last 24 hours) before the rule
  -- was turned on.
  SELECT v.status::text, o.vaccine_start_rule, o.vaccine_start_rule_set_at
    INTO _status, _rule, _rule_set_at
    FROM public.visits v JOIN public.organizations o ON o.id = v.organization_id
   WHERE v.id = _visit_id;
  IF _status = 'scheduled' AND _rule = 'block'
     AND (_rule_set_at IS NULL OR _rule_when >= _rule_set_at)
  THEN
    SELECT string_agg(m.dog_name || ' (' || m.vaccine || ')', ', ')
      INTO _missing
      FROM public.visit_missing_vaccines_unchecked(_visit_id) m;
    IF _missing IS NOT NULL THEN
      RAISE EXCEPTION 'VACCINE_START_BLOCKED: required vaccine missing or expired: %', _missing
        USING ERRCODE = 'P0001',
              HINT = 'The owner has set a missing vaccine to stop a Start. Update the pet''s vaccine record first.';
    END IF;
  END IF;

  UPDATE public.visits
     SET status='in_progress',
         started_at = COALESCE(started_at, _when),
         updated_at = now()
   WHERE id = _visit_id AND status IN ('scheduled','in_progress');
END;
$function$;

REVOKE ALL ON FUNCTION public.start_visit_as(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_visit_as(uuid, uuid, timestamptz) TO service_role;

COMMENT ON FUNCTION public.start_visit_as(uuid, uuid, timestamptz) IS
  'start_visit with the actor named instead of read from the session. Service role only: the lock-screen hook calls it for the tech its action token names. start_visit is this with auth.uid(). Refuses a scheduled mobile-grooming visit with a missing required vaccine when the owner has set vaccine_start_rule = block (#729). A replayed start is judged at its own time only if that is within the last 24 hours; older, it is judged now.';

-- ── what this file establishes ──────────────────────────────────────────────
DO $check$
DECLARE
  _src text := (SELECT p.prosrc FROM pg_proc p
                 WHERE p.oid = 'public.start_visit_as(uuid, uuid, timestamptz)'::regprocedure);
BEGIN
  IF position('visit_missing_vaccines_unchecked' IN _src) = 0 THEN
    RAISE EXCEPTION 'start_visit_as does not ask the vaccine Start rule';
  END IF;
  IF position('interval ''24 hours''' IN _src) = 0
     OR position('_rule_when >= _rule_set_at' IN _src) = 0 THEN
    RAISE EXCEPTION 'start_visit_as does not cap the replayed-start pass at 24 hours';
  END IF;
  IF position('_when >= _rule_set_at' IN replace(_src, '_rule_when >= _rule_set_at', '')) > 0 THEN
    RAISE EXCEPTION 'start_visit_as still compares the uncapped start time to the rule';
  END IF;
  IF has_function_privilege('authenticated', 'public.start_visit_as(uuid, uuid, timestamptz)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.start_visit_as(uuid, uuid, timestamptz)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.start_visit_as(uuid, uuid, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'start_visit_as grants unexpected access';
  END IF;
END;
$check$;
