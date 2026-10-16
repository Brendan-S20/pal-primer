-- Group walks link independently billed visits. Solo plans and generation stay unchanged.
-- apply_route_plan is restated near the end so a group's walk is timed once (see there).
ALTER TABLE public.services ADD COLUMN IF NOT EXISTS max_dogs integer;
ALTER TABLE public.services DROP CONSTRAINT IF EXISTS services_max_dogs_check;
ALTER TABLE public.services ADD CONSTRAINT services_max_dogs_check
  CHECK (max_dogs IS NULL OR (max_dogs BETWEEN 1 AND 50 AND service_line = 'dog_walking'));
COMMENT ON COLUMN public.services.max_dogs IS
  'Maximum dogs in a group walk, from 1 to 50. NULL means this is not a group walk service.';

CREATE TABLE IF NOT EXISTS public.walk_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES public.services(id),
  scheduled_on date NOT NULL,
  assigned_staff_id uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  earliest_time time,
  latest_time time,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 500),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT walk_groups_window_check CHECK (
    earliest_time IS NULL OR latest_time IS NULL OR earliest_time < latest_time
  )
);
CREATE INDEX IF NOT EXISTS walk_groups_org_day_idx ON public.walk_groups(organization_id, scheduled_on);
CREATE INDEX IF NOT EXISTS walk_groups_service_idx ON public.walk_groups(service_id);
CREATE INDEX IF NOT EXISTS walk_groups_staff_idx ON public.walk_groups(assigned_staff_id);
ALTER TABLE public.walk_groups ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.walk_groups');
DROP POLICY IF EXISTS "Members read walk groups" ON public.walk_groups;
CREATE POLICY "Members read walk groups" ON public.walk_groups FOR SELECT TO authenticated
  USING (public.is_org_member((SELECT auth.uid()), organization_id));
DROP POLICY IF EXISTS "Office inserts walk groups" ON public.walk_groups;
CREATE POLICY "Office inserts walk groups" ON public.walk_groups FOR INSERT TO authenticated
  WITH CHECK (public.can_write_org((SELECT auth.uid()), organization_id));
DROP POLICY IF EXISTS "Office updates walk groups" ON public.walk_groups;
CREATE POLICY "Office updates walk groups" ON public.walk_groups FOR UPDATE TO authenticated
  USING (public.can_write_org((SELECT auth.uid()), organization_id))
  WITH CHECK (public.can_write_org((SELECT auth.uid()), organization_id));
DROP POLICY IF EXISTS "Office deletes walk groups" ON public.walk_groups;
CREATE POLICY "Office deletes walk groups" ON public.walk_groups FOR DELETE TO authenticated
  USING (public.can_write_org((SELECT auth.uid()), organization_id));
REVOKE ALL ON TABLE public.walk_groups FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.walk_groups TO authenticated, service_role;

ALTER TABLE public.visits ADD COLUMN IF NOT EXISTS walk_group_id uuid
  REFERENCES public.walk_groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS visits_walk_group_idx ON public.visits(walk_group_id);

CREATE OR REPLACE FUNCTION public.validate_walk_group()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.services s WHERE s.id = NEW.service_id
      AND s.organization_id = NEW.organization_id
      AND s.service_line = 'dog_walking' AND s.max_dogs IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Choose a group walk service. Set its group size in Settings > Services.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.assigned_staff_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.staff s WHERE s.id = NEW.assigned_staff_id
      AND s.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Choose a walker from this business.' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (
      NEW.organization_id IS DISTINCT FROM OLD.organization_id
      OR NEW.scheduled_on IS DISTINCT FROM OLD.scheduled_on
      OR NEW.service_id IS DISTINCT FROM OLD.service_id
    ) AND EXISTS (SELECT 1 FROM public.visits v WHERE v.walk_group_id = OLD.id) THEN
      RAISE EXCEPTION 'Remove the walks before changing the group day or service.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.validate_walk_group() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS walk_groups_validate ON public.walk_groups;
CREATE TRIGGER walk_groups_validate BEFORE INSERT OR UPDATE ON public.walk_groups
  FOR EACH ROW EXECUTE FUNCTION public.validate_walk_group();

