-- There was no way to say "Jordan is away next week".
--
-- ── WHAT EXISTED ──────────────────────────────────────────────────────────
--
-- `staff.routing_available` — one boolean, no dates. It says "not in a truck",
-- with no answer to "until when", so a dispatcher setting it on Friday for a
-- holiday starting Monday takes that tech off TODAY'S board as well. And
-- nothing ever turns it back on: somebody has to remember, on the right
-- morning, for each person. A schedule that depends on a human remembering to
-- flip a flag back is a schedule that will be wrong.
--
-- Worse, it does not block anything. `assert_runs_routes` deliberately ignores
-- `routing_available` — that was correct when the flag meant "today" and you
-- still had to be able to schedule tomorrow. It means the nightly generator
-- and every auto-assign happily hand next week's work to somebody the office
-- knows is in another country.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────
--
-- `staff_time_off` — dated ranges, so "away 12–19 August" is a fact with an
-- end. The board reads it per day, which means it needs no cleanup and cannot
-- be left on by accident. `routing_available` stays as the same-day override
-- it always was ("out sick, today, decide later"); the two answer different
-- questions and neither replaces the other.
--
-- Ranges are INCLUSIVE of both ends and MAY overlap. Overlap is not an error:
-- a week of leave with a training day inside it is two true statements, and
-- rejecting the second would make the dispatcher delete and re-enter the
-- first. `is_staff_off` answers with EXISTS, so overlaps are harmless.
--
-- ── WHAT IT BLOCKS, AND WHAT IT DELIBERATELY DOES NOT ─────────────────────
--
-- Assignment TO a day the person is off now raises. That is the safeguard the
-- routes brief asked for — booking work for somebody who is away is never
-- intentional.
--
-- It does NOT retroactively unassign. Recording leave must not silently move
-- forty visits: that is `redistribute_staff_work`, behind the Cover dialog,
-- where the dispatcher sees what is about to move before it does.
-- `staff_time_off_impact` exists so that dialog can say how much work is
-- affected at the moment the leave is entered, rather than after.
--
-- It does NOT block unassigning (`_staff_id IS NULL`), for the same reason
-- `assert_runs_routes` does not: taking work OFF someone who is away is the
-- remedy, and refusing it would strand exactly the rows this exists to clear.

CREATE TABLE IF NOT EXISTS public.staff_time_off (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  staff_id        uuid NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
  starts_on       date NOT NULL,
  ends_on         date NOT NULL,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  CONSTRAINT staff_time_off_range CHECK (ends_on >= starts_on),
  -- A range ending in 2099 is a mistyped year, and it would take that tech off
  -- the board forever with no visible cause. A year is the longest absence
  -- anybody enters as one row; longer than that is a leaver, which is
  -- `staff.active = false`.
  CONSTRAINT staff_time_off_bounded CHECK (ends_on - starts_on <= 366)
);

-- The board asks "is this person off?" once per tech per day drawn. Without
-- this it is a sequential scan of every leave row the org has ever recorded,
-- on every cell of a month view.
CREATE INDEX IF NOT EXISTS staff_time_off_lookup
  ON public.staff_time_off (staff_id, starts_on, ends_on);
CREATE INDEX IF NOT EXISTS staff_time_off_org
  ON public.staff_time_off (organization_id, starts_on);

ALTER TABLE public.staff_time_off ENABLE ROW LEVEL SECURITY;

-- Readable by anyone in the org: a tech needs to see their own leave, and a
-- dispatcher needs to see everyone's to plan around it. There is nothing
-- sensitive in a date range, and hiding it would make the board's "off" badge
-- unexplainable to the person looking at it.
DROP POLICY IF EXISTS staff_time_off_read ON public.staff_time_off;
CREATE POLICY staff_time_off_read ON public.staff_time_off
  FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

