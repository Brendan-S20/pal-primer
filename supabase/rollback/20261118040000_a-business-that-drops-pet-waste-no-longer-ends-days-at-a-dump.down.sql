-- Rolls back 20261118040000: staff_end_point as 20260831150000 defined it.
CREATE OR REPLACE FUNCTION public.staff_end_point(_org_id uuid, _staff_id uuid)
RETURNS TABLE(lat double precision, lon double precision)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE _lat double precision; _lon double precision;
BEGIN
  -- 1. What the technician's own record says.
  SELECT s.end_latitude, s.end_longitude INTO _lat, _lon
    FROM public.staff s
   WHERE s.id = _staff_id AND s.organization_id = _org_id;
  IF _lat IS NOT NULL AND _lon IS NOT NULL THEN
    RETURN QUERY SELECT _lat, _lon; RETURN;
  END IF;

  -- 2. The dump. Nearest to where they START, which is stable: picking the one
  --    nearest the LAST STOP would depend on the order, and the order is what
  --    this is being used to choose. Most organizations will have exactly one,
  --    and then the ordering does not arise at all.
  SELECT f.latitude, f.longitude INTO _lat, _lon
    FROM public.waste_disposal_facilities f
    LEFT JOIN public.staff s ON s.id = _staff_id
   WHERE f.organization_id = _org_id
     AND f.active
     AND f.latitude IS NOT NULL AND f.longitude IS NOT NULL
   ORDER BY COALESCE(
              public.haversine_km(s.start_latitude, s.start_longitude, f.latitude, f.longitude),
              9999) ASC,
            f.name, f.id
   LIMIT 1;
  IF _lat IS NOT NULL AND _lon IS NOT NULL THEN
    RETURN QUERY SELECT _lat, _lon; RETURN;
  END IF;

  -- 3. Nothing. The caller plans an open path, exactly as before this file.
  RETURN;
END;
$fn$;

REVOKE ALL ON FUNCTION public.staff_end_point(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_end_point(uuid, uuid) TO service_role;