CREATE OR REPLACE FUNCTION public.walk_dogs_on_visit(_visit_id uuid)
RETURNS integer LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT greatest(coalesce(
    s.dog_count,
    (SELECT count(*)::integer FROM public.dogs d WHERE d.property_id = v.property_id AND d.active),
    1), 1)
  FROM public.visits v LEFT JOIN public.subscriptions s ON s.id = v.subscription_id
  WHERE v.id = _visit_id;
$function$;
REVOKE ALL ON FUNCTION public.walk_dogs_on_visit(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.walk_dogs_on_visit(uuid) TO authenticated, service_role;

-- A member that changes underneath its group leaves the group rather than
-- failing the change. Moving a walk to another day (reschedule, bulk move,
-- weather move, portal reschedule) or to another service detaches it, and so
-- does skipping or canceling it, which frees its place. Its walker stays as it
-- is; the office can reassign. A completed member stays in the group as
-- history but no longer counts toward capacity. Choosing a group that does not
-- fit (on INSERT, or by setting walk_group_id) is still refused.
CREATE OR REPLACE FUNCTION public.validate_walk_group_member()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _group public.walk_groups%ROWTYPE;
  _capacity integer;
  _dogs integer;
  _total integer;
  _kept boolean := false;
BEGIN
  IF NEW.walk_group_id IS NULL THEN RETURN NEW; END IF;
  -- The row keeps the group it had: something else about the visit changed.
  IF TG_OP = 'UPDATE' THEN
    _kept := NEW.walk_group_id IS NOT DISTINCT FROM OLD.walk_group_id;
  END IF;
  IF _kept THEN
    IF NEW.status IN ('skipped', 'canceled') THEN
      NEW.walk_group_id := NULL;
      RETURN NEW;
    END IF;
    SELECT * INTO _group FROM public.walk_groups WHERE id = NEW.walk_group_id;
    IF NOT FOUND OR NEW.organization_id IS DISTINCT FROM _group.organization_id
      OR NEW.scheduled_on IS DISTINCT FROM _group.scheduled_on
      OR NEW.service_id IS DISTINCT FROM _group.service_id THEN
      NEW.walk_group_id := NULL;
      RETURN NEW;
    END IF;
    -- Only a new plan can change the dog count. A status change (started,
    -- completed, reopened) keeps the place the walk already had.
    IF NEW.status NOT IN ('scheduled', 'in_progress')
      OR NEW.subscription_id IS NOT DISTINCT FROM OLD.subscription_id THEN
      RETURN NEW;
    END IF;
  END IF;
  -- Serialize joins to the same group before reading its members.
  SELECT * INTO _group FROM public.walk_groups WHERE id = NEW.walk_group_id FOR UPDATE;
  IF NOT FOUND OR NEW.organization_id IS DISTINCT FROM _group.organization_id
    OR NEW.scheduled_on IS DISTINCT FROM _group.scheduled_on
    OR NEW.service_id IS DISTINCT FROM _group.service_id
    OR NEW.status IN ('canceled', 'skipped', 'completed') THEN
    RAISE EXCEPTION 'That walk is on another day or for another service.'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT max_dogs INTO _capacity FROM public.services WHERE id = _group.service_id;
  IF _capacity IS NULL THEN
    RAISE EXCEPTION 'Choose a group walk service. Set its group size in Settings > Services.'
      USING ERRCODE = 'check_violation';
  END IF;
  -- NEW is not visible to walk_dogs_on_visit on INSERT. Read its plan and property directly.
  SELECT greatest(coalesce(
    (SELECT s.dog_count FROM public.subscriptions s WHERE s.id = NEW.subscription_id),
    (SELECT count(*)::integer FROM public.dogs d WHERE d.property_id = NEW.property_id AND d.active),
    1), 1) INTO _dogs;
  -- Only walks still to happen hold a place. Skipping or canceling already
  -- detaches a member (above); the status filter is the second guard.
  SELECT coalesce(sum(public.walk_dogs_on_visit(v.id)), 0)::integer + _dogs INTO _total
    FROM public.visits v WHERE v.walk_group_id = NEW.walk_group_id AND v.id <> NEW.id
      AND v.status IN ('scheduled', 'in_progress');
  IF _total > _capacity THEN
    RAISE EXCEPTION 'This group walk is full: % of % dogs.', _total, _capacity
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.visits v
    WHERE v.walk_group_id = NEW.walk_group_id AND v.id <> NEW.id
      AND v.status IN ('scheduled', 'in_progress')
      AND v.client_id <> NEW.client_id
      AND (
        EXISTS (SELECT 1 FROM public.dogs d WHERE d.property_id = NEW.property_id
          AND d.active AND d.temperament = 'aggressive')
        OR EXISTS (SELECT 1 FROM public.dogs d WHERE d.property_id = v.property_id
          AND d.active AND d.temperament = 'aggressive')
      )
  ) THEN
    RAISE EXCEPTION 'A dog marked aggressive walks alone. Book a solo walk instead.'
      USING ERRCODE = 'check_violation';
  END IF;
  -- A walk joining the group takes its walker. One already in it keeps
  -- whoever it has, so a plan change does not undo the office's reassignment.
  IF NOT _kept AND _group.assigned_staff_id IS NOT NULL THEN
    NEW.assigned_staff_id := _group.assigned_staff_id;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.validate_walk_group_member() FROM PUBLIC, anon, authenticated;
