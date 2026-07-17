-- QA round 3 phase 6 (C1/G7): stable per-property integer station numbering
-- (fixes the "0"/"01" string-label bug) and auto-recorded station service on
-- visit completion so "Last serviced" populates.

-- ── station_number: stable integer sequence per property ────────────────────
ALTER TABLE public.waste_stations
  ADD COLUMN IF NOT EXISTS station_number integer;

-- Backfill: number existing stations 1..n per property by their current
-- order, and align sort_order to the same sequence.
WITH numbered AS (
  SELECT id,
         row_number() OVER (PARTITION BY property_id
                            ORDER BY sort_order, created_at, id) AS rn
    FROM public.waste_stations
)
UPDATE public.waste_stations ws
   SET station_number = numbered.rn,
       sort_order = numbered.rn
  FROM numbered
 WHERE numbered.id = ws.id
   AND ws.station_number IS DISTINCT FROM numbered.rn;

-- Next free integer for a property (max + 1, starting at 1).
CREATE OR REPLACE FUNCTION public.next_station_number(_property_id uuid)
RETURNS integer
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(MAX(station_number), 0) + 1
    FROM public.waste_stations
   WHERE property_id = _property_id
$$;

-- Assign a station number on insert when the caller did not supply one, and
-- keep sort_order aligned to it by default.
CREATE OR REPLACE FUNCTION public.tg_waste_stations_number()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF NEW.station_number IS NULL THEN
    NEW.station_number := public.next_station_number(NEW.property_id);
  END IF;
  IF COALESCE(NEW.sort_order, 0) = 0 THEN
    NEW.sort_order := NEW.station_number;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS waste_stations_number ON public.waste_stations;
CREATE TRIGGER waste_stations_number
  BEFORE INSERT ON public.waste_stations
  FOR EACH ROW EXECUTE FUNCTION public.tg_waste_stations_number();

-- Renumber a property's stations to a clean 1..n sequence (renumberable per
-- G7). Owner/office/dispatch only.
CREATE OR REPLACE FUNCTION public.renumber_property_stations(_property_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE _org uuid; _n integer;
BEGIN
  SELECT organization_id INTO _org FROM public.properties WHERE id = _property_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Property not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  WITH numbered AS (
    SELECT id,
           row_number() OVER (ORDER BY sort_order, station_number, created_at, id) AS rn
      FROM public.waste_stations
     WHERE property_id = _property_id
  )
  UPDATE public.waste_stations ws
     SET station_number = numbered.rn,
         sort_order = numbered.rn,
         updated_at = now()
    FROM numbered
   WHERE numbered.id = ws.id;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$fn$;

REVOKE ALL ON FUNCTION public.renumber_property_stations(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.renumber_property_stations(uuid) TO authenticated, service_role;

-- ── Auto-record station service on visit completion (G7) ────────────────────
-- Completing a visit at a property that has active waste stations records a
-- service log for each station (bags 0, liner not replaced) unless the tech
-- already logged one for that (visit, station). This is what makes
-- "Last serviced" populate everywhere (portal_list_stations already reads it).
CREATE OR REPLACE FUNCTION public.record_visit_station_service(_visit_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE _org uuid; _prop uuid; _n integer := 0;
BEGIN
  SELECT organization_id, property_id INTO _org, _prop
    FROM public.visits WHERE id = _visit_id;
  IF _prop IS NULL THEN RETURN 0; END IF;
  INSERT INTO public.station_service_logs (organization_id, visit_id, waste_station_id)
  SELECT _org, _visit_id, ws.id
    FROM public.waste_stations ws
   WHERE ws.property_id = _prop AND ws.active = true
  ON CONFLICT (visit_id, waste_station_id) DO NOTHING;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$fn$;

REVOKE ALL ON FUNCTION public.record_visit_station_service(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_visit_station_service(uuid) TO authenticated, service_role;

-- Hook it into both completion paths (tech + office). Bodies mirror
-- 20260717160000_visit-lifecycle-qa-fixes.sql with the station-service call
-- added after a successful status transition.
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
   WHERE id = _visit_id AND status IN ('scheduled','in_progress','missed');
  IF NOT FOUND THEN RETURN; END IF;

  PERFORM public.record_visit_station_service(_visit_id);

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
  IF _status NOT IN ('scheduled','in_progress','missed') THEN
    RAISE EXCEPTION 'Only scheduled, in-progress, or missed visits can be completed';
  END IF;

  UPDATE public.visits
     SET status='completed', completed_at = now(), updated_at = now()
   WHERE id = _visit_id AND status IN ('scheduled','in_progress','missed');
  IF NOT FOUND THEN RETURN; END IF;

  PERFORM public.record_visit_station_service(_visit_id);

  SELECT v.subscription_id, v.client_id, s.billing_cadence, s.price_cents
    INTO _sub_id, _client, _cadence, _price
    FROM public.visits v JOIN public.subscriptions s ON s.id = v.subscription_id
   WHERE v.id = _visit_id;

  IF _cadence = 'prepaid' AND COALESCE(_price, 0) > 0 THEN
    PERFORM public.post_credit_entry(_org, _client, -_price, 'visit_debit', NULL, _visit_id, 'Visit completed');
  END IF;
END; $function$;
