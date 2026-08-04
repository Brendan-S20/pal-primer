-- Dispatch could move exactly one visit at a time, by dragging it.
--
-- Reassigning a tech's Tuesday meant fourteen drags. Moving a rained-off day
-- to Thursday meant doing it for every stop. Taking a tech off the roster
-- meant finding their work by eye, one visit at a time, across however many
-- weeks it ran — and nothing told you it was there. The three functions here
-- are the operations that were missing.
--
-- ── THE GUARD THEY ALL SHARE ──────────────────────────────────────────────
--
-- Every one of these takes a caller-supplied ARRAY of visit ids. That is a
-- different threat model from `reassign_visit(one_id)`: a list can mix
-- organizations, and a per-row check that passes for the caller's own rows
-- while quietly skipping the rest would let someone learn which ids exist by
-- watching the count come back short.
--
-- So each resolves the DISTINCT set of organizations across the whole list
-- first and raises unless there is exactly one and the caller may write to it.
-- All-or-nothing, and the error says which case failed. `assert_runs_routes`
-- then applies exactly as it does on the single-visit path — bulk is not a
-- way around the eligibility rule.

-- ── Assign many at once ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.bulk_reassign_visits(_visit_ids uuid[], _staff_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE _org uuid; _org_list uuid[]; _orgs int; _n int;
BEGIN
  IF _visit_ids IS NULL OR array_length(_visit_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  -- array_agg(DISTINCT …), not min(): Postgres has no min() for uuid, and the
  -- first draft of this used one. Both bulk functions raised on that line, and
  -- because the probe wrapped each call in an exception handler, the failure
  -- looked exactly like the guard working — "cross-org: blocked", "dispatcher:
  -- blocked". Two passing assertions, neither of which had run the code they
  -- claimed to test.
  SELECT array_agg(DISTINCT organization_id) INTO _org_list
    FROM public.visits WHERE id = ANY(_visit_ids);
  _orgs := COALESCE(array_length(_org_list, 1), 0);
  _org := _org_list[1];

  IF _orgs = 0 THEN RAISE EXCEPTION 'No such visits'; END IF;
  IF _orgs > 1 THEN RAISE EXCEPTION 'Visits span more than one organization'; END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN RAISE EXCEPTION 'forbidden'; END IF;

  -- Null unassigns, and stays open for the same reason it does on the single
  -- path: it is how work comes OFF someone.
  IF _staff_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.staff WHERE id = _staff_id AND organization_id = _org) THEN
      RAISE EXCEPTION 'staff not in org';
    END IF;
    PERFORM public.assert_runs_routes(_staff_id);
  END IF;

  -- `sequence` is cleared, never guessed. These visits are arriving in a lane
  -- that already has an order; inventing positions here would interleave them
  -- arbitrarily with the stops already there. They land unsequenced and
  -- Optimize (or a drag) puts them in order — which is the honest state:
  -- assigned, not yet routed.
  UPDATE public.visits
     SET assigned_staff_id = _staff_id,
         sequence = NULL,
         eta_start = NULL,
         eta_end = NULL,
         travel_km = NULL,
         travel_min = NULL,
         window_violated = false,
         updated_at = now()
   WHERE id = ANY(_visit_ids)
     -- A finished visit is a record of what happened. Reassigning it would
     -- rewrite history and move revenue between techs after the fact.
     AND status NOT IN ('completed', 'skipped');
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;

COMMENT ON FUNCTION public.bulk_reassign_visits(uuid[], uuid) IS
  'Assign or unassign many visits in one statement. Rejects an id list spanning organizations, enforces assert_runs_routes, and never touches completed or skipped visits.';


-- ── Move many to another day ──────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.bulk_reschedule_visits(uuid[], date);

CREATE OR REPLACE FUNCTION public.bulk_reschedule_visits(_visit_ids uuid[], _to_date date)
RETURNS TABLE(moved integer, skipped integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE _org uuid; _org_list uuid[]; _orgs int; _v record; _moved int := 0; _skipped int := 0;
BEGIN
  IF _visit_ids IS NULL OR array_length(_visit_ids, 1) IS NULL THEN
    moved := 0; skipped := 0; RETURN NEXT; RETURN;
  END IF;
  IF _to_date IS NULL THEN RAISE EXCEPTION 'A date is required'; END IF;

  SELECT array_agg(DISTINCT organization_id) INTO _org_list
    FROM public.visits WHERE id = ANY(_visit_ids);
  _orgs := COALESCE(array_length(_org_list, 1), 0);
  _org := _org_list[1];

  IF _orgs = 0 THEN RAISE EXCEPTION 'No such visits'; END IF;
  IF _orgs > 1 THEN RAISE EXCEPTION 'Visits span more than one organization'; END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN RAISE EXCEPTION 'forbidden'; END IF;

  -- Each row in its own subtransaction, so ONE collision does not abandon the
  -- other forty moves.
  --
  -- `visits` carries UNIQUE(subscription_id, scheduled_on) — a client cannot
  -- get two visits from one plan on one day — and a deep-clean-per-month
  -- index. Moving a weekly client's Tuesday to next Tuesday collides with the
  -- visit already generated there, which is not an error: it is the schedule
  -- being right. Rather than enumerate those constraints here and go stale
  -- when one is added, a unique_violation counts as skipped and the caller is
  -- told the number.
  FOR _v IN
    SELECT id FROM public.visits
     WHERE id = ANY(_visit_ids)
       AND status NOT IN ('completed', 'skipped')
     ORDER BY scheduled_on, sequence NULLS LAST, id
  LOOP
    BEGIN
      UPDATE public.visits
         SET scheduled_on = _to_date,
             -- Only the FIRST time: a visit bounced twice should still point
             -- at the day it was originally promised for, not the last hop.
             rescheduled_from = COALESCE(rescheduled_from, scheduled_on),
             sequence = NULL, eta_start = NULL, eta_end = NULL,
             travel_km = NULL, travel_min = NULL,
             window_violated = false, updated_at = now()
       WHERE id = _v.id;
      _moved := _moved + 1;
    EXCEPTION WHEN unique_violation THEN
      _skipped := _skipped + 1;
    END;
  END LOOP;

  moved := _moved; skipped := _skipped; RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.bulk_reschedule_visits(uuid[], date) IS
  'Move many visits to another date, reporting how many could not move because the client already has a visit from that plan on the target day.';


-- ── Take someone off the roster ───────────────────────────────────────────
--
-- The gap this closes: marking a tech unavailable changed a flag and nothing
-- else. Their assigned work stayed assigned, to someone who is not coming in,
-- and the only way to notice was to open each day and see their lane still
-- full. There was no shift and no re-optimize — the safeguard simply did not
-- exist.
--
-- Deliberately TWO functions rather than one. Silently moving a person's whole
-- schedule the moment a checkbox changes is not a safeguard, it is a surprise:
-- `staff_upcoming_load` answers "what would this affect?" so the app can show
-- it and ask, and `redistribute_staff_work` is what runs after someone says
-- yes.

CREATE OR REPLACE FUNCTION public.staff_upcoming_load(_staff_id uuid, _from date DEFAULT NULL)
RETURNS TABLE(scheduled_on date, visits integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE _org uuid;
BEGIN
  SELECT organization_id INTO _org FROM public.staff WHERE id = _staff_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'staff not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN RAISE EXCEPTION 'forbidden'; END IF;

  RETURN QUERY
  SELECT v.scheduled_on, count(*)::integer
    FROM public.visits v
   WHERE v.assigned_staff_id = _staff_id
     AND v.scheduled_on >= COALESCE(_from, current_date)
     AND v.status NOT IN ('completed', 'skipped')
   GROUP BY v.scheduled_on
   ORDER BY v.scheduled_on;
END;
$$;

COMMENT ON FUNCTION public.staff_upcoming_load(uuid, date) IS
  'What work a tech is still holding, by day. Read by the confirmation shown before redistributing — moving someone''s schedule without showing it first is a surprise, not a safeguard.';


CREATE OR REPLACE FUNCTION public.redistribute_staff_work(_staff_id uuid, _from date DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE _org uuid; _others uuid[]; _n int := 0; _v record; _i int := 0;
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
    UPDATE public.visits
       SET assigned_staff_id = _others[((_v.rn - 1) % array_length(_others, 1)) + 1],
           sequence = NULL,
           eta_start = NULL,
           eta_end = NULL,
           travel_km = NULL,
           travel_min = NULL,
           window_violated = false,
           updated_at = now()
     WHERE id = _v.id;
    _n := _n + 1;
  END LOOP;

  RETURN _n;
END;
$$;

COMMENT ON FUNCTION public.redistribute_staff_work(uuid, date) IS
  'Move a tech''s remaining work to the other available field techs, round-robin within each day. Raises rather than unassigning when nobody is left — work in nobody''s lane is worse than a refusal.';


REVOKE ALL ON FUNCTION public.bulk_reassign_visits(uuid[], uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bulk_reschedule_visits(uuid[], date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_upcoming_load(uuid, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.redistribute_staff_work(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bulk_reassign_visits(uuid[], uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bulk_reschedule_visits(uuid[], date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_upcoming_load(uuid, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.redistribute_staff_work(uuid, date) TO authenticated, service_role;
