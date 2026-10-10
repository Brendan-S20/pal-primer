-- A window is kept and a skill is matched: appointment routing, phase 4.
--
-- Two things the owner decided for the other trades (dog walking, sitting,
-- grooming), stated here so the database side of each is in one place:
--
--   1. Arrival windows are always honoured. A walk booked for 11:00-13:00 is
--      never planned for 13:40 and flagged; if no route keeps the window the
--      visit is left off every route and NAMED to the dispatcher. The solver
--      (src/lib/route-solver.ts) does the keeping; this file lets the write
--      accept a plan that deliberately leaves a stop out.
--
--   2. Technicians have service skills. A business marks which of its
--      services each person can do, and the planner gives a visit only to
--      someone who can do it. A visit nobody on the run can do is left out
--      and named the same way.
--
-- Nothing changes for a business that sets no skills: a technician with no
-- rows here can do any service, which is what every technician could do
-- before this file. route_day_inputs says `services: null` for them and the
-- solver reads null as "anyone".
--
-- ── THE SCHEMA ───────────────────────────────────────────────────────────
--
--   staff_services (staff_id, service_id, organization_id)
--
-- One row per skill. No rows for a person means every service (the
-- backward-compatible default); rows mean exactly those. Both sides must be
-- the business's own (tg_staff_services_same_org), the way a plan's or a
-- visit's service must be (20261009230000). Members of the business read it;
-- whoever may manage users (owner) writes it -- the same gate as the staff
-- row's other routing facts (Runs routes, addresses, time off). There is no
-- UPDATE: a skill is given or taken away.
--
-- ── THE PLANNER'S READ ───────────────────────────────────────────────────
--
-- route_day_inputs is restated from 20261009230100 with four additions and
-- nothing else: each visit carries `service_id`, `service` (the name) and
-- `client` (the display name, for the sentence that names a stop nobody can
-- take), and each technician carries `services` (their skill rows' service
-- ids, or NULL when they have none).
--
-- ── THE PLANNER'S WRITE ──────────────────────────────────────────────────
--
-- apply_route_plan gains `_unassigned uuid[]`: the stops the plan leaves on
-- no route on purpose. Until now a stop missing from every route meant "the
-- day changed while it was being planned" and the day was refused, which was
-- right when the only way to leave a stop out was by accident. A listed stop
-- is still checked to be in play (so a stale plan is still refused), may not
-- also be routed, and is written as UNASSIGNED: sequence, ETAs, travel and
-- the late flag cleared, and with reassign its technician too. It is never
-- left on a technician's lane at a time nobody promised. The old six-argument
-- signature is dropped so a six-argument call (every existing caller, the
-- routing trials, apply_route_plans before this file) resolves to this one
-- with the default, rather than to two candidates.
--
-- apply_route_plans passes each day's `unassigned` list through.
--
-- Replays into an empty database: a table, a trigger, three function bodies
-- over tables and helpers that exist by this point (services, 20261009200000;
-- visits.service_id, 20261009230000; stop_service_min, 20261009230100;
-- require_mfa_policy, has_permission, is_org_member). Nothing needs a row.

-- ── 1. The table ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.staff_services (
  staff_id uuid NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES public.services(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, service_id)
);

COMMENT ON TABLE public.staff_services IS
  'Which services a technician can do. No rows for a person means any service (the default before skills existed); rows mean exactly those. The planner (route_day_inputs) reads it; Users & roles writes it. Migration 20261010120000.';

CREATE INDEX IF NOT EXISTS staff_services_organization_id_idx ON public.staff_services (organization_id);
CREATE INDEX IF NOT EXISTS staff_services_service_id_idx ON public.staff_services (service_id);

-- Both sides are this business's own. A trigger rather than two composite
-- foreign keys, which is how the plan and visit triggers do it (20261009230000).
CREATE OR REPLACE FUNCTION public.tg_staff_services_same_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.staff st
        WHERE st.id = NEW.staff_id AND st.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'That person belongs to another business.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM public.services s
        WHERE s.id = NEW.service_id AND s.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'That service belongs to another business.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_staff_services_same_org() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS staff_services_same_org ON public.staff_services;
