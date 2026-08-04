-- `staff.is_field_tech` decides who runs routes. Nothing enforced it.
--
-- ── WHAT WAS OPEN ─────────────────────────────────────────────────────────
--
-- `assign_route_for_day` and `reassign_visit` both check authorization
-- (`can_write_org`) and both check the staff row belongs to the organization.
-- Neither checked whether that person is a field technician. The only thing
-- standing between an office manager and a full day's route was a filter in
-- the browser — `routes.tsx:213`:
--
--     .filter((s) => s.is_field_tech || assignedIds.has(s.id))
--
-- and that filter has an escape hatch. Once someone holds ONE visit they pass
-- it, which earns them a board column, a drag-and-drop drop target, and an
-- entry in the "auto-assign / optimize day for tech" select — from which they
-- can be given unlimited further work. So the state is self-sustaining: one
-- stray assignment is enough, permanently.
--
-- It is reachable without the UI at all. Both functions are RPCs the browser
-- may call directly with the publishable key, and a caller who may write to
-- the org can name any staff id in it.
--
-- ── HOW IT HAPPENS WITHOUT ANYONE DOING ANYTHING WRONG ────────────────────
--
-- `assign_demo_visits_to_staff` round-robins across
-- `role IN ('tech','dispatcher','office_manager')`, ignoring the flag. In the
-- demo organization that put 95 of 149 visits onto a dispatcher and an office
-- manager, both of whom Users & roles correctly reports as not field techs.
-- The same shape arrives via CSV import, or by demoting a tech who already
-- holds work — `tg_staff_field_flag` flips `is_field_tech` to false and the
-- existing assignments simply stay.
--
-- ── WHAT THIS DOES NOT BLOCK ──────────────────────────────────────────────
--
--   * Unassigning. `_staff_id IS NULL` is how you take work off someone, and
--     it is the remedy for rows that predate this check — refusing it would
--     strand exactly the data this exists to clean up.
--
--   * `routing_available = false`. That flag means "not in a truck today"
--     (leave, sick, training) — temporary, and the board deliberately still
--     shows those techs as muted lanes so a dispatcher can see who is out.
--     Blocking assignment on it would break scheduling tomorrow's work for
--     someone who is off today. `is_field_tech` is the durable fact and the
--     only one gated here.
--
--   * Existing rows. This is a check inside two functions, not a table
--     constraint, so the 95 already-assigned visits keep their assignment and
--     stay visible until someone moves them. A constraint would have failed
--     every unrelated write to those rows instead.

