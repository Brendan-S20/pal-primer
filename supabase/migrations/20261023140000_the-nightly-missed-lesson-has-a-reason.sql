-- The nightly sweep marks a past training lesson missed with reason 'other'.
--
-- Until now the sweep wrote no reason. training_lesson_session_rule already
-- charged a session for a missed lesson with no reason, so this changes no
-- count. It records why: the lesson was never recorded, which is not one of
-- the business's own reasons (our_fault, weather, unsafe_conditions), so the
-- lesson uses a session when training_missed_uses_session is on. The office
-- can change the reason with office_mark_visit_missed later.
--
-- Only package lessons get the reason. Other visits keep what they had.
--
-- Same body as 20260717160000, plus skip_reason_code. Replays into an empty
-- database: one function and its grants.

CREATE OR REPLACE FUNCTION public.admin_transition_missed_visits(_org_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _n integer; _tz text; _local_today date;
BEGIN
  SELECT COALESCE(timezone, 'America/Chicago') INTO _tz
    FROM public.organizations WHERE id = _org_id;
  IF _tz IS NULL THEN RETURN 0; END IF;
  -- The org's OWN calendar day, not UTC's. A visit is missed only once the
  -- org's local date has moved strictly past its scheduled day.
  _local_today := (now() AT TIME ZONE _tz)::date;

  UPDATE public.visits
     SET status = 'missed',
         -- A training lesson nobody recorded. Not the business's fault, so
         -- the session rule charges it unless the office says otherwise.
         skip_reason_code = CASE WHEN client_package_id IS NOT NULL
           THEN COALESCE(skip_reason_code, 'other'::public.skip_reason_code)
           ELSE skip_reason_code END,
         eta_start = NULL,
         eta_end = NULL,
         window_violated = false,
         updated_at = now()
   WHERE organization_id = _org_id
     AND status = 'scheduled'
     AND scheduled_on < _local_today
     AND started_at IS NULL;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_transition_missed_visits(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_transition_missed_visits(uuid) TO service_role;

DO $check$
DECLARE _src text;
BEGIN
  SELECT p.prosrc INTO _src FROM pg_proc p
   WHERE p.oid = 'public.admin_transition_missed_visits(uuid)'::regprocedure;
  IF strpos(_src, '''other''::public.skip_reason_code') = 0 THEN
    RAISE EXCEPTION 'admin_transition_missed_visits does not record a reason for a training lesson.';
  END IF;
  IF has_function_privilege('authenticated', 'public.admin_transition_missed_visits(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.admin_transition_missed_visits(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'admin_transition_missed_visits is callable from the API';
  END IF;
END
$check$;