CREATE TRIGGER staff_services_same_org
  BEFORE INSERT OR UPDATE ON public.staff_services
  FOR EACH ROW EXECUTE FUNCTION public.tg_staff_services_same_org();

-- ── 2. Who may read and write it ─────────────────────────────────────────

ALTER TABLE public.staff_services ENABLE ROW LEVEL SECURITY;

-- Two-step sign-in, like every RLS table (20261002010000_a-password-was-the-only-lock).
SELECT public.require_mfa_policy('public.staff_services');

REVOKE ALL ON public.staff_services FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.staff_services TO authenticated;
GRANT ALL ON public.staff_services TO service_role;

DROP POLICY IF EXISTS "Members read staff services" ON public.staff_services;
CREATE POLICY "Members read staff services" ON public.staff_services
  FOR SELECT TO authenticated
  USING (public.is_org_member((SELECT auth.uid()), organization_id));

DROP POLICY IF EXISTS "User managers give a skill" ON public.staff_services;
CREATE POLICY "User managers give a skill" ON public.staff_services
  FOR INSERT TO authenticated
  WITH CHECK (public.has_permission((SELECT auth.uid()), organization_id, 'manage_users'::text));

DROP POLICY IF EXISTS "User managers take a skill away" ON public.staff_services;
CREATE POLICY "User managers take a skill away" ON public.staff_services
  FOR DELETE TO authenticated
  USING (public.has_permission((SELECT auth.uid()), organization_id, 'manage_users'::text));

-- ── 3. The planner's read ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.route_day_inputs(
  _org_id uuid, _staff_ids uuid[], _day date, _reassign boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
-- Not STABLE: it fills a temp table of points, which only a volatile
-- function may write. It changes nothing that outlives the transaction.
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _eligible uuid[];
  _org jsonb;
  _techs jsonb;
  _visits jsonb;
  _dumps jsonb;
  _centroid jsonb;
  _points jsonb;
  _legs jsonb;
