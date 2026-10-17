-- Two grooms for the same groomer cannot overlap, whoever writes the visit.
-- Follows 20261017110000.
--
-- src/lib/groom-clash.server.ts refuses a groom booked, moved or reassigned
-- on top of another for the same groomer, but only in the server, and only
-- after reading what the groomer holds. That leaves three ways through:
--   - two office users saving at once both read a free slot and both write;
--   - redistribute_staff_work (Cover, 20260804210000) hands an out tech's
--     visits round-robin to the rest of the crew without asking about time;
--   - the route planners and any later writer that sets assigned_staff_id.
--
-- 1. zz_visits_groom_no_overlap, BEFORE INSERT OR UPDATE on visits, refuses
--    a fixed-time groom that overlaps another for the same groomer on the
--    same day. "A fixed-time groom" is what refuseGroomMoveClash checks: the
--    visit's service is on the mobile_grooming line, it has a start_time and
--    a duration_min above zero, and its status holds time (scheduled,
--    in_progress, completed; GROOM_BUSY_STATUSES). Its length is
--    duration_min, which already includes the business's groom_buffer_min:
--    booking stores groomHoldMinutes on the plan and visits_groom_plan_stamp
--    copies it onto every visit. Overlap is the same half-open test as
--    groomClashes: each starts before the other ends.
--
--    Before it reads, it takes pg_advisory_xact_lock on the groomer and the
--    day, so two saves for one groomer's day take turns and the second sees
--    what the first committed. Saves for different groomers or days do not
--    wait on each other.
--
--    It raises exclusion_violation (23P01), not check_violation:
--    bulk_reschedule_visits counts a check_violation as "the assignee is off
--    that day" and skips the row under a message about clients already
--    having a visit, which would hide a clash behind the wrong sentence. The
--    message is the first sentence of groomClashRefusal; the server functions
--    that write visits ask groom-clash.server.ts again on 23P01 to add the
--    open start times.
--
--    On UPDATE it checks only when the visit lands somewhere new: groomer,
--    day, start time or service changed, or a status that did not hold time
--    became one that does. Completing a groom, writing an ETA or a photo
--    never trips on two grooms that already overlapped before this file.
--    A changed duration_min alone is not checked, as the server does not
--    check it.
--
--    An unassigned groom is never refused, so the generator (which inserts
--    with no assigned_staff_id) is untouched, and taking a groom off its
--    groomer stays the way out of a clash.
--
-- 2. redistribute_staff_work offers each fixed-time groom to the round-robin
--    pick first and then to each other available tech in turn. A groom that
--    fits nobody stays with the tech it was on, where the board shows it in
--    that tech's lane, and the call still returns. Before this file a clash
--    did not exist for it; with the trigger and no change here, one groom
--    with nowhere to go would have failed the whole Cover.
--
-- Replays into an empty database: two functions created or replaced, one
-- trigger. The check block asserts only what this file creates.

-- ── 1. The guard ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tg_visits_groom_no_overlap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _from integer;
  _to integer;
  _other uuid;
BEGIN
  IF NEW.assigned_staff_id IS NULL
     OR NEW.scheduled_on IS NULL
     OR NEW.start_time IS NULL
     OR COALESCE(NEW.duration_min, 0) <= 0
     OR NEW.status NOT IN ('scheduled', 'in_progress', 'completed') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.assigned_staff_id IS NOT DISTINCT FROM OLD.assigned_staff_id
     AND NEW.scheduled_on IS NOT DISTINCT FROM OLD.scheduled_on
     AND NEW.start_time IS NOT DISTINCT FROM OLD.start_time
     AND NEW.service_id IS NOT DISTINCT FROM OLD.service_id
     AND OLD.status IN ('scheduled', 'in_progress', 'completed') THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.services s
                  WHERE s.id = NEW.service_id AND s.service_line = 'mobile_grooming') THEN
    RETURN NEW;
  END IF;

  -- One groomer's day at a time. Held to the end of the transaction, so a
  -- second save waits here until the first has committed or rolled back.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('groom-overlap:' || NEW.assigned_staff_id::text || ':' || NEW.scheduled_on::text, 0)
  );

  _from := floor(EXTRACT(EPOCH FROM NEW.start_time) / 60)::integer;
  _to := _from + NEW.duration_min;

  SELECT v.id INTO _other
    FROM public.visits v
    JOIN public.services s ON s.id = v.service_id
   WHERE v.assigned_staff_id = NEW.assigned_staff_id
     AND v.scheduled_on = NEW.scheduled_on
     AND v.id <> NEW.id
     AND v.status IN ('scheduled', 'in_progress', 'completed')
     AND v.start_time IS NOT NULL
     AND v.duration_min > 0
     AND s.service_line = 'mobile_grooming'
     AND floor(EXTRACT(EPOCH FROM v.start_time) / 60)::integer < _to
     AND _from < floor(EXTRACT(EPOCH FROM v.start_time) / 60)::integer + v.duration_min
   LIMIT 1;

  IF _other IS NOT NULL THEN
    RAISE EXCEPTION 'This groomer already has a groom at that time on %.', NEW.scheduled_on
      USING ERRCODE = 'exclusion_violation',
            DETAIL = format('Visit %s overlaps visit %s.', NEW.id, _other);
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_visits_groom_no_overlap() FROM PUBLIC, anon, authenticated;

