-- QA round 3, finding B6 (parts 2 and 3).
--
-- Part 2 — absurd 4:00 AM service windows / route ETAs.
--   Root cause: optimize_route_v2 built each ETA with
--     (_day::timestamp + workday_start)::timestamptz
--   which casts the org's LOCAL wall-clock workday start (e.g. 08:00) using the
--   database session timezone (UTC). An 08:00 workday start was therefore
--   stored as 08:00 UTC, which renders as 03:00 AM Central / 04:00 AM Eastern —
--   the exact "route ends 04:24 AM / ETA 04:00 AM" symptom. The fix anchors the
--   wall-clock in the organization's own timezone via AT TIME ZONE, so 08:00
--   local becomes the correct instant (e.g. 13:00 UTC for America/Chicago).
--
-- Part 3 — completed visit shows duration "Not recorded" with an identical
--   6:05 AM start and completion. Root cause: office_complete_visit (and the
--   tech complete_visit) stamped started_at = COALESCE(started_at, now()),
--   and inside one transaction now() == completed_at, fabricating a
--   zero-length visit whenever completion happened without a real start. Going
--   forward we no longer fabricate a start: started_at stays whatever
--   start_visit recorded (NULL if the tech never started), so the UI honestly
--   shows "Arrival not recorded" instead of a phantom 6:05→6:05. The duration
--   DISPLAY is computed from the timestamps app-side.

-- ── Organization timezone (configurable, sensible US default) ────────────────
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'America/Chicago';

-- ── optimize_route_v2: anchor windows/ETAs at the org-local workday start ─────
CREATE OR REPLACE FUNCTION public.optimize_route_v2(_org_id uuid, _staff_id uuid, _day date, _reassign boolean DEFAULT false)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _start_lat DOUBLE PRECISION;
  _start_lon DOUBLE PRECISION;
  _cur_lat DOUBLE PRECISION;
  _cur_lon DOUBLE PRECISION;
  _workday_start TIME;
  _workday_end TIME;
  _speed NUMERIC;
  _traffic TEXT;
  _tz TEXT;
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
  SELECT workday_start, workday_end, avg_speed_kmh, traffic_profile, timezone
    INTO _workday_start, _workday_end, _speed, _traffic, _tz
    FROM public.organizations WHERE id = _org_id;

  _tz := COALESCE(_tz, 'America/Chicago');
  _traffic_mult := CASE _traffic WHEN 'light' THEN 1.15 WHEN 'heavy' THEN 0.7 ELSE 1.0 END;
  -- Anchor the workday in the ORG's local timezone (not the UTC session zone),
  -- so an 08:00 start is 8 AM local, not 8 AM UTC (== 3-4 AM in the US).
  _day_start_ts := (_day + COALESCE(_workday_start, TIME '08:00')) AT TIME ZONE _tz;
  _day_end_ts   := (_day + COALESCE(_workday_end,   TIME '17:00')) AT TIME ZONE _tz;
  _clock := _day_start_ts;
  _cur_lat := _start_lat; _cur_lon := _start_lon;

  CREATE TEMP TABLE IF NOT EXISTS _opt2 (
    id UUID PRIMARY KEY, lat DOUBLE PRECISION, lon DOUBLE PRECISION,
    duration_min INT, earliest TIME, latest TIME, pref TEXT,
    picked BOOLEAN NOT NULL DEFAULT false
  ) ON COMMIT DROP;
  DELETE FROM _opt2 WHERE true;

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

    WITH cand AS (
      SELECT o.id, o.lat, o.lon, o.duration_min, o.earliest, o.latest, o.pref,
             COALESCE(public.haversine_km(_cur_lat,_cur_lon,o.lat,o.lon), 5.0) AS km
        FROM _opt2 o WHERE NOT o.picked
    ),
    scored AS (
      SELECT c.*,
             (c.km / NULLIF(_speed,0)) * 60.0 / _traffic_mult AS travel_min,
             CASE WHEN c.latest IS NOT NULL
                  AND ((_clock + make_interval(mins => ((c.km/NULLIF(_speed,0))*60.0/_traffic_mult)::int)) AT TIME ZONE _tz)::time > c.latest
                  THEN 30 ELSE 0 END AS window_pen,
             CASE c.pref WHEN 'morning' THEN CASE WHEN EXTRACT(HOUR FROM _clock AT TIME ZONE _tz) < 12 THEN 0 ELSE 15 END
                         WHEN 'afternoon' THEN CASE WHEN EXTRACT(HOUR FROM _clock AT TIME ZONE _tz) >= 12 THEN 0 ELSE 15 END
                         ELSE 0 END AS pref_pen
        FROM cand c
    )
    SELECT id INTO _picked FROM scored
      ORDER BY travel_min + window_pen + pref_pen ASC LIMIT 1;

    SELECT * INTO _v FROM _opt2 WHERE id = _picked;
    _travel_km := COALESCE(public.haversine_km(_cur_lat,_cur_lon,_v.lat,_v.lon), 0);
    _travel_min := (_travel_km / NULLIF(_speed,0)) * 60.0 / _traffic_mult;
    _eta_start := _clock + make_interval(mins => COALESCE(_travel_min,0)::int);
    _eta_end := _eta_start + make_interval(mins => COALESCE(_v.duration_min,8));
    _earliest_ts := CASE WHEN _v.earliest IS NOT NULL THEN (_day + _v.earliest) AT TIME ZONE _tz END;
    _latest_ts := CASE WHEN _v.latest IS NOT NULL THEN (_day + _v.latest) AT TIME ZONE _tz END;
    IF _earliest_ts IS NOT NULL AND _eta_start < _earliest_ts THEN
      _eta_start := _earliest_ts;
      _eta_end := _eta_start + make_interval(mins => COALESCE(_v.duration_min,8));
    END IF;
    _violated := (_latest_ts IS NOT NULL AND _eta_start > _latest_ts);

    _seq := _seq + 1;
    UPDATE public.visits
       SET assigned_staff_id = _staff_id,
           sequence = _seq,
           eta_start = _eta_start,
           eta_end = _eta_end,
           travel_km = _travel_km,
           travel_min = _travel_min,
           window_violated = _violated
     WHERE id = _picked;

    UPDATE _opt2 SET picked = true WHERE id = _picked;
    _clock := _eta_end;
    IF _v.lat IS NOT NULL AND _v.lon IS NOT NULL THEN
      _cur_lat := _v.lat; _cur_lon := _v.lon;
    END IF;
  END LOOP;

  RETURN _seq;
