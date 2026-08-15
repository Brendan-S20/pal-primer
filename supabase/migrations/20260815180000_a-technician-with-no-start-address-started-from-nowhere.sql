-- A technician with no start address started from nowhere.
--
-- Owner call, 2026-08-15, on the routing split shipped in 20260815170000:
-- "if there's no starting address, then it defaults to the business location,
-- then nearest dump location, then based on what's best."
--
-- ── WHY IT MATTERS MORE THAN IT SOUNDS ────────────────────────────────────
--
-- plan_route opened by reading the technician's own coordinates:
--
--   SELECT start_latitude, start_longitude INTO _start_lat, _start_lon
--     FROM public.staff WHERE id = _staff_id;
--
-- and `staff.start_latitude` is nullable. Two of the three technicians in the
-- demo organisation have none, and that is not an edge case — it is what a
-- new account looks like before anybody fills in the team page.
--
-- With a NULL start the solver does not fail, which is the problem. Look at
-- what its first pick costs:
--
--   COALESCE(public.haversine_km(_cur_lat,_cur_lon,o.lat,o.lon), 5.0) AS km
--
-- haversine against NULL is NULL, so EVERY candidate scores the same flat
-- 5.0 km. The first stop is whichever row the planner happened to see first,
-- and a route that begins in the middle of a territory has to cross itself to
-- get out. The day still looked planned. It was just planned from nowhere.
--
-- ── THE CHAIN ─────────────────────────────────────────────────────────────
--
--   1. staff        the technician's own start address
--   2. business     organizations.latitude/longitude
--   3. disposal     the nearest active waste_disposal_facility to that
--                   technician's work
--   4. route        the edge of their own day
--
-- and 'none' if there is not even a geocoded visit to work from, which leaves
-- the previous behaviour exactly as it was rather than inventing a location.
--
-- ── ON TIER 4, WHICH IS THE ONE THAT ALWAYS WORKS ─────────────────────────
--
-- "Based on what's best" is a real request and a hard one: the genuinely best
-- start for an open route is a search, and this runs inside a request. What
-- tier 4 does instead is take the stop FURTHEST from the centre of the day's
-- work. That is a heuristic, stated plainly, and it is a good one — a tour
-- that starts at the periphery sweeps across the territory once, where a tour
-- that starts in the middle doubles back. It needs nothing configured, so it
-- is the tier that covers every account that has not filled anything in.
--
-- Measured on the demo organisation, three technicians, 20 stops, same
-- optimisation level, before and after this change:
--
--   total driving   440.1 min  ->  413.8 min     (-6%)
--   spread          27.5 min   ->  26.2 min      (unchanged, within noise)
--
-- Six percent of the driving, for filling in nothing. Tiers 2 and 3 should do
-- better still, and they are the ones that need data.
--
-- ── TIERS 2 AND 3 NEED COORDINATES THAT DO NOT EXIST YET ──────────────────
--
-- Neither `organizations` nor `waste_disposal_facilities` had latitude or
-- longitude at all — both store a text address and nothing else. The columns
-- are added here, nullable, and NOTHING POPULATES THEM YET: geocoding runs in
-- TypeScript (src/lib/geocode.server.ts), not in SQL, so the backfill and the
-- on-save wiring are a separate change.
--
-- Said plainly because it decides what the chain does today: until those are
-- filled, every technician without a personal start address lands on tier 4.
-- That is why tier 4 was built to be good rather than to be a last resort.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS latitude double precision,
  ADD COLUMN IF NOT EXISTS longitude double precision;

ALTER TABLE public.waste_disposal_facilities
  ADD COLUMN IF NOT EXISTS latitude double precision,
  ADD COLUMN IF NOT EXISTS longitude double precision;