-- Writing is manage_users, same as naming somebody a field tech. Deciding who
-- is working is one permission, not two.
DROP POLICY IF EXISTS staff_time_off_write ON public.staff_time_off;
CREATE POLICY staff_time_off_write ON public.staff_time_off
  FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), organization_id, 'manage_users'))
  WITH CHECK (public.has_permission(auth.uid(), organization_id, 'manage_users'));

REVOKE ALL ON public.staff_time_off FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_time_off TO authenticated;

COMMENT ON TABLE public.staff_time_off IS
  'Dated absences. Inclusive of both ends, may overlap. Read per-day by the '
  'route board; blocks assignment to those days via assert_available_on.';

-- ── Is this person off on this date? ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_staff_off(_staff_id uuid, _day date)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.staff_time_off
    WHERE staff_id = _staff_id AND _day BETWEEN starts_on AND ends_on
  );
$$;

COMMENT ON FUNCTION public.is_staff_off(uuid, date) IS
  'True when the staff member has any time-off range covering _day. EXISTS, so '
  'overlapping ranges are harmless.';

-- ── The guard, mirroring assert_runs_routes ───────────────────────────────

CREATE OR REPLACE FUNCTION public.assert_available_on(_staff_id uuid, _day date)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE _name text; _until date;
BEGIN
  -- Unassigning is always allowed. See the header.
  IF _staff_id IS NULL OR _day IS NULL THEN RETURN; END IF;

  SELECT t.ends_on INTO _until
  FROM public.staff_time_off t
  WHERE t.staff_id = _staff_id AND _day BETWEEN t.starts_on AND t.ends_on
  ORDER BY t.ends_on DESC
  LIMIT 1;

  IF _until IS NOT NULL THEN
    SELECT display_name INTO _name FROM public.staff WHERE id = _staff_id;
    -- Name the person and the date they are back. "Staff unavailable" sends
    -- the dispatcher to look it up; this lets them reschedule immediately.
    RAISE EXCEPTION '% is off on % (back %)',
      COALESCE(_name, 'That person'), _day, _until + 1
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.assert_available_on(uuid, date) IS
  'Raises when _staff_id has time off covering _day. No-op for a NULL staff id '
  'so unassigning stays possible.';

-- ── How much work a proposed absence would strand ─────────────────────────
--
-- Called BEFORE the leave is saved, so the dispatcher is told "this covers 23
-- visits over 6 days" while they can still change their mind — rather than
-- discovering it when the board is already wrong.