END; $function$;

-- ── complete_visit / office_complete_visit: stop fabricating started_at ───────
-- Only completed_at is stamped now; started_at is left as recorded by
-- start_visit (NULL if never started). This ends the 6:05→6:05 phantom.
CREATE OR REPLACE FUNCTION public.complete_visit(_visit_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _has_photo boolean; _sub_id uuid; _org uuid; _client uuid; _cadence public.billing_cadence; _price integer;
BEGIN
  IF NOT public.is_visit_tech(auth.uid(), _visit_id) THEN
    RAISE EXCEPTION 'Not authorized for this visit';
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.visit_photos WHERE visit_id = _visit_id AND kind = 'completion') INTO _has_photo;
  IF NOT _has_photo THEN
    RAISE EXCEPTION 'A completion photo is required before completing this visit';
  END IF;

  UPDATE public.visits
     SET status='completed', completed_at = now(), updated_at = now()
   WHERE id = _visit_id AND status IN ('scheduled','in_progress');
  -- A concurrent completion beat us to it: no double debit.
  IF NOT FOUND THEN RETURN; END IF;

  SELECT v.subscription_id, v.organization_id, v.client_id, s.billing_cadence, s.price_cents
    INTO _sub_id, _org, _client, _cadence, _price
    FROM public.visits v JOIN public.subscriptions s ON s.id = v.subscription_id
   WHERE v.id = _visit_id;

  IF _cadence = 'prepaid' AND COALESCE(_price, 0) > 0 THEN
    PERFORM public.post_credit_entry(_org, _client, -_price, 'visit_debit', NULL, _visit_id, 'Visit completed');
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.office_complete_visit(_visit_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid; _status public.visit_status; _sub_id uuid; _client uuid;
        _cadence public.billing_cadence; _price integer;
BEGIN
  SELECT organization_id, status INTO _org, _status
    FROM public.visits WHERE id = _visit_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Visit not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _status NOT IN ('scheduled','in_progress') THEN
    RAISE EXCEPTION 'Only scheduled or in-progress visits can be completed';
  END IF;

  UPDATE public.visits
     SET status='completed', completed_at = now(), updated_at = now()
   WHERE id = _visit_id AND status IN ('scheduled','in_progress');
  -- A concurrent completion beat us to it: no double debit.
  IF NOT FOUND THEN RETURN; END IF;

  SELECT v.subscription_id, v.client_id, s.billing_cadence, s.price_cents
    INTO _sub_id, _client, _cadence, _price
    FROM public.visits v JOIN public.subscriptions s ON s.id = v.subscription_id
   WHERE v.id = _visit_id;

  IF _cadence = 'prepaid' AND COALESCE(_price, 0) > 0 THEN
    PERFORM public.post_credit_entry(_org, _client, -_price, 'visit_debit', NULL, _visit_id, 'Visit completed');
  END IF;
END; $function$;