BEGIN
  IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized to plan routes for this organization';
  END IF;
  IF _staff_ids IS NULL OR COALESCE(array_length(_staff_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'Select at least one technician to route';
  END IF;

  -- The refusal plan_day_across_staff makes, word for word, so a day nobody
  -- can run is reported the same way it always was.
  _eligible := public.routable_staff(_org_id, _staff_ids, _day);
  IF COALESCE(array_length(_eligible, 1), 0) = 0 THEN
    RAISE EXCEPTION 'None of the selected people can be routed on %: check "Runs routes" and time off', _day;
  END IF;

  SELECT jsonb_build_object(
           'timezone', COALESCE(o.timezone, 'America/Chicago'),
           'workday_start', to_char(COALESCE(o.workday_start, TIME '08:00'), 'HH24:MI'),
           'workday_end', to_char(COALESCE(o.workday_end, TIME '17:00'), 'HH24:MI'),
           'park_walk_min', COALESCE(o.park_walk_min, 2),
           'road_factor', COALESCE(o.measured_road_factor, o.road_factor, 1.35),
           'speed_kmh', COALESCE(o.measured_speed_kmh,
                                 public.effective_speed_kmh(o.area_type, o.traffic_profile)),
           'measured_legs', o.measured_legs,
           'max_drive_minutes', COALESCE(o.max_drive_minutes, 240),
           'route_windows', o.route_windows,
           'latitude', o.latitude,
           'longitude', o.longitude)
    INTO _org
    FROM public.organizations o WHERE o.id = _org_id;

  -- The stops in play: plan_day_across_staff_dryrun's set. With _reassign,
  -- anything unassigned or already on a routable selected person; without
  -- it, the same set, but what is already assigned stays where it is.
  -- service_id, service and client are for the skill match and for naming
  -- a stop the plan has to leave out (20261010120000).
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', v.id,
           'lat', p.latitude,
           'lon', p.longitude,
           'service_min', public.stop_service_min(sv.default_duration_min, p.service_duration_min),
           'earliest', to_char(CASE WHEN s.earliest_time IS NOT NULL OR s.latest_time IS NOT NULL
                                    THEN s.earliest_time ELSE p.earliest_service_time END, 'HH24:MI'),
           'latest', to_char(CASE WHEN s.earliest_time IS NOT NULL OR s.latest_time IS NOT NULL
                                  THEN s.latest_time ELSE p.latest_service_time END, 'HH24:MI'),
           'pref', COALESCE(s.preferred_time_of_day, 'any'),
           'assigned_staff_id', v.assigned_staff_id,
           'fixed', (NOT COALESCE(_reassign, false) AND v.assigned_staff_id IS NOT NULL),
           'service_id', v.service_id,
           'service', sv.name,
           'client', c.display_name)
           ORDER BY v.id), '[]'::jsonb)
    INTO _visits
    FROM public.visits v
    LEFT JOIN public.properties p ON p.id = v.property_id
    LEFT JOIN public.subscriptions s ON s.id = v.subscription_id
    LEFT JOIN public.services sv ON sv.id = v.service_id
    LEFT JOIN public.clients c ON c.id = v.client_id
   WHERE v.organization_id = _org_id
     AND v.scheduled_on = _day
     AND v.status = 'scheduled'
     AND (v.assigned_staff_id IS NULL OR v.assigned_staff_id = ANY(_eligible));

  -- `services`: the person's skill rows, NULL when they have none -- which
  -- the solver reads as "any service", the default before skills existed.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', e.s,
           'capacity', COALESCE(st.daily_capacity_minutes, 480),
           'start_lat', st.start_latitude,
           'start_lon', st.start_longitude,
           'end_lat', ep.lat,
           'end_lon', ep.lon,
           'current_min', c.minutes,
           'current_stops', c.stops,
           'current_sequenced', c.sequenced,
           'services', (SELECT jsonb_agg(ss.service_id ORDER BY ss.service_id)
                          FROM public.staff_services ss
                         WHERE ss.staff_id = e.s AND ss.organization_id = _org_id))
           ORDER BY e.s), '[]'::jsonb)
    INTO _techs
    FROM unnest(_eligible) AS e(s)
    JOIN public.staff st ON st.id = e.s
    LEFT JOIN LATERAL (SELECT x.lat, x.lon FROM public.staff_end_point(_org_id, e.s) x LIMIT 1) ep ON true
    LEFT JOIN LATERAL public.route_cost_current(_org_id, e.s, _day) c ON true;

  -- staff_start_point's third tier: nearest disposal site to the work.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('lat', f.latitude, 'lon', f.longitude)
                            ORDER BY f.id), '[]'::jsonb)
    INTO _dumps
    FROM public.waste_disposal_facilities f
   WHERE f.organization_id = _org_id
     AND COALESCE(f.active, true)
     AND f.latitude IS NOT NULL AND f.longitude IS NOT NULL;

  -- And the fallback centre it measures from: the whole day, as it does.
  SELECT CASE WHEN count(*) = 0 THEN NULL
              ELSE jsonb_build_object('lat', avg(p.latitude), 'lon', avg(p.longitude)) END
    INTO _centroid
    FROM public.visits v JOIN public.properties p ON p.id = v.property_id
   WHERE v.organization_id = _org_id AND v.scheduled_on = _day
     AND v.status = 'scheduled' AND p.latitude IS NOT NULL;

  -- Every point the solver may drive between, rounded the way road_legs
  -- stores them, and every measured leg among them that drive_minutes would
  -- still use (90 days). Legs nobody measured are priced in TypeScript from
  -- the profile above, by drive_minutes' own arithmetic.
  CREATE TEMP TABLE IF NOT EXISTS _rdi_pts (i int, lat numeric, lon numeric) ON COMMIT DROP;
  DELETE FROM _rdi_pts WHERE true;
  INSERT INTO _rdi_pts (i, lat, lon)
  SELECT (row_number() OVER (ORDER BY q.lat, q.lon) - 1)::int, q.lat, q.lon
    FROM (
      SELECT DISTINCT round(x.lat::numeric, 5) AS lat, round(x.lon::numeric, 5) AS lon
        FROM (
          SELECT (v->>'lat')::float8 AS lat, (v->>'lon')::float8 AS lon FROM jsonb_array_elements(_visits) v
          UNION ALL
          SELECT (t->>'start_lat')::float8, (t->>'start_lon')::float8 FROM jsonb_array_elements(_techs) t
          UNION ALL
          SELECT (t->>'end_lat')::float8, (t->>'end_lon')::float8 FROM jsonb_array_elements(_techs) t
          UNION ALL
          SELECT (d->>'lat')::float8, (d->>'lon')::float8 FROM jsonb_array_elements(_dumps) d
          UNION ALL
          SELECT (_org->>'latitude')::float8, (_org->>'longitude')::float8
        ) x
       WHERE x.lat IS NOT NULL AND x.lon IS NOT NULL
    ) q;

  SELECT COALESCE(jsonb_agg(jsonb_build_array(pt.lat, pt.lon) ORDER BY pt.i), '[]'::jsonb)
    INTO _points FROM _rdi_pts pt;

  SELECT COALESCE(jsonb_agg(jsonb_build_array(a.i, b.i, rl.seconds) ORDER BY a.i, b.i), '[]'::jsonb)
    INTO _legs
    FROM public.road_legs rl
    JOIN _rdi_pts a ON a.lat = rl.from_lat AND a.lon = rl.from_lon
    JOIN _rdi_pts b ON b.lat = rl.to_lat AND b.lon = rl.to_lon
   WHERE rl.organization_id = _org_id
     AND rl.fetched_at > now() - interval '90 days';

  RETURN jsonb_build_object(
    'org', _org,
    'techs', _techs,
    'visits', _visits,
    'dumps', _dumps,
    'day_centroid', _centroid,
    'points', _points,
    'legs', _legs);
