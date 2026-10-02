-- One bad coordinate refused the whole day.
--
-- visits.travel_km is numeric(6,2) and travel_min numeric(6,1): at most
-- 9,999.99 km and 99,999.9 minutes. plan_day_across_staff writes every
-- technician's plan in ONE statement, so a single leg past either limit fails
-- that statement with "numeric field overflow" and nobody's day is routed.
--
-- Found by the routing trials (scripts/routing-trials, scenario
-- `bad-coordinates`): eight good Plano stops, one property at 0,0 and one
-- whose "Paris" geocoded to Paris, France. Auto-routing refused the day for
-- both technicians, and the only thing the dispatcher saw was a toast reading
-- "2026-10-14: numeric field overflow". A geocode on the wrong continent
-- needs nothing more exotic than a sparse address and a geocoder that is not
-- told which country to search.
--
-- Two changes, each for one of the two rows:
--
-- 1. 0,0 is not a place anybody lives. It is what a missing value becomes on
--    its way through a spreadsheet or a client that sends 0 for "none", and
--    the planner reads it as a real point in the Gulf of Guinea -- which also
--    drags the centre of the day's sweep 5,000 km and scrambles the split
--    between technicians. Nor is a latitude outside +-90 or a longitude
--    outside +-180 (a longitude typed into the latitude box). A trigger
--    stores both as NULL -- "no coordinates", which every reader already
--    handles -- and existing rows are cleared the same way.
--
-- 2. A coordinate that is valid but absurd (Paris) is a real place and stays.
--    Its leg is clamped to what the columns can hold when written, so the
--    stop is routed last with a drive the board's plausibility check flags by
--    name, and the other stops of the day are routed normally.
--
-- Replays into an empty database: the function exists by this point, the
-- trigger needs no row, and the backfill updates nothing on a fresh build.

CREATE OR REPLACE FUNCTION public.tg_properties_coordinates_are_a_place()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.latitude IS NULL OR NEW.longitude IS NULL
     OR NEW.latitude = 'NaN'::float8 OR NEW.longitude = 'NaN'::float8
     OR abs(NEW.latitude) > 90 OR abs(NEW.longitude) > 180
     OR (NEW.latitude = 0 AND NEW.longitude = 0) THEN
    NEW.latitude := NULL;
    NEW.longitude := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_properties_coordinates_are_a_place() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS properties_coordinates_are_a_place ON public.properties;
CREATE TRIGGER properties_coordinates_are_a_place
  BEFORE INSERT OR UPDATE OF latitude, longitude ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.tg_properties_coordinates_are_a_place();

UPDATE public.properties
   SET latitude = NULL, longitude = NULL
 WHERE (latitude IS NULL) <> (longitude IS NULL)
    OR latitude = 'NaN'::float8 OR longitude = 'NaN'::float8
    OR abs(latitude) > 90 OR abs(longitude) > 180
    OR (latitude = 0 AND longitude = 0);

DO $splice$
DECLARE
  _def text;
  _new text;
BEGIN
  _def := pg_get_functiondef('public.plan_day_across_staff(uuid,uuid[],date,boolean,text)'::regprocedure);
  IF strpos(_def, 'LEAST(w.t_km, 9999.99)') > 0 THEN
    RETURN;  -- already spliced
  END IF;
  _new := replace(_def,
    E'         travel_km         = w.t_km,\n'
    || E'         travel_min        = w.t_min,\n',
    E'         travel_km         = LEAST(w.t_km, 9999.99),\n'
    || E'         travel_min        = LEAST(w.t_min, 99999.9),\n');
  IF _new = _def THEN
    RAISE EXCEPTION 'plan_day_across_staff no longer writes travel the way this splice expects; re-cut it against the current body.';
  END IF;
  EXECUTE _new;
END
$splice$;

DO $check$
DECLARE
  _src text;
BEGIN
  SELECT prosrc INTO _src FROM pg_proc
   WHERE oid = 'public.plan_day_across_staff(uuid,uuid[],date,boolean,text)'::regprocedure;
  IF strpos(_src, 'LEAST(w.t_km, 9999.99)') = 0 OR strpos(_src, 'LEAST(w.t_min, 99999.9)') = 0 THEN
    RAISE EXCEPTION 'plan_day_across_staff can still overflow visits.travel_km / travel_min';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.properties'::regclass
       AND tgname = 'properties_coordinates_are_a_place' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'properties can still store 0,0 or an out-of-range coordinate';
  END IF;
  IF EXISTS (SELECT 1 FROM public.properties
              WHERE (latitude = 0 AND longitude = 0)
                 OR abs(latitude) > 90 OR abs(longitude) > 180) THEN
    RAISE EXCEPTION 'a property still sits at 0,0 or off the globe';
  END IF;
END
$check$;