-- status and organization_id are listed so a skip, a cancel or a move between
-- businesses reaches the detach above. A column trigger fires on the columns
-- the statement names, so visits_guard_walk_group (UPDATE OF walk_group_id)
-- does not fire when this trigger clears walk_group_id: a tech who skips a
-- grouped walk is not refused for a change the database made.
DROP TRIGGER IF EXISTS visits_validate_walk_group ON public.visits;
CREATE TRIGGER visits_validate_walk_group
  BEFORE INSERT OR UPDATE OF walk_group_id, scheduled_on, service_id, subscription_id, status, organization_id
  ON public.visits
  FOR EACH ROW EXECUTE FUNCTION public.validate_walk_group_member();

CREATE OR REPLACE FUNCTION public.copy_walk_group_walker()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.visits SET assigned_staff_id = NEW.assigned_staff_id, sequence = NULL
    WHERE walk_group_id = NEW.id AND status = 'scheduled';
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.copy_walk_group_walker() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS walk_groups_copy_walker ON public.walk_groups;
CREATE TRIGGER walk_groups_copy_walker AFTER UPDATE OF assigned_staff_id ON public.walk_groups
  FOR EACH ROW WHEN (OLD.assigned_staff_id IS DISTINCT FROM NEW.assigned_staff_id)
  EXECUTE FUNCTION public.copy_walk_group_walker();

CREATE OR REPLACE FUNCTION public.guard_visit_walk_group()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL
    AND NOT public.can_write_org(auth.uid(), OLD.organization_id)
    AND NEW.walk_group_id IS DISTINCT FROM OLD.walk_group_id THEN
    RAISE EXCEPTION 'Not authorized to change the group on a visit.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.guard_visit_walk_group() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS visits_guard_walk_group ON public.visits;
CREATE TRIGGER visits_guard_walk_group BEFORE UPDATE OF walk_group_id ON public.visits
  FOR EACH ROW EXECUTE FUNCTION public.guard_visit_walk_group();

