-- A business that drops pet waste no longer ends walker days at its dump site (#980).
--
-- staff_end_point's tier 2 (the nearest active dump site) ignored what the
-- business runs. Dropping pet waste leaves its dump sites active on purpose
-- (20261008120000: nothing is deleted when a line is removed), so a dog-walking
-- business still had its days closed at a landfill while Settings says an empty
-- end means "the last visit". Tier 2 now applies only when pet_waste is in the
-- organization's service_lines. A person's own end address (tier 1) always wins.
-- Dump sites are untouched, so turning pet waste back on restores the routing.
-- Signature, grants and the open-path behaviour (tier 3) are unchanged.

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

  -- 2. The dump -- only for a business that runs pet waste (#980). Dump sites
  --    stay on file when a business stops offering it (20261008120000), and
  --    the settings hint says an empty end means "the last visit", so a
  --    walker's day must not quietly end at a landfill. Turning pet waste
  --    back on brings the sites back into play: nothing is deleted. A
  --    mixed business (pet_waste among other lines) is unchanged.
  IF NOT EXISTS (SELECT 1 FROM public.organizations o
                  WHERE o.id = _org_id AND 'pet_waste' = ANY (o.service_lines)) THEN
    RETURN;
  END IF;
  -- The dump. Nearest to where they START, which is stable: picking the one
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

DO $verify$
BEGIN
  IF pg_get_functiondef('public.staff_end_point(uuid,uuid)'::regprocedure) NOT LIKE '%pet_waste%' THEN
    RAISE EXCEPTION 'staff_end_point does not check pet_waste';
  END IF;
  IF has_function_privilege('authenticated', 'public.staff_end_point(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'staff_end_point is executable by authenticated';
  END IF;
END
$verify$;