CREATE OR REPLACE FUNCTION public.staff_time_off_impact(
  _staff_id uuid,
  _from     date,
  _to       date
)
RETURNS TABLE (scheduled_on date, visits bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT v.scheduled_on, count(*)::bigint
  FROM public.visits v
  JOIN public.staff s ON s.id = v.assigned_staff_id
  WHERE v.assigned_staff_id = _staff_id
    AND v.scheduled_on BETWEEN _from AND _to
    -- Completed and skipped visits are history. Counting them would inflate
    -- the number and imply work that needs moving when none does.
    AND v.status NOT IN ('completed', 'skipped')
    AND public.is_org_member(auth.uid(), s.organization_id)
  GROUP BY v.scheduled_on
  ORDER BY v.scheduled_on;
$$;

COMMENT ON FUNCTION public.staff_time_off_impact(uuid, date, date) IS
  'Open visits assigned to _staff_id per day in the range. Feeds the "this will '
  'strand N visits" warning before leave is saved.';

GRANT EXECUTE ON FUNCTION public.is_staff_off(uuid, date)                    TO authenticated;
GRANT EXECUTE ON FUNCTION public.assert_available_on(uuid, date)             TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_time_off_impact(uuid, date, date)     TO authenticated;


-- ── Enforcement: a trigger, not four edits ────────────────────────────────
--
-- `assert_runs_routes` is called from `assign_route_for_day`, `reassign_visit`
-- and `bulk_reassign_visits` — three call sites, added by hand, and a fourth
-- path added later would simply not have it. That is survivable for a flag
-- that changes once a quarter. It is not survivable here, because the paths
-- that assign work are the nightly generator, CSV import, auto-assign,
-- optimize, drag-and-drop, bulk assign, and Cover's redistribution, and every
-- one of them writes `assigned_staff_id`.
--
-- So the guard lives on the column instead. One place, fires for every writer
-- including ones not yet written, and cannot drift out of step with a function
-- body it does not live in.
--
-- Scoped to `UPDATE OF assigned_staff_id, scheduled_on` deliberately: completing
-- a visit, writing an ETA or recording a photo must not be blocked because the
-- tech booked leave for next month. Only the two columns that can put somebody
-- on a day they are away.

CREATE OR REPLACE FUNCTION public.tg_visit_respects_time_off()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Nothing to check when the visit is unassigned, and history is left alone:
  -- a completed visit is a record of what happened, and leave entered
  -- afterwards does not make it untrue.
  IF NEW.assigned_staff_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.status IN ('completed', 'skipped') THEN RETURN NEW; END IF;

  -- On UPDATE, only when the pair actually moves. Re-saving a row that was
  -- already in this state must stay possible, or a visit assigned before the
  -- leave was recorded becomes uneditable — including unassigning it, which is
  -- the remedy.
  IF TG_OP = 'UPDATE'
     AND NEW.assigned_staff_id IS NOT DISTINCT FROM OLD.assigned_staff_id
     AND NEW.scheduled_on      IS NOT DISTINCT FROM OLD.scheduled_on THEN
    RETURN NEW;
  END IF;

  PERFORM public.assert_available_on(NEW.assigned_staff_id, NEW.scheduled_on);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS visits_respect_time_off ON public.visits;
CREATE TRIGGER visits_respect_time_off
  BEFORE INSERT OR UPDATE OF assigned_staff_id, scheduled_on ON public.visits
  FOR EACH ROW EXECUTE FUNCTION public.tg_visit_respects_time_off();

COMMENT ON FUNCTION public.tg_visit_respects_time_off() IS
  'Refuses to place an open visit on a day its assignee has booked off. One '
  'enforcement point for every writer; no-op when unassigned, when the visit is '
  'finished, or when neither column moved.';


-- ── bulk_reschedule_visits: a day off is a skip, not a failure ────────────
--
-- Rewritten only to widen the EXCEPTION clause. It already treats a
-- UNIQUE(subscription_id, scheduled_on) collision as a per-row skip rather
-- than a reason to abandon the other forty moves; the trigger above introduces
-- a second, identical situation — this one row cannot go to that day — and
-- without this it would raise check_violation out of the subtransaction and
-- abort the whole call.
--
-- Body is otherwise byte-identical to the live definition.

CREATE OR REPLACE FUNCTION public.bulk_reschedule_visits(_visit_ids uuid[], _to_date date)
RETURNS TABLE(moved integer, skipped integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
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

  FOR _v IN
    SELECT id FROM public.visits
     WHERE id = ANY(_visit_ids)
       AND status NOT IN ('completed', 'skipped')
     ORDER BY scheduled_on, sequence NULLS LAST, id
  LOOP
    BEGIN
      UPDATE public.visits
         SET scheduled_on = _to_date,
             rescheduled_from = COALESCE(rescheduled_from, scheduled_on),
             sequence = NULL, eta_start = NULL, eta_end = NULL,
             travel_km = NULL, travel_min = NULL,
             window_violated = false, updated_at = now()
       WHERE id = _v.id;
      _moved := _moved + 1;
    -- unique_violation: the client already has a visit that day.
    -- check_violation: the assignee has that day booked off.
    -- Both mean "this one cannot go there", which is a skip.
    EXCEPTION WHEN unique_violation OR check_violation THEN
      _skipped := _skipped + 1;
    END;
  END LOOP;

  moved := _moved; skipped := _skipped; RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.bulk_reschedule_visits(uuid[], date) IS
  'Move many visits to one date. Per-row subtransactions: a date collision or a '
  'day the assignee has off is counted in `skipped`, not raised.';