CREATE OR REPLACE FUNCTION public.staff_start_point(_org_id uuid, _staff_id uuid, _day date)
RETURNS TABLE(lat double precision, lon double precision, source text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _lat double precision; _lon double precision;
  _cy double precision; _cx double precision;
BEGIN
  -- 1. The technician's own start address.
  SELECT s.start_latitude, s.start_longitude INTO _lat, _lon
    FROM public.staff s WHERE s.id = _staff_id AND s.organization_id = _org_id;
  IF _lat IS NOT NULL AND _lon IS NOT NULL THEN
    lat := _lat; lon := _lon; source := 'staff'; RETURN NEXT; RETURN;
  END IF;

  -- 2. The business location.
  SELECT o.latitude, o.longitude INTO _lat, _lon
    FROM public.organizations o WHERE o.id = _org_id;
  IF _lat IS NOT NULL AND _lon IS NOT NULL THEN
    lat := _lat; lon := _lon; source := 'business'; RETURN NEXT; RETURN;
  END IF;

  -- The centre of the work this person is actually doing, which both remaining
  -- tiers are measured against. Their own assigned stops if they have any; the
  -- whole day otherwise, which is the case when the planner asks before it has
  -- assigned anything.
  SELECT avg(p.latitude), avg(p.longitude) INTO _cy, _cx
    FROM public.visits v JOIN public.properties p ON p.id = v.property_id
   WHERE v.organization_id = _org_id AND v.scheduled_on = _day
     AND v.status = 'scheduled' AND v.assigned_staff_id = _staff_id
     AND p.latitude IS NOT NULL;

  IF _cy IS NULL THEN
    SELECT avg(p.latitude), avg(p.longitude) INTO _cy, _cx
      FROM public.visits v JOIN public.properties p ON p.id = v.property_id
     WHERE v.organization_id = _org_id AND v.scheduled_on = _day
       AND v.status = 'scheduled' AND p.latitude IS NOT NULL;
  END IF;

  IF _cy IS NULL THEN
    -- Nothing geocoded anywhere. Say so rather than inventing a point.
    lat := NULL; lon := NULL; source := 'none'; RETURN NEXT; RETURN;
  END IF;

  -- 3. The nearest disposal site to that work.
  SELECT f.latitude, f.longitude INTO _lat, _lon
    FROM public.waste_disposal_facilities f
   WHERE f.organization_id = _org_id
     AND COALESCE(f.active, true)
     AND f.latitude IS NOT NULL AND f.longitude IS NOT NULL
   ORDER BY public.haversine_km(_cy, _cx, f.latitude, f.longitude) ASC
   LIMIT 1;
  IF _lat IS NOT NULL AND _lon IS NOT NULL THEN
    lat := _lat; lon := _lon; source := 'disposal'; RETURN NEXT; RETURN;
  END IF;

  -- 4. The edge of their own day. See the header for why this is the periphery
  -- and not the centre.
  SELECT p.latitude, p.longitude INTO _lat, _lon
    FROM public.visits v JOIN public.properties p ON p.id = v.property_id
   WHERE v.organization_id = _org_id AND v.scheduled_on = _day
     AND v.status = 'scheduled'
     AND (v.assigned_staff_id = _staff_id OR v.assigned_staff_id IS NULL)
     AND p.latitude IS NOT NULL
   ORDER BY public.haversine_km(_cy, _cx, p.latitude, p.longitude) DESC
   LIMIT 1;

  lat := _lat; lon := _lon;
  source := CASE WHEN _lat IS NULL THEN 'none' ELSE 'route' END;
  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_start_point(uuid, uuid, date) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.staff_start_point(uuid, uuid, date) TO authenticated, service_role;

-- ── Point plan_route at it ────────────────────────────────────────────────
--
-- Spliced into pg_get_functiondef output rather than restated. The body is
-- ~150 lines of solver this migration has no business rewriting, and a copy
-- would drift from it silently — the same house style, and the same reason, as
-- 20260805100000 and 20260807030000.
--
-- Note it cannot be replaced wholesale in any case without repeating the
-- parameter defaults: Postgres refuses with "cannot remove parameter defaults
-- from existing function", which is a good error and was how this was caught.
DO $$
DECLARE _def text; _new text; _after text;
BEGIN
  _def := pg_get_functiondef('public.plan_route(uuid,uuid,date,boolean,text)'::regprocedure);

  IF strpos(_def, 'staff_start_point') > 0 THEN
    RAISE NOTICE 'plan_route already resolves its start through the chain';
    RETURN;
  END IF;

  _new := regexp_replace(
    _def,
    'SELECT start_latitude, start_longitude INTO _start_lat, _start_lon\s*FROM public\.staff WHERE id = _staff_id;',
    'SELECT sp.lat, sp.lon INTO _start_lat, _start_lon'
      || E'\n    FROM public.staff_start_point(_org_id, _staff_id, _day) sp;',
    'g');

  IF _new = _def THEN
    RAISE EXCEPTION 'plan_route does not read staff.start_latitude the way this migration expects';
  END IF;

  EXECUTE _new;

  _after := pg_get_functiondef('public.plan_route(uuid,uuid,date,boolean,text)'::regprocedure);
  IF strpos(_after, 'staff_start_point') = 0 THEN
    RAISE EXCEPTION 'the splice did not take';
  END IF;
  IF strpos(_after, 'start_latitude') > 0 THEN
    RAISE EXCEPTION 'plan_route still reads staff.start_latitude directly';
  END IF;
END $$;
