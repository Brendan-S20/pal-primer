-- Session 18: Route optimization (nearest-neighbor with haversine)

ALTER TABLE public.staff
  ADD COLUMN IF NOT EXISTS start_latitude double precision,
  ADD COLUMN IF NOT EXISTS start_longitude double precision,
  ADD COLUMN IF NOT EXISTS start_address text;

-- Haversine in kilometers
CREATE OR REPLACE FUNCTION public.haversine_km(
  lat1 double precision, lon1 double precision,
  lat2 double precision, lon2 double precision
) RETURNS double precision
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  r constant double precision := 6371.0088;
  dlat double precision;
  dlon double precision;
  a    double precision;
BEGIN
  IF lat1 IS NULL OR lon1 IS NULL OR lat2 IS NULL OR lon2 IS NULL THEN
    RETURN NULL;
  END IF;
  dlat := radians(lat2 - lat1);
  dlon := radians(lon2 - lon1);
  a := sin(dlat/2)^2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon/2)^2;
  RETURN r * 2 * atan2(sqrt(a), sqrt(1 - a));
END;
$$;

-- Nearest-neighbor route optimizer. Falls back to postal-zone order for visits
-- that have no lat/lng. Preserves anchored visits that already have a sequence
-- when _reassign = false and re-sequences everything when _reassign = true.
CREATE OR REPLACE FUNCTION public.optimize_route_for_day(
  _org_id uuid, _staff_id uuid, _day date, _reassign boolean DEFAULT false
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _start_lat double precision;
  _start_lon double precision;
  _cur_lat double precision;
  _cur_lon double precision;
  _seq integer := 0;
  _picked uuid;
  _visit record;
  _remaining integer;
BEGIN
  IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized to optimize routes for this organization';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.staff WHERE id = _staff_id AND organization_id = _org_id
  ) THEN
    RAISE EXCEPTION 'Staff not in organization';
  END IF;

  SELECT start_latitude, start_longitude
    INTO _start_lat, _start_lon
    FROM public.staff WHERE id = _staff_id;

  -- Build a working set of candidates in a temp table (session-scoped)
  CREATE TEMP TABLE IF NOT EXISTS _opt_visits (
    id uuid PRIMARY KEY,
    lat double precision,
    lon double precision,
    postal text,
    zone_prefix text,
    picked boolean NOT NULL DEFAULT false,
    seq integer
  ) ON COMMIT DROP;
  DELETE FROM _opt_visits;

  INSERT INTO _opt_visits (id, lat, lon, postal, zone_prefix)
  SELECT v.id, p.latitude, p.longitude,
         COALESCE(p.postal_code, ''),
         COALESCE(z.postal_prefix, '')
    FROM public.visits v
    LEFT JOIN public.properties p ON p.id = v.property_id
    LEFT JOIN public.zones z      ON z.id = v.zone_id
   WHERE v.organization_id = _org_id
     AND v.scheduled_on = _day
     AND v.status = 'scheduled'
     AND (
       _reassign
       OR v.assigned_staff_id IS NULL
       OR v.assigned_staff_id = _staff_id
     );

  _cur_lat := _start_lat;
  _cur_lon := _start_lon;

  LOOP
    SELECT COUNT(*) INTO _remaining FROM _opt_visits WHERE NOT picked;
    EXIT WHEN _remaining = 0;

    IF _cur_lat IS NOT NULL AND _cur_lon IS NOT NULL THEN
      -- pick nearest unclaimed with coords; if none have coords, fall back
      SELECT id INTO _picked
        FROM _opt_visits
       WHERE NOT picked AND lat IS NOT NULL AND lon IS NOT NULL
       ORDER BY public.haversine_km(_cur_lat, _cur_lon, lat, lon) ASC
       LIMIT 1;
    ELSE
      _picked := NULL;
    END IF;

    IF _picked IS NULL THEN
      -- no coords available (or no current position); use postal ordering
      SELECT id INTO _picked
        FROM _opt_visits
       WHERE NOT picked
       ORDER BY zone_prefix, postal, id
       LIMIT 1;
    END IF;

    _seq := _seq + 1;
    UPDATE _opt_visits SET picked = true, seq = _seq WHERE id = _picked;

    SELECT lat, lon INTO _cur_lat, _cur_lon FROM _opt_visits WHERE id = _picked;
  END LOOP;

  -- write results back
  FOR _visit IN SELECT id, seq FROM _opt_visits ORDER BY seq LOOP
    UPDATE public.visits
       SET assigned_staff_id = _staff_id,
           sequence = _visit.seq
     WHERE id = _visit.id;
  END LOOP;

  RETURN _seq;
END;
$$;

REVOKE ALL ON FUNCTION public.optimize_route_for_day(uuid, uuid, date, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.optimize_route_for_day(uuid, uuid, date, boolean) TO authenticated;