-- Named zz_ so it runs after visits_service and visits_groom_plan_stamp,
-- which fill service_id, start_time and duration_min on insert.
DROP TRIGGER IF EXISTS zz_visits_groom_no_overlap ON public.visits;
CREATE TRIGGER zz_visits_groom_no_overlap
  BEFORE INSERT OR UPDATE OF assigned_staff_id, scheduled_on, start_time, service_id, status
  ON public.visits
  FOR EACH ROW EXECUTE FUNCTION public.tg_visits_groom_no_overlap();

COMMENT ON FUNCTION public.tg_visits_groom_no_overlap() IS
  'Refuses a fixed-time groom that overlaps another groom for the same groomer '
  'on the same day (exclusion_violation). Serialized per groomer and day with '
  'an advisory lock. No-op when unassigned or when the visit did not move.';

-- ── 2. Cover leaves a groom that fits nobody where it was ────────────────
--
-- Body as 20260804210000 left it, except the UPDATE: each candidate is tried
-- in a subtransaction, starting from the round-robin pick, and only the
-- groom guard's exclusion_violation moves on to the next one. Any other
-- error still fails the call, as before.

CREATE OR REPLACE FUNCTION public.redistribute_staff_work(_staff_id uuid, _from date DEFAULT NULL::date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE _org uuid; _others uuid[]; _n int := 0; _v record; _k int; _try int; _placed boolean;
BEGIN
  SELECT organization_id INTO _org FROM public.staff WHERE id = _staff_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'staff not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN RAISE EXCEPTION 'forbidden'; END IF;

  -- Whoever is left that actually runs routes AND is available. Unlike
  -- assignment, availability DOES matter here: the whole point is to move work
  -- to someone who will be in a truck.
  SELECT array_agg(id ORDER BY display_name) INTO _others
    FROM public.staff
   WHERE organization_id = _org
     AND active
     AND is_field_tech
     AND routing_available
     AND id <> _staff_id;

  IF _others IS NULL OR array_length(_others, 1) = 0 THEN
    -- Unassigning would be worse than refusing: the work would vanish from
    -- every lane into a pile nobody owns, on a screen that had just promised
    -- to redistribute it.
    RAISE EXCEPTION 'Nobody else is available to take this work. Add or free up another technician first.';
  END IF;

  -- Round-robin WITHIN each day so one person does not inherit whole days.
  FOR _v IN
    SELECT v.id, v.scheduled_on,
           row_number() OVER (PARTITION BY v.scheduled_on ORDER BY v.sequence NULLS LAST, v.id) AS rn
      FROM public.visits v
     WHERE v.assigned_staff_id = _staff_id
       AND v.scheduled_on >= COALESCE(_from, current_date)
       AND v.status NOT IN ('completed', 'skipped')
     ORDER BY v.scheduled_on, rn
  LOOP
    _k := (_v.rn - 1) % array_length(_others, 1);
    _placed := false;
    FOR _try IN 0 .. array_length(_others, 1) - 1 LOOP
      BEGIN
        UPDATE public.visits
           SET assigned_staff_id = _others[((_k + _try) % array_length(_others, 1)) + 1],
               sequence = NULL,
               eta_start = NULL,
               eta_end = NULL,
               travel_km = NULL,
               travel_min = NULL,
               window_violated = false,
               updated_at = now()
         WHERE id = _v.id;
        _placed := true;
      -- zz_visits_groom_no_overlap: that tech already has a groom then.
      EXCEPTION WHEN exclusion_violation THEN
        NULL;
      END;
      EXIT WHEN _placed;
    END LOOP;
    -- A groom nobody has room for stays on this tech's lane for the office.
    IF _placed THEN _n := _n + 1; END IF;
  END LOOP;

  RETURN _n;
END;
$$;

REVOKE ALL ON FUNCTION public.redistribute_staff_work(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redistribute_staff_work(uuid, date) TO authenticated, service_role;

COMMENT ON FUNCTION public.redistribute_staff_work(uuid, date) IS
  'Moves a tech''s open visits from _from (default today) round-robin to the '
  'other available techs. A fixed-time groom goes to the first of them with '
  'room at that time, and stays where it was when none has. Returns the number moved.';

-- ── What this file establishes, checked from any starting state ──────────

DO $check$
DECLARE _src text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.visits'::regclass AND tgname = 'zz_visits_groom_no_overlap'
       AND tgenabled = 'O' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'zz_visits_groom_no_overlap is missing or disabled';
  END IF;
  IF has_function_privilege('anon', 'public.tg_visits_groom_no_overlap()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tg_visits_groom_no_overlap()', 'EXECUTE') THEN
    RAISE EXCEPTION 'tg_visits_groom_no_overlap is callable with a client key';
  END IF;
  SELECT p.prosrc INTO _src FROM pg_proc p
   WHERE p.oid = 'public.tg_visits_groom_no_overlap()'::regprocedure;
  IF strpos(_src, 'pg_advisory_xact_lock') = 0 THEN
    RAISE EXCEPTION 'tg_visits_groom_no_overlap reads without the per-groomer lock';
  END IF;
  SELECT p.prosrc INTO _src FROM pg_proc p
   WHERE p.oid = 'public.redistribute_staff_work(uuid, date)'::regprocedure;
  IF _src IS NULL OR strpos(_src, 'WHEN exclusion_violation') = 0 THEN
    RAISE EXCEPTION 'redistribute_staff_work fails the whole Cover on one groom with nowhere to go';
  END IF;
END
$check$;