-- ── A group walk is timed as one walk ───────────────────────────────────
--
-- The planner (collapseWalkGroups, src/lib/route-inputs.ts) plans a group's
-- members as one stop and hands them back consecutively. apply_route_plan
-- times the day itself, so it has to time a group the same way or the saved
-- ETAs and the day summary count the walk once per dog. For each group with
-- two or more members on one route, in the order the clock replays them:
--
--   every member     _pickup_min at the door, reached by the usual leg
--   the last member  also the walk, once, and the drive back past each door
--                    to hand the dogs over, after which the clock resumes
--                    from the first member's door
--   the first member carries the window: the group's own when it has one,
--                    otherwise the overlap of the members' windows. The others
--                    take its late and early flags.
--
-- A group with one member on the route is timed as a solo walk.
--
-- The body is 20261010200000's, copied verbatim and edited only where it
-- reads a stop's minutes, window or position: the _arp_grp table and its
-- fill, the three CASE/COALESCE reads in the clock's query, the resume after
-- a group's last member, the flags copied from each group's first member, and
-- the summary's service minutes. Signature and grants are restated as they were.
CREATE OR REPLACE FUNCTION public.apply_route_plan(
  _org_id uuid, _staff_ids uuid[], _day date, _reassign boolean,
  _routes jsonb, _honour_windows boolean DEFAULT true,
  _unassigned uuid[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _eligible uuid[];
  _left uuid[] := COALESCE(_unassigned, '{}'::uuid[]);
  _tz text; _workday_start time;
  _day_start_ts timestamptz;
  _s uuid; _vids uuid[];
  _start_lat double precision; _start_lon double precision;
  _cur_lat double precision; _cur_lon double precision;
  _clock timestamptz;
  _r record;
  _seq int;
  _drive numeric; _tkm numeric;
  _es timestamptz; _ee timestamptz;
  _earliest_ts timestamptz; _latest_ts timestamptz;
  _bad text;
  _summary jsonb;
  _misses jsonb;
  -- GROUP_PICKUP_MIN in src/lib/route-inputs.ts.
  _pickup_min CONSTANT integer := 3;
BEGIN
  IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized to plan routes for this organization';
  END IF;
  IF _staff_ids IS NULL OR COALESCE(array_length(_staff_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'Select at least one technician to route';
  END IF;
  _eligible := public.routable_staff(_org_id, _staff_ids, _day);
  IF COALESCE(array_length(_eligible, 1), 0) = 0 THEN
    RAISE EXCEPTION 'None of the selected people can be routed on %: check "Runs routes" and time off', _day;
  END IF;
  IF _routes IS NULL OR jsonb_typeof(_routes) <> 'array' THEN
    RAISE EXCEPTION 'A plan is a list of routes';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _arp_in (sid uuid, vid uuid, ord int) ON COMMIT DROP;
  DELETE FROM _arp_in WHERE true;
  INSERT INTO _arp_in (sid, vid, ord)
  SELECT (r->>'staff_id')::uuid, x.vid::uuid, x.ord::int
    FROM jsonb_array_elements(_routes) r
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(r->'visit_ids', '[]'::jsonb))
         WITH ORDINALITY AS x(vid, ord);

  -- Only people who can run today.
  SELECT string_agg(DISTINCT a.sid::text, ', ') INTO _bad
    FROM _arp_in a WHERE NOT (a.sid = ANY(_eligible));
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'The plan routes someone who cannot be routed on %: %', _day, _bad;
  END IF;

  -- Each stop once.
  IF EXISTS (SELECT 1 FROM _arp_in GROUP BY vid HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'The plan visits a stop twice';
  END IF;

  -- A stop is routed or left out, not both.
  IF EXISTS (SELECT 1 FROM _arp_in a WHERE a.vid = ANY(_left)) THEN
    RAISE EXCEPTION 'The plan both routes a stop and leaves it unassigned';
  END IF;

  -- Exactly the stops in play, as route_day_inputs read them: every one
  -- either on a route or in the unassigned list, and nothing else. Anything
  -- else means the day changed between the read and this write (a visit
  -- added, cancelled, reassigned by hand), and a plan for a different day is
  -- not written over this one.
  IF EXISTS (
       SELECT 1 FROM public.visits v
        WHERE v.organization_id = _org_id AND v.scheduled_on = _day
          AND v.status = 'scheduled'
          AND (v.assigned_staff_id IS NULL OR v.assigned_staff_id = ANY(_eligible))
          AND NOT (v.id = ANY(_left))
          AND NOT EXISTS (SELECT 1 FROM _arp_in a WHERE a.vid = v.id))
     OR EXISTS (
       SELECT 1 FROM (SELECT a.vid FROM _arp_in a UNION ALL SELECT u FROM unnest(_left) u) x
        WHERE NOT EXISTS (
          SELECT 1 FROM public.visits v
           WHERE v.id = x.vid AND v.organization_id = _org_id AND v.scheduled_on = _day
             AND v.status = 'scheduled'
             AND (v.assigned_staff_id IS NULL OR v.assigned_staff_id = ANY(_eligible)))) THEN
    RAISE EXCEPTION 'The day changed while it was being planned. Run auto-routing again.';
  END IF;

  -- Without reassign, what was already somebody's stays theirs.
  IF NOT COALESCE(_reassign, false) AND EXISTS (
       SELECT 1 FROM _arp_in a JOIN public.visits v ON v.id = a.vid
        WHERE v.assigned_staff_id IS NOT NULL AND v.assigned_staff_id <> a.sid) THEN
    RAISE EXCEPTION 'The plan moves a stop between technicians without permission to reassign';
  END IF;

  SELECT COALESCE(o.timezone, 'America/Chicago'), o.workday_start
    INTO _tz, _workday_start
    FROM public.organizations o WHERE o.id = _org_id;
  _day_start_ts := (_day + COALESCE(_workday_start, TIME '08:00')) AT TIME ZONE _tz;

  CREATE TEMP TABLE IF NOT EXISTS _arp_out (
    sid uuid, vid uuid, s_no int, e_start timestamptz, e_end timestamptz,
    t_km numeric, t_min numeric, w_viol boolean, early boolean,
    earliest_ts timestamptz, latest_ts timestamptz
  ) ON COMMIT DROP;
  DELETE FROM _arp_out WHERE true;

  -- Group walk members on each route, as the header above describes. n and
  -- size count in the clock's own order (located stops first, then the plan's).
  CREATE TEMP TABLE IF NOT EXISTS _arp_grp (
    sid uuid, gid uuid, vid uuid, n int, size int, svc int,
    earliest time, latest time,
    resume_lat double precision, resume_lon double precision
  ) ON COMMIT DROP;
  DELETE FROM _arp_grp WHERE true;
  INSERT INTO _arp_grp (sid, gid, vid, n, size, svc, earliest, latest, resume_lat, resume_lon)
  WITH m AS (
    SELECT a.sid, v.walk_group_id AS gid, a.vid,
           p.latitude AS lat, p.longitude AS lon,
           public.stop_service_min(sv.default_duration_min, p.service_duration_min) AS walk,
           CASE WHEN s.earliest_time IS NOT NULL OR s.latest_time IS NOT NULL
                THEN s.earliest_time ELSE p.earliest_service_time END AS earliest,
           CASE WHEN s.earliest_time IS NOT NULL OR s.latest_time IS NOT NULL
                THEN s.latest_time ELSE p.latest_service_time END AS latest,
           g.earliest_time AS g_earliest, g.latest_time AS g_latest,
           row_number() OVER w AS n,
           count(*) OVER (PARTITION BY a.sid, v.walk_group_id) AS size,
           lag(p.latitude) OVER w AS prev_lat,
           lag(p.longitude) OVER w AS prev_lon
      FROM _arp_in a
      JOIN public.visits v ON v.id = a.vid
      JOIN public.walk_groups g ON g.id = v.walk_group_id
      LEFT JOIN public.properties p ON p.id = v.property_id
      LEFT JOIN public.subscriptions s ON s.id = v.subscription_id
      LEFT JOIN public.services sv ON sv.id = v.service_id
    WINDOW w AS (PARTITION BY a.sid, v.walk_group_id
                 ORDER BY (p.latitude IS NULL OR p.longitude IS NULL), a.ord)
  ),
  k AS (
    -- The drive from this door back to the one collected before it, which
    -- the hand-back covers in reverse.
    SELECT m.*,
           CASE WHEN m.lat IS NOT NULL AND m.lon IS NOT NULL
                 AND m.prev_lat IS NOT NULL AND m.prev_lon IS NOT NULL
                THEN COALESCE(public.drive_minutes(_org_id, m.lat, m.lon, m.prev_lat, m.prev_lon), 0)::int
                ELSE 0 END AS back
      FROM m WHERE m.size > 1
  ),
  grp AS (
    SELECT k.sid, k.gid,
           max(k.walk) AS walk,
           sum(k.back)::int AS hand_back,
           bool_or(k.g_earliest IS NOT NULL OR k.g_latest IS NOT NULL) AS own_window,
           max(k.g_earliest) AS g_earliest, max(k.g_latest) AS g_latest,
           max(k.earliest) AS overlap_earliest, min(k.latest) AS overlap_latest,
           max(k.lat) FILTER (WHERE k.n = 1) AS head_lat,
           max(k.lon) FILTER (WHERE k.n = 1) AS head_lon
      FROM k GROUP BY k.sid, k.gid
  )
  SELECT k.sid, k.gid, k.vid, k.n::int, k.size::int,
         _pickup_min + CASE WHEN k.n = k.size THEN grp.walk + grp.hand_back ELSE 0 END,
         CASE WHEN k.n = 1 THEN
           CASE WHEN grp.own_window THEN grp.g_earliest ELSE grp.overlap_earliest END END,
         CASE WHEN k.n = 1 THEN
           CASE WHEN grp.own_window THEN grp.g_latest ELSE grp.overlap_latest END END,
         CASE WHEN k.n = k.size THEN grp.head_lat END,
         CASE WHEN k.n = k.size THEN grp.head_lon END
    FROM k JOIN grp ON grp.sid = k.sid AND grp.gid = k.gid;

  -- The clock, replayed as plan_visits' final pass replays it: from the
  -- start staff_start_point gives for THIS set of stops, each leg by
  -- drive_minutes rounded to a whole minute, the service duration on site,
  -- and stops with no location last (a NULL leg costs nothing, so anywhere
  -- else they hide the drive around them).
  FOREACH _s IN ARRAY _eligible LOOP
    _vids := ARRAY(SELECT a.vid FROM _arp_in a WHERE a.sid = _s ORDER BY a.ord);
    CONTINUE WHEN COALESCE(array_length(_vids, 1), 0) = 0;

    SELECT sp.lat, sp.lon INTO _start_lat, _start_lon
      FROM public.staff_start_point(_org_id, _s, _day, _vids) sp;
    _cur_lat := _start_lat; _cur_lon := _start_lon;
    _clock := _day_start_ts;
    _seq := 0;

    FOR _r IN
      SELECT a.vid, p.latitude AS lat, p.longitude AS lon,
             COALESCE(gm.svc, public.stop_service_min(sv.default_duration_min, p.service_duration_min)) AS svc,
             CASE WHEN gm.vid IS NOT NULL THEN gm.earliest
                  WHEN s.earliest_time IS NOT NULL OR s.latest_time IS NOT NULL
                  THEN s.earliest_time ELSE p.earliest_service_time END AS earliest,
             CASE WHEN gm.vid IS NOT NULL THEN gm.latest
                  WHEN s.earliest_time IS NOT NULL OR s.latest_time IS NOT NULL
                  THEN s.latest_time ELSE p.latest_service_time END AS latest,
             gm.resume_lat, gm.resume_lon
        FROM _arp_in a
        JOIN public.visits v ON v.id = a.vid
        LEFT JOIN public.properties p ON p.id = v.property_id
        LEFT JOIN public.subscriptions s ON s.id = v.subscription_id
        LEFT JOIN public.services sv ON sv.id = v.service_id
        LEFT JOIN _arp_grp gm ON gm.vid = a.vid
       WHERE a.sid = _s
       ORDER BY (p.latitude IS NULL OR p.longitude IS NULL), a.ord
    LOOP
      _drive := COALESCE(public.drive_minutes(_org_id, _cur_lat, _cur_lon, _r.lat, _r.lon), 0);
      _tkm := COALESCE(public.road_km(_org_id, _cur_lat, _cur_lon, _r.lat, _r.lon), 0);
      _es := _clock + make_interval(mins => _drive::int);
      _earliest_ts := CASE WHEN _r.earliest IS NOT NULL THEN (_day + _r.earliest) AT TIME ZONE _tz END;
      _latest_ts   := CASE WHEN _r.latest   IS NOT NULL THEN (_day + _r.latest)   AT TIME ZONE _tz END;
      IF COALESCE(_honour_windows, true) AND _earliest_ts IS NOT NULL AND _es < _earliest_ts THEN
        _es := _earliest_ts;
      END IF;
      _ee := _es + make_interval(mins => _r.svc);
      _seq := _seq + 1;

      INSERT INTO _arp_out VALUES (
        _s, _r.vid, _seq, _es, _ee, _tkm, _drive,
        (_latest_ts IS NOT NULL AND _es > _latest_ts),
        (_earliest_ts IS NOT NULL AND _es < _earliest_ts),
        _earliest_ts, _latest_ts);

      _clock := _ee;
      IF _r.lat IS NOT NULL AND _r.lon IS NOT NULL THEN
        _cur_lat := _r.lat; _cur_lon := _r.lon;
      END IF;
      -- After the last dog is handed back the walker is at the first door.
      IF _r.resume_lat IS NOT NULL AND _r.resume_lon IS NOT NULL THEN
        _cur_lat := _r.resume_lat; _cur_lon := _r.resume_lon;
      END IF;
    END LOOP;
  END LOOP;

  -- Every member of a group walk keeps the window its first member kept.
  UPDATE _arp_out o
     SET w_viol = h.w_viol, early = h.early,
         earliest_ts = h.earliest_ts, latest_ts = h.latest_ts
    FROM _arp_grp gm
    JOIN _arp_grp gh ON gh.sid = gm.sid AND gh.gid = gm.gid AND gh.n = 1
    JOIN _arp_out h ON h.vid = gh.vid
   WHERE o.vid = gm.vid AND gm.n > 1;

  -- The statement that changes a customer's day, column for column what
  -- plan_day_across_staff writes.
  UPDATE public.visits v
     SET assigned_staff_id = w.sid,
         sequence          = w.s_no,
         eta_start         = w.e_start,
         eta_end           = w.e_end,
         travel_km         = LEAST(w.t_km, 9999.99),
         travel_min        = LEAST(w.t_min, 99999.9),
         window_violated   = w.w_viol,
         updated_at        = now()
    FROM _arp_out w
   WHERE v.id = w.vid;

  -- And the stops the plan leaves out: on no route, at no time. With reassign
  -- they come off their technician too, since every other stop of theirs
  -- was just given out again; without it the assignment stands and only the
  -- order and the times are cleared.
  UPDATE public.visits v
     SET assigned_staff_id = CASE WHEN COALESCE(_reassign, false) THEN NULL ELSE v.assigned_staff_id END,
         sequence          = NULL,
         eta_start         = NULL,
         eta_end           = NULL,
         travel_km         = NULL,
         travel_min        = NULL,
         window_violated   = false,
         updated_at        = now()
   WHERE v.id = ANY(_left);

  -- The per-person summary plan_day_across_staff returns, plus the count of
  -- late stops each person's day now has.
  WITH assigned AS (
    SELECT e.s AS sid,
           ARRAY(SELECT o.vid FROM _arp_out o WHERE o.sid = e.s ORDER BY o.s_no) AS vids,
           (SELECT o.vid FROM _arp_out o WHERE o.sid = e.s ORDER BY o.s_no DESC LIMIT 1) AS last_vid
      FROM unnest(_eligible) AS e(s)
  ),
  closed AS (
    SELECT a.sid, public.closing_drive_min(_org_id, a.sid, a.vids, a.last_vid) AS close_min
      FROM assigned a
  ),
  per AS (
    SELECT e.s AS sid,
           count(o.vid)::int AS stops,
           round(COALESCE(sum(COALESCE(gm.svc, public.stop_service_min(sv.default_duration_min, p.service_duration_min))), 0), 1) AS service_min,
           round(COALESCE(sum(LEAST(o.t_min, 99999.9)), 0) + COALESCE(max(cl.close_min), 0), 1) AS travel_min,
           round(COALESCE(sum(COALESCE(gm.svc, public.stop_service_min(sv.default_duration_min, p.service_duration_min))), 0)
                 + COALESCE(sum(LEAST(o.t_min, 99999.9)), 0)
                 + COALESCE(max(cl.close_min), 0), 1) AS total_min,
           count(*) FILTER (WHERE o.w_viol)::int AS late
      FROM unnest(_eligible) AS e(s)
      LEFT JOIN _arp_out o ON o.sid = e.s
      LEFT JOIN public.visits v ON v.id = o.vid
      LEFT JOIN public.properties p ON p.id = v.property_id
      LEFT JOIN public.services sv ON sv.id = v.service_id
      LEFT JOIN _arp_grp gm ON gm.vid = o.vid
      LEFT JOIN closed cl ON cl.sid = e.s
     GROUP BY e.s
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'staff_id', per.sid, 'stops', per.stops, 'service_min', per.service_min,
           'travel_min', per.travel_min, 'total_min', per.total_min, 'late', per.late)
           ORDER BY per.sid), '[]'::jsonb)
    INTO _summary FROM per;

  -- Every window the plan misses, either way, named. With windows honoured
  -- that is only the impossible ones; with them set aside it is the price of
  -- the shorter drive, and the dispatcher sees it before the customer does.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'visit_id', o.vid,
           'staff_id', o.sid,
           'client', c.display_name,
           'kind', CASE WHEN o.w_viol THEN 'late' ELSE 'early' END,
           'eta_start', o.e_start,
           'earliest', o.earliest_ts,
           'latest', o.latest_ts)
           ORDER BY o.e_start, o.vid), '[]'::jsonb)
    INTO _misses
    FROM _arp_out o
    JOIN public.visits v ON v.id = o.vid
    LEFT JOIN public.clients c ON c.id = v.client_id
   WHERE o.w_viol OR o.early;

  RETURN jsonb_build_object(
    'staff', _summary,
    'misses', _misses,
    'unassigned', (SELECT COALESCE(jsonb_agg(u ORDER BY u), '[]'::jsonb) FROM unnest(_left) u));
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_route_plan(uuid, uuid[], date, boolean, jsonb, boolean, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_route_plan(uuid, uuid[], date, boolean, jsonb, boolean, uuid[]) TO authenticated, service_role;

DO $check$
BEGIN
  IF to_regclass('public.walk_groups') IS NULL
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'visits' AND column_name = 'walk_group_id')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'services' AND column_name = 'max_dogs') THEN
    RAISE EXCEPTION 'Group walk table or columns are missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('public.walk_groups', 'walk_groups_validate'),
      ('public.walk_groups', 'walk_groups_copy_walker'),
      ('public.visits', 'visits_validate_walk_group'),
      ('public.visits', 'visits_guard_walk_group')
    ) AS expected(rel, name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = expected.rel::regclass
      AND t.tgname = expected.name AND NOT t.tgisinternal AND t.tgenabled <> 'D')
  ) THEN RAISE EXCEPTION 'Group walk triggers are missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.walk_groups'::regclass AND relrowsecurity)
    OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'walk_groups'
      AND policyname = 'two-step sign-in, when the user has it' AND permissive = 'RESTRICTIVE') THEN
    RAISE EXCEPTION 'Group walk RLS or MFA policy is missing';
  END IF;
  IF has_table_privilege('anon', 'public.walk_groups', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION 'Anonymous callers can access walk_groups';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.services'::regclass AND conname = 'services_max_dogs_check')
    OR to_regprocedure('public.walk_dogs_on_visit(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Group walk capacity constraint or dog count function is missing';
  END IF;
  IF has_function_privilege('anon', 'public.walk_dogs_on_visit(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Anonymous callers can count walk dogs';
  END IF;
  -- A skip, a cancel or a move has to reach the member trigger to detach it.
  IF EXISTS (
    SELECT 1 FROM (VALUES ('status'), ('scheduled_on'), ('service_id'), ('organization_id')) AS c(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = ANY (t.tgattr::int2[])
      WHERE t.tgrelid = 'public.visits'::regclass AND t.tgname = 'visits_validate_walk_group'
        AND a.attname = c.col)
  ) THEN
    RAISE EXCEPTION 'visits_validate_walk_group does not fire on status, day, service and business';
  END IF;
  -- One apply_route_plan, the seven-argument one, timing a group walk once.
  IF (SELECT count(*) FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace AND proname = 'apply_route_plan') <> 1
    OR to_regprocedure('public.apply_route_plan(uuid, uuid[], date, boolean, jsonb, boolean, uuid[])') IS NULL THEN
    RAISE EXCEPTION 'expected one public.apply_route_plan with seven arguments';
  END IF;
  IF strpos((SELECT prosrc FROM pg_proc WHERE oid =
        'public.apply_route_plan(uuid, uuid[], date, boolean, jsonb, boolean, uuid[])'::regprocedure), '_arp_grp') = 0
    OR strpos((SELECT prosrc FROM pg_proc WHERE oid =
        'public.apply_route_plan(uuid, uuid[], date, boolean, jsonb, boolean, uuid[])'::regprocedure), 'can_write_org(') = 0 THEN
    RAISE EXCEPTION 'apply_route_plan does not time group walks or does not check the caller';
  END IF;
  IF has_function_privilege('anon', 'public.apply_route_plan(uuid, uuid[], date, boolean, jsonb, boolean, uuid[])', 'EXECUTE')
    OR NOT has_function_privilege('authenticated', 'public.apply_route_plan(uuid, uuid[], date, boolean, jsonb, boolean, uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'apply_route_plan grants changed';
  END IF;
END;
$check$;
