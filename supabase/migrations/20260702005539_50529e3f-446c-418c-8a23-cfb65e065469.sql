
-- Properties: time windows + service duration
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS earliest_service_time TIME,
  ADD COLUMN IF NOT EXISTS latest_service_time TIME,
  ADD COLUMN IF NOT EXISTS service_duration_min INT NOT NULL DEFAULT 8;

-- Subscriptions: preferred time of day
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS preferred_time_of_day TEXT NOT NULL DEFAULT 'any'
    CHECK (preferred_time_of_day IN ('any','morning','afternoon'));

-- Organizations: workday + traffic
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS workday_start TIME NOT NULL DEFAULT '08:00',
  ADD COLUMN IF NOT EXISTS workday_end TIME NOT NULL DEFAULT '17:00',
  ADD COLUMN IF NOT EXISTS avg_speed_kmh INT NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS traffic_profile TEXT NOT NULL DEFAULT 'normal'
    CHECK (traffic_profile IN ('light','normal','heavy'));

-- Visits: ETA + travel + window violation
ALTER TABLE public.visits
  ADD COLUMN IF NOT EXISTS eta_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS eta_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS travel_km NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS travel_min NUMERIC(6,1),
  ADD COLUMN IF NOT EXISTS window_violated BOOLEAN NOT NULL DEFAULT false;

-- Optimizer v2: nearest-neighbor with time windows, ETA + traffic
CREATE OR REPLACE FUNCTION public.optimize_route_v2(
  _org_id UUID, _staff_id UUID, _day DATE, _reassign BOOLEAN DEFAULT false
) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _start_lat DOUBLE PRECISION;
  _start_lon DOUBLE PRECISION;
  _cur_lat DOUBLE PRECISION;
  _cur_lon DOUBLE PRECISION;
  _workday_start TIME;
  _workday_end TIME;
  _speed NUMERIC;
  _traffic TEXT;
  _traffic_mult NUMERIC;
  _clock TIMESTAMPTZ;
  _day_start_ts TIMESTAMPTZ;
  _day_end_ts TIMESTAMPTZ;
  _seq INT := 0;
  _picked UUID;
  _v RECORD;
  _remaining INT;
  _travel_km NUMERIC;
  _travel_min NUMERIC;
  _eta_start TIMESTAMPTZ;
  _eta_end TIMESTAMPTZ;
  _earliest_ts TIMESTAMPTZ;
  _latest_ts TIMESTAMPTZ;
  _violated BOOLEAN;