END;
$function$;

REVOKE ALL ON FUNCTION public.route_day_inputs(uuid, uuid[], date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.route_day_inputs(uuid, uuid[], date, boolean) TO authenticated, service_role;

-- ── 4. The planner's write ───────────────────────────────────────────────

-- The six-argument signature goes, so a six-argument call has one candidate.
DROP FUNCTION IF EXISTS public.apply_route_plan(uuid, uuid[], date, boolean, jsonb, boolean);

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
             public.stop_service_min(sv.default_duration_min, p.service_duration_min) AS svc,
             CASE WHEN s.earliest_time IS NOT NULL OR s.latest_time IS NOT NULL
                  THEN s.earliest_time ELSE p.earliest_service_time END AS earliest,
             CASE WHEN s.earliest_time IS NOT NULL OR s.latest_time IS NOT NULL
                  THEN s.latest_time ELSE p.latest_service_time END AS latest
        FROM _arp_in a
        JOIN public.visits v ON v.id = a.vid
        LEFT JOIN public.properties p ON p.id = v.property_id
        LEFT JOIN public.subscriptions s ON s.id = v.subscription_id
        LEFT JOIN public.services sv ON sv.id = v.service_id
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
    END LOOP;
  END LOOP;

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
           round(COALESCE(sum(public.stop_service_min(sv.default_duration_min, p.service_duration_min)), 0), 1) AS service_min,
           round(COALESCE(sum(LEAST(o.t_min, 99999.9)), 0) + COALESCE(max(cl.close_min), 0), 1) AS travel_min,
           round(COALESCE(sum(public.stop_service_min(sv.default_duration_min, p.service_duration_min)), 0)
                 + COALESCE(sum(LEAST(o.t_min, 99999.9)), 0)
                 + COALESCE(max(cl.close_min), 0), 1) AS total_min,
           count(*) FILTER (WHERE o.w_viol)::int AS late
      FROM unnest(_eligible) AS e(s)
      LEFT JOIN _arp_out o ON o.sid = e.s
      LEFT JOIN public.visits v ON v.id = o.vid
      LEFT JOIN public.properties p ON p.id = v.property_id
      LEFT JOIN public.services sv ON sv.id = v.service_id
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

-- ── 5. The run's write passes each day's list through ────────────────────

CREATE OR REPLACE FUNCTION public.apply_route_plans(_run_id uuid, _reassign boolean, _plans jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _run public.routing_runs;
  _p jsonb;
  _day date;
  _r jsonb;
  _out jsonb := '[]'::jsonb;
BEGIN
  -- Locked, so a concurrent abandon (start_routing_run's sweep) waits for
  -- this transaction or this one waits for it -- never both.
  SELECT * INTO _run FROM public.routing_runs WHERE id = _run_id FOR UPDATE;
  IF _run.id IS NULL
     OR _run.started_by IS DISTINCT FROM auth.uid()
     OR NOT public.can_write_org(auth.uid(), _run.organization_id) THEN
    RAISE EXCEPTION 'Not authorized to plan routes for this organization' USING ERRCODE = '42501';
  END IF;
  IF _run.status NOT IN ('queued', 'running') THEN
    RAISE EXCEPTION 'This auto-routing run already ended (%), so its plan was not saved.', _run.status;
  END IF;
  IF _run.applied_at IS NOT NULL THEN
    RAISE EXCEPTION 'This auto-routing run was already saved.';
  END IF;
  IF _plans IS NULL OR jsonb_typeof(_plans) <> 'array' THEN
    RAISE EXCEPTION 'A run''s plan is a list of days';
  END IF;
  IF EXISTS (
       SELECT 1 FROM jsonb_array_elements(_plans) e
        GROUP BY e->>'day' HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'The plan has the same day twice';
  END IF;

  FOR _p IN SELECT value FROM jsonb_array_elements(_plans) LOOP
    _day := (_p->>'day')::date;
    IF _day IS NULL OR _day < _run.from_day OR _day > _run.to_day THEN
      RAISE EXCEPTION 'The plan has a day outside the run: %', _p->>'day';
    END IF;
    -- Its own subtransaction: a day apply_route_plan refuses is undone on its
    -- own and reported, and the others still commit, which is what a refused
    -- day has always meant. A statement timeout is NOT caught here (it is not
    -- in OTHERS), so a run too big to save aborts whole, writing nothing.
    BEGIN
      _r := public.apply_route_plan(
        _run.organization_id, _run.staff_ids, _day, COALESCE(_reassign, false),
        _p->'routes', COALESCE((_p->>'honour_windows')::boolean, true),
        ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(COALESCE(_p->'unassigned', '[]'::jsonb)) x));
      _out := _out || jsonb_build_array(jsonb_build_object('day', _day, 'ok', true, 'result', _r));
    EXCEPTION WHEN OTHERS THEN
      _out := _out || jsonb_build_array(jsonb_build_object('day', _day, 'ok', false, 'error', SQLERRM));
    END;
  END LOOP;

  UPDATE public.routing_runs
     SET applied_at = now(), status = 'running', stage = 'saving', updated_at = now()
   WHERE id = _run_id;

  RETURN _out;
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_route_plans(uuid, boolean, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_route_plans(uuid, boolean, jsonb) TO authenticated, service_role;

-- ── What this file establishes, checked from any starting state ───────────
DO $post$
DECLARE
  _fn text;
  _src text;
  _n integer;
BEGIN
  IF to_regclass('public.staff_services') IS NULL THEN
    RAISE EXCEPTION 'public.staff_services was not created';
  END IF;
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.staff_services'::regclass) THEN
    RAISE EXCEPTION 'row level security is not enabled on public.staff_services';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'staff_services' AND permissive = 'RESTRICTIVE'
  ) THEN
    RAISE EXCEPTION 'public.staff_services has no two-step sign-in policy';
  END IF;
  -- Read, give, take away: nothing else, and the two-step policy is
  -- restrictive so it is not counted (#302).
  SELECT count(*) INTO _n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'staff_services' AND permissive = 'PERMISSIVE';
  IF _n <> 3 THEN
    RAISE EXCEPTION 'public.staff_services should carry exactly three permissive policies, has %', _n;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'staff_services' AND permissive = 'PERMISSIVE'
       AND cmd IN ('INSERT', 'DELETE')
       AND COALESCE(qual, '') NOT LIKE '%manage_users%'
       AND COALESCE(with_check, '') NOT LIKE '%manage_users%'
  ) THEN
    RAISE EXCEPTION 'a write policy on public.staff_services does not ask for manage_users';
  END IF;
  IF has_table_privilege('anon', 'public.staff_services', 'SELECT')
     OR has_table_privilege('anon', 'public.staff_services', 'INSERT')
     OR has_table_privilege('anon', 'public.staff_services', 'DELETE') THEN
    RAISE EXCEPTION 'anon holds a privilege on public.staff_services';
  END IF;
  IF has_table_privilege('authenticated', 'public.staff_services', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated can UPDATE public.staff_services; a skill is given or taken away';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.staff_services'::regclass
       AND tgname = 'staff_services_same_org' AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'trigger staff_services_same_org is missing or disabled';
  END IF;
  IF has_function_privilege('anon', 'public.tg_staff_services_same_org()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tg_staff_services_same_org()', 'EXECUTE') THEN
    RAISE EXCEPTION 'tg_staff_services_same_org is callable through the API';
  END IF;

  -- One apply_route_plan, the seven-argument one.
  SELECT count(*) INTO _n FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'apply_route_plan';
  IF _n <> 1 THEN
    RAISE EXCEPTION 'expected one public.apply_route_plan, found %', _n;
  END IF;

  FOREACH _fn IN ARRAY ARRAY[
    'public.route_day_inputs(uuid, uuid[], date, boolean)',
    'public.apply_route_plan(uuid, uuid[], date, boolean, jsonb, boolean, uuid[])',
    'public.apply_route_plans(uuid, boolean, jsonb)'] LOOP
    IF to_regprocedure(_fn) IS NULL THEN
      RAISE EXCEPTION '% does not exist', _fn;
    END IF;
    IF has_function_privilege('anon', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% is executable with the publishable key', _fn;
    END IF;
    IF NOT has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% is not callable by a signed-in dispatcher', _fn;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(_fn)) THEN
      RAISE EXCEPTION '% must run as its owner', _fn;
    END IF;
    _src := (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(_fn));
    IF strpos(_src, 'can_write_org(') = 0 THEN
      RAISE EXCEPTION '% must refuse a caller who cannot write the organization', _fn;
    END IF;
  END LOOP;

  -- The read carries the skills and the write accepts the list.
  _src := (SELECT prosrc FROM pg_proc WHERE oid = 'public.route_day_inputs(uuid, uuid[], date, boolean)'::regprocedure);
  IF strpos(_src, 'public.staff_services ss') = 0 OR strpos(_src, '''service_id'', v.service_id') = 0 THEN
    RAISE EXCEPTION 'route_day_inputs does not read staff skills and visit services';
  END IF;
  IF strpos(_src, 'public.stop_service_min(sv.default_duration_min, p.service_duration_min)') = 0 THEN
    RAISE EXCEPTION 'route_day_inputs lost the one duration rule (20261009230100)';
  END IF;
  _src := (SELECT prosrc FROM pg_proc WHERE oid = 'public.apply_route_plan(uuid, uuid[], date, boolean, jsonb, boolean, uuid[])'::regprocedure);
  IF strpos(_src, 'WHERE v.id = ANY(_left)') = 0
     OR strpos(_src, 'The plan both routes a stop and leaves it unassigned') = 0 THEN
    RAISE EXCEPTION 'apply_route_plan does not write the unassigned list';
  END IF;
  IF strpos(_src, 'public.stop_service_min(sv.default_duration_min, p.service_duration_min)') = 0 THEN
    RAISE EXCEPTION 'apply_route_plan lost the one duration rule (20261009230100)';
  END IF;
  _src := (SELECT prosrc FROM pg_proc WHERE oid = 'public.apply_route_plans(uuid, boolean, jsonb)'::regprocedure);
  IF strpos(_src, 'public.apply_route_plan(') = 0 OR strpos(_src, '_p->''unassigned''') = 0 THEN
    RAISE EXCEPTION 'apply_route_plans must write through apply_route_plan and pass the unassigned list';
  END IF;
END
$post$;