CREATE OR REPLACE FUNCTION public.assert_runs_routes(_staff_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE _name text; _is_field boolean;
BEGIN
  SELECT display_name, is_field_tech INTO _name, _is_field
    FROM public.staff WHERE id = _staff_id;
  IF _is_field IS NULL THEN
    RAISE EXCEPTION 'staff not found';
  END IF;
  IF NOT _is_field THEN
    -- Named, because the caller is a dispatcher looking at a board and the
    -- fix is one checkbox away on a screen they may not know exists.
    RAISE EXCEPTION
      '% is not set up to run routes. Turn on "Runs routes" for them in Settings → Team → Users & roles first.',
      COALESCE(_name, 'That person');
  END IF;
END;
$$;

COMMENT ON FUNCTION public.assert_runs_routes(uuid) IS
  'Raises unless the staff member is a field technician. The server-side half of routing eligibility — the browser filter was the only gate, and it let anyone through who already held a single visit.';

REVOKE ALL ON FUNCTION public.assert_runs_routes(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assert_runs_routes(uuid) TO authenticated, service_role;


-- ── assign_route_for_day ──────────────────────────────────────────────────
--
-- Restated in full from the live definition rather than patched, so the body
-- here is the body that runs. Only the eligibility check is new.

CREATE OR REPLACE FUNCTION public.assign_route_for_day(_org_id uuid, _staff_id uuid, _day date, _reassign boolean DEFAULT false)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _v record;
  _seq integer := 0;
BEGIN
  IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized to assign routes for this organization';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.staff WHERE id = _staff_id AND organization_id = _org_id
  ) THEN
    RAISE EXCEPTION 'Staff not in organization';
  END IF;

  -- NEW. After the org check, so "not in this organization" still wins and we
  -- never disclose the name of a staff member in another tenant.
  PERFORM public.assert_runs_routes(_staff_id);

  FOR _v IN
    SELECT v.id
      FROM public.visits v
      LEFT JOIN public.zones z ON z.id = v.zone_id
      LEFT JOIN public.properties p ON p.id = v.property_id
     WHERE v.organization_id = _org_id
       AND v.scheduled_on = _day
       AND v.status = 'scheduled'
       AND (_reassign OR v.assigned_staff_id IS NULL)
     ORDER BY COALESCE(z.postal_prefix, ''), COALESCE(p.postal_code, ''), v.created_at
  LOOP
    _seq := _seq + 1;
    UPDATE public.visits
       SET assigned_staff_id = _staff_id,
           sequence = _seq,
           -- Reset stale routing metrics from any prior tech/optimize run.
           eta_start = NULL,
           eta_end = NULL,
           travel_km = NULL,
           travel_min = NULL,
           window_violated = false
     WHERE id = _v.id;
  END LOOP;

  RETURN _seq;
END;
$function$;


-- ── reassign_visit ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.reassign_visit(_visit_id uuid, _staff_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.visits WHERE id = _visit_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'visit not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), v_org) THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF _staff_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.staff WHERE id = _staff_id AND organization_id = v_org) THEN
    RAISE EXCEPTION 'staff not in org';
  END IF;
  -- NEW. Null is the unassign path and stays open — see the header.
  IF _staff_id IS NOT NULL THEN
    PERFORM public.assert_runs_routes(_staff_id);
  END IF;
  UPDATE public.visits SET assigned_staff_id = _staff_id, sequence = NULL, updated_at = now() WHERE id = _visit_id;
END;
$function$;


-- ── assign_demo_visits_to_staff ───────────────────────────────────────────
--
-- The seeder that produced the 95 rows. It spread work across every non-owner
-- role, which made the demo contradict itself: Users & roles showed one field
-- tech while the schedule showed three people running routes. Now it uses the
-- same definition of "runs routes" as everything else, and raises rather than
-- silently seeding nothing if an org has no field techs at all.

CREATE OR REPLACE FUNCTION public.assign_demo_visits_to_staff(_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  staff_ids uuid[];
  v_id uuid;
  idx int := 0;
  n int;
BEGIN
  IF NOT (public.is_platform_admin(auth.uid())
    OR EXISTS (SELECT 1 FROM public.user_roles
                WHERE user_id = auth.uid()
                  AND organization_id = _org_id
                  AND role IN ('owner','office_manager'))) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT array_agg(id ORDER BY display_name)
    INTO staff_ids
  FROM public.staff
  WHERE organization_id = _org_id
    AND active
    AND is_field_tech;

  IF staff_ids IS NULL OR array_length(staff_ids, 1) = 0 THEN
    -- Loudly. Returning quietly is what let the previous version's output go
    -- unexamined: a demo with no routes looks like a demo that has not loaded.
    RAISE EXCEPTION 'No active field technicians in this organization — add someone who runs routes before seeding visits.';
  END IF;
  n := array_length(staff_ids, 1);

  FOR v_id IN
    SELECT id FROM public.visits
     WHERE organization_id = _org_id
       AND scheduled_on >= current_date
     ORDER BY scheduled_on, eta_start NULLS LAST, id
  LOOP
    UPDATE public.visits
       SET assigned_staff_id = staff_ids[(idx % n) + 1]
     WHERE id = v_id;
    idx := idx + 1;
  END LOOP;
END;
$function$;
