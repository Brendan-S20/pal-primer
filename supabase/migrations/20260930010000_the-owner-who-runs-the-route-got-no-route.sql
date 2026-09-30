-- The owner who runs the route got no route.
--
-- The commonest HoundStack business is one person: the owner is also the
-- technician. seed_demo_org already knows that — it refuses an organization
-- with no ACTIVE FIELD TECHNICIAN (is_field_tech), and the E2E seed makes the
-- owner exactly that. But the two places that then hand out the visits asked a
-- different question:
--
--   * history went round-robin to `role IN ('tech','dispatcher','office_manager')`
--     — never the owner, whatever is_field_tech says;
--   * today went to the first `role = 'tech'` — nobody, for an owner-operator;
--   * assign_demo_visits_to_staff took "today and forward" from current_date,
--     which is UTC, so from about 7 pm Central it started TOMORROW and today's
--     visits were nobody's too. 20260927030000 fixed the same fault in
--     seed_demo_org and left this one.
--
-- So an owner-operator who pressed Reseed in the evening got a demo in which
-- no visit, past or present, belonged to anyone: an empty My Day and an empty
-- per-tech report. CI found it the same way, at 21:40 Central on 2026-09-29:
-- the re-clean E2E, which needs a completed visit with a technician, reported
-- "107 completed visits (0 assigned)". It had passed on reruns before because
-- whether today's visits were assigned depended on the hour the job ran.
--
-- Every pool is now the active field technicians, a role-'tech' person first
-- where there is one, and "today" is the organization's own day.
--
-- seed_demo_org is ~600 lines and the change is three WHERE clauses, so it is
-- spliced by name against its current body, which raises if the body is not
-- the one this was cut against rather than silently doing nothing.
--
-- Replays into an empty database: both functions exist by this point in the
-- sequence and neither needs a row.

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
  -- The org's calendar day, not the database's UTC one: see the file header.
  today date;
BEGIN
  IF NOT (public.is_platform_admin(auth.uid())
    OR EXISTS (SELECT 1 FROM public.user_roles
                WHERE user_id = auth.uid()
                  AND organization_id = _org_id
                  AND role IN ('owner','office_manager'))) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT (now() AT TIME ZONE COALESCE(o.timezone, 'America/Chicago'))::date
    INTO today
    FROM public.organizations o WHERE o.id = _org_id;
  today := COALESCE(today, (now() AT TIME ZONE 'America/Chicago')::date);

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
       AND scheduled_on >= today
     ORDER BY scheduled_on, eta_start NULLS LAST, id
  LOOP
    UPDATE public.visits
       SET assigned_staff_id = staff_ids[(idx % n) + 1]
     WHERE id = v_id;
    idx := idx + 1;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.assign_demo_visits_to_staff(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_demo_visits_to_staff(uuid) TO authenticated, service_role;

DO $splice$
DECLARE
  _def text;
  _new text;
BEGIN
  _def := pg_get_functiondef('public.seed_demo_org(uuid)'::regprocedure);
  IF strpos(_def, 'role IN (''tech'',''dispatcher'',''office_manager'')') = 0
     AND strpos(_def, 'AND role = ''tech'' AND active') = 0 THEN
    RETURN;  -- already spliced
  END IF;

  -- History: every active field technician, a 'tech' first.
  _new := replace(_def,
    E'   WHERE organization_id = _org_id AND active\n     AND role IN (''tech'',''dispatcher'',''office_manager'');',
    E'   WHERE organization_id = _org_id AND active AND is_field_tech;');
  IF _new = _def THEN
    RAISE EXCEPTION 'seed_demo_org no longer picks its history staff the way this splice expects; re-cut it against the current body.';
  END IF;
  _def := _new;

  -- Today: the first active field technician, a 'tech' where there is one.
  _new := replace(_def,
    E'WHERE organization_id = _org_id AND role = ''tech'' AND active\n                               ORDER BY created_at LIMIT 1)',
    E'WHERE organization_id = _org_id AND active AND is_field_tech\n                               ORDER BY (role = ''tech'') DESC, created_at LIMIT 1)');
  IF _new = _def THEN
    RAISE EXCEPTION 'seed_demo_org no longer picks today''s staff the way this splice expects; re-cut it against the current body.';
  END IF;
  _def := _new;

  _new := replace(_def,
    E'WHERE organization_id = _org_id AND role = ''tech'' AND active);',
    E'WHERE organization_id = _org_id AND active AND is_field_tech);');
  IF _new = _def THEN
    RAISE EXCEPTION 'seed_demo_org no longer guards today''s assignment the way this splice expects; re-cut it against the current body.';
  END IF;

  EXECUTE _new;
END
$splice$;

REVOKE ALL ON FUNCTION public.seed_demo_org(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seed_demo_org(uuid) TO authenticated, service_role;

DO $check$
DECLARE
  _seed text;
  _assign text;
BEGIN
  SELECT prosrc INTO _seed FROM pg_proc WHERE oid = 'public.seed_demo_org(uuid)'::regprocedure;
  SELECT prosrc INTO _assign FROM pg_proc WHERE oid = 'public.assign_demo_visits_to_staff(uuid)'::regprocedure;
  IF _seed ~ 'role IN \(''tech'',''dispatcher'',''office_manager''\)'
     OR _seed ~ 'role = ''tech'' AND active' THEN
    RAISE EXCEPTION 'seed_demo_org still hands visits out by role instead of to field technicians';
  END IF;
  IF (length(_seed) - length(replace(_seed, 'AND active AND is_field_tech', ''))) / length('AND active AND is_field_tech') <> 3 THEN
    RAISE EXCEPTION 'seed_demo_org should pick field technicians in exactly three places';
  END IF;
  IF _assign ~ 'current_date' THEN
    RAISE EXCEPTION 'assign_demo_visits_to_staff still reads the UTC date';
  END IF;
  IF has_function_privilege('anon', 'public.seed_demo_org(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.assign_demo_visits_to_staff(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can reseed an organization';
  END IF;
END
$check$;