BEGIN
  IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.staff WHERE id=_staff_id AND organization_id=_org_id) THEN
    RAISE EXCEPTION 'Staff not in organization';
  END IF;

  SELECT start_latitude, start_longitude INTO _start_lat, _start_lon
    FROM public.staff WHERE id = _staff_id;
  SELECT workday_start, workday_end, avg_speed_kmh, traffic_profile
    INTO _workday_start, _workday_end, _speed, _traffic
    FROM public.organizations WHERE id = _org_id;

  _traffic_mult := CASE _traffic WHEN 'light' THEN 1.15 WHEN 'heavy' THEN 0.7 ELSE 1.0 END;
  _day_start_ts := (_day::timestamp + _workday_start)::timestamptz;
  _day_end_ts   := (_day::timestamp + _workday_end)::timestamptz;
  _clock := _day_start_ts;
  _cur_lat := _start_lat; _cur_lon := _start_lon;

  CREATE TEMP TABLE IF NOT EXISTS _opt2 (
    id UUID PRIMARY KEY, lat DOUBLE PRECISION, lon DOUBLE PRECISION,
    duration_min INT, earliest TIME, latest TIME, pref TEXT,
    picked BOOLEAN NOT NULL DEFAULT false
  ) ON COMMIT DROP;
  DELETE FROM _opt2;

  INSERT INTO _opt2(id, lat, lon, duration_min, earliest, latest, pref)
  SELECT v.id, p.latitude, p.longitude,
         COALESCE(p.service_duration_min, 8),
         p.earliest_service_time, p.latest_service_time,
         COALESCE(s.preferred_time_of_day, 'any')
    FROM public.visits v
    LEFT JOIN public.properties p ON p.id = v.property_id
    LEFT JOIN public.subscriptions s ON s.id = v.subscription_id
   WHERE v.organization_id = _org_id
     AND v.scheduled_on = _day
     AND v.status = 'scheduled'
     AND (_reassign OR v.assigned_staff_id IS NULL OR v.assigned_staff_id = _staff_id);

  LOOP
    SELECT COUNT(*) INTO _remaining FROM _opt2 WHERE NOT picked;
    EXIT WHEN _remaining = 0;

    -- Score = travel_min + latest-window-penalty + preferred-time-penalty
    -- Prefer visits whose window is closing soonest / lowest travel.
    WITH cand AS (
      SELECT o.id, o.lat, o.lon, o.duration_min, o.earliest, o.latest, o.pref,
             COALESCE(public.haversine_km(_cur_lat,_cur_lon,o.lat,o.lon), 5.0) AS km
        FROM _opt2 o WHERE NOT o.picked
    ), scored AS (
      SELECT c.*,
             (c.km / GREATEST(_speed * _traffic_mult, 1)) * 60.0 AS travel_min,
             CASE WHEN c.latest IS NOT NULL
                  THEN GREATEST(0, EXTRACT(EPOCH FROM ((_day + c.latest)::timestamptz - _clock))/60.0)
                  ELSE 999 END AS mins_to_close,
             CASE c.pref
               WHEN 'morning'   THEN CASE WHEN EXTRACT(HOUR FROM _clock) < 12 THEN 0 ELSE 30 END
               WHEN 'afternoon' THEN CASE WHEN EXTRACT(HOUR FROM _clock) >= 12 THEN 0 ELSE 30 END
               ELSE 0
             END AS pref_penalty
        FROM cand c
    )
    SELECT id INTO _picked FROM scored
     ORDER BY (travel_min + LEAST(mins_to_close, 240) * 0.15 + pref_penalty) ASC
     LIMIT 1;

    SELECT * INTO _v FROM _opt2 WHERE id = _picked;
    _travel_km := COALESCE(public.haversine_km(_cur_lat,_cur_lon,_v.lat,_v.lon), 0);
    _travel_min := (_travel_km / GREATEST(_speed * _traffic_mult, 1)) * 60.0;
    _eta_start := _clock + make_interval(secs => _travel_min * 60);

    -- Respect earliest window (wait if we arrive too early)
    IF _v.earliest IS NOT NULL THEN
      _earliest_ts := (_day + _v.earliest)::timestamptz;
      IF _eta_start < _earliest_ts THEN _eta_start := _earliest_ts; END IF;
    END IF;

    _eta_end := _eta_start + make_interval(mins => COALESCE(_v.duration_min,8));
    _violated := false;
    IF _v.latest IS NOT NULL THEN
      _latest_ts := (_day + _v.latest)::timestamptz;
      IF _eta_start > _latest_ts THEN _violated := true; END IF;
    END IF;

    _seq := _seq + 1;
    UPDATE public.visits
       SET assigned_staff_id = _staff_id, sequence = _seq,
           travel_km = round(_travel_km::numeric, 2),
           travel_min = round(_travel_min::numeric, 1),
           eta_start = _eta_start, eta_end = _eta_end,
           window_violated = _violated,
           updated_at = now()
     WHERE id = _picked;

    UPDATE _opt2 SET picked = true WHERE id = _picked;
    _cur_lat := _v.lat; _cur_lon := _v.lon;
    _clock := _eta_end;
  END LOOP;

  RETURN _seq;
END; $$;

-- Multi-day dispatcher: balance unassigned across active techs, then optimize each tech
CREATE OR REPLACE FUNCTION public.optimize_week(
  _org_id UUID, _start_date DATE, _days INT DEFAULT 7
) RETURNS TABLE(day DATE, staff_id UUID, assigned INT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _d DATE;
  _end DATE;
  _staff_ids UUID[];
  _n_staff INT;
  _rec RECORD;
  _idx INT;
  _cnt INT;
  _sid UUID;
BEGIN
  IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _days IS NULL OR _days < 1 OR _days > 31 THEN
    RAISE EXCEPTION 'days must be between 1 and 31';
  END IF;

  SELECT array_agg(id ORDER BY display_name) INTO _staff_ids
    FROM public.staff
   WHERE organization_id = _org_id AND active = true
     AND role IN ('tech','owner','office_manager','dispatcher');
  _n_staff := COALESCE(array_length(_staff_ids,1), 0);
  IF _n_staff = 0 THEN RAISE EXCEPTION 'No active staff'; END IF;

  _end := _start_date + (_days - 1);
  _d := _start_date;
  WHILE _d <= _end LOOP
    _idx := 0;
    -- Round-robin unassigned visits for the day, ordered by zone/postal
    FOR _rec IN
      SELECT v.id
        FROM public.visits v
        LEFT JOIN public.zones z ON z.id = v.zone_id
        LEFT JOIN public.properties p ON p.id = v.property_id
       WHERE v.organization_id = _org_id
         AND v.scheduled_on = _d
         AND v.status = 'scheduled'
         AND v.assigned_staff_id IS NULL
       ORDER BY COALESCE(z.postal_prefix,''), COALESCE(p.postal_code,''), v.created_at
    LOOP
      _sid := _staff_ids[(_idx % _n_staff) + 1];
      UPDATE public.visits SET assigned_staff_id = _sid, sequence = NULL WHERE id = _rec.id;
      _idx := _idx + 1;
    END LOOP;

    -- Optimize per tech for that day
    FOREACH _sid IN ARRAY _staff_ids LOOP
      _cnt := public.optimize_route_v2(_org_id, _sid, _d, false);
      day := _d; staff_id := _sid; assigned := _cnt;
      RETURN NEXT;
    END LOOP;
    _d := _d + 1;
  END LOOP;
END; $$;
