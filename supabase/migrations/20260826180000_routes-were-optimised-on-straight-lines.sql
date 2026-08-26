-- Routes were optimised on straight lines, not streets.
--
-- ── THE MEASUREMENT ──────────────────────────────────────────────────────
--
-- Four consecutive legs of a real demo day, compared against OSRM driving
-- directions over the actual road network:
--
--   leg    straight   model est   real road   ratio   OSRM min   model min
--   0->1    7.68 km    11.13 km    14.88 km   1.94x     22.0        66.7
--   1->2    7.86 km    11.39 km    11.34 km   1.44x     17.3        68.1
--   2->3    5.41 km     7.85 km     9.34 km   1.73x     13.9        48.8
--   3->4    2.93 km     4.25 km     7.10 km   2.42x     10.3        29.2
--
-- Two errors, pointing opposite ways:
--
-- DISTANCE is understated. `road_factor` is one number, 1.45, and the real
-- ratio on these legs runs 1.44x to 2.42x. A straight line across the East
-- River is not a road, and no single multiplier can know that.
--
-- TIME is badly overstated. `dense_urban` assumes 11 km/h, so the model calls
-- a 22 minute hop 66.7 minutes. Inter-borough legs use bridges and highways at
-- around 40 km/h; the 11 km/h figure describes crawling between two addresses
-- on the same avenue, which is a different journey.
--
-- The consequence that matters is not the ETA. It is that the solver minimises
-- the WRONG QUANTITY. Nearest-neighbour and 2-opt over straight-line distance
-- produce a good straight-line route, and straight-line and street distance
-- disagree by up to 2.4x on a single leg here. So the order can be wrong on
-- the road however well the optimiser does its job.
--
-- ── WHAT THIS ADDS, AND WHY IT CHANGES NOTHING ON ITS OWN ────────────────
--
-- A cache of real road legs, and one line in drive_minutes() that prefers it.
-- On a miss the existing haversine model answers exactly as before, so this
-- migration on its own is a no-op: every leg is a miss until something fills
-- the table. Filling it is the server's job, because Postgres has no business
-- making outbound HTTP calls on a dispatcher's click.
--
-- UNITS. Stored in metres and seconds because that is what a routing engine
-- returns and what the rest of the routing model already uses -- see
-- src/lib/measures.ts, which is explicit that the model is metric all the way
-- down and converts at the edge. This is a United States product and every
-- number a person reads is miles and miles per hour; that conversion belongs
-- in one place at the surface, not scattered through the planner, which is
-- exactly why the settings page already stores km/h and shows mph.
--
-- Coordinates are rounded to 5 decimal places, about a metre, so that two
-- visits at the same address share a row rather than missing by a rounding
-- tick. The pair is stored directed: A->B and B->A are different rows because
-- one-way systems make them genuinely different journeys, which is most of the
-- point.

CREATE TABLE IF NOT EXISTS public.road_legs (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  from_lat numeric(9,5) NOT NULL,
  from_lon numeric(9,5) NOT NULL,
  to_lat   numeric(9,5) NOT NULL,
  to_lon   numeric(9,5) NOT NULL,
  meters   numeric NOT NULL CHECK (meters >= 0),
  seconds  numeric NOT NULL CHECK (seconds >= 0),
  source   text NOT NULL DEFAULT 'osrm',
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, from_lat, from_lon, to_lat, to_lon)
);

ALTER TABLE public.road_legs ENABLE ROW LEVEL SECURITY;

-- Readable by the org it belongs to; written only by the server. A tenant
-- cannot see another tenant's stop coordinates, which is what this table is
-- made of -- the same reason staff_start_point was closed to authenticated in
-- 20260820060000.
DROP POLICY IF EXISTS "Members read own road legs" ON public.road_legs;
CREATE POLICY "Members read own road legs" ON public.road_legs
  FOR SELECT USING (public.is_org_member((SELECT auth.uid()), organization_id));

COMMENT ON TABLE public.road_legs IS
  'Cached driving distance and duration between two points on the real road network, per organization. Populated by the server from a routing engine; drive_minutes() falls back to the haversine estimate on a miss.';

-- ── drive_minutes prefers a measured leg ─────────────────────────────────
--
-- Unchanged apart from the lookup at the top. The estimate stays underneath
-- for every pair nothing has measured yet, which on the day this ships is all
-- of them.
CREATE OR REPLACE FUNCTION public.drive_minutes(
  _org_id uuid, _lat1 double precision, _lon1 double precision,
  _lat2 double precision, _lon2 double precision)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE _o RECORD; _km numeric; _speed numeric; _secs numeric;
BEGIN
  IF _lat1 IS NULL OR _lon1 IS NULL OR _lat2 IS NULL OR _lon2 IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT avg_speed_kmh, traffic_profile, road_factor, area_type, park_walk_min
    INTO _o FROM public.organizations WHERE id = _org_id;

  -- Measured, if somebody has measured it. Rounded to match how it is stored.
  SELECT rl.seconds INTO _secs
    FROM public.road_legs rl
   WHERE rl.organization_id = _org_id
     AND rl.from_lat = round(_lat1::numeric, 5) AND rl.from_lon = round(_lon1::numeric, 5)
     AND rl.to_lat   = round(_lat2::numeric, 5) AND rl.to_lon   = round(_lon2::numeric, 5);

  IF _secs IS NOT NULL THEN
    -- Parking and walking is still ours to add: a routing engine drops you at
    -- the kerb, and the technician still has to get to the gate.
    RETURN _secs / 60.0 + COALESCE(_o.park_walk_min, 2);
  END IF;

  _km := public.haversine_km(_lat1, _lon1, _lat2, _lon2) * COALESCE(_o.road_factor, 1.30);

  _speed := CASE
              WHEN _o.avg_speed_kmh IS NOT NULL AND _o.avg_speed_kmh <> 30
                THEN _o.avg_speed_kmh
              ELSE public.effective_speed_kmh(_o.area_type, _o.traffic_profile)
            END;

  RETURN (_km / NULLIF(_speed, 0)) * 60.0 + COALESCE(_o.park_walk_min, 2);
END;
$function$;

-- authenticated is REVOKED, and the first version of this file granted it.
--
-- drive_minutes is SECURITY DEFINER, takes an organization id, and never asks
-- who is calling -- so an EXECUTE grant to `authenticated` lets any signed-in
-- user of any tenant measure distances between another tenant's customers.
-- That is the exact shape 20260820060000 closed for staff_start_point, and
-- six-helpers-that-answered-questions-about-other-peoples-tenants caught it
-- here within one test run.
--
-- Nothing needs it: it is only ever called from inside plan_visits and the
-- planner, which are SECURITY DEFINER and do their own authorization, and
-- nothing in src/ calls it by RPC.
REVOKE ALL ON FUNCTION public.drive_minutes(uuid, double precision, double precision, double precision, double precision)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.drive_minutes(uuid, double precision, double precision, double precision, double precision)
  TO service_role;

DO $verify$
DECLARE _src text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='road_legs') THEN
    RAISE EXCEPTION 'road_legs was not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname='road_legs' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'road_legs has RLS disabled, and it holds customer coordinates';
  END IF;

  SELECT p.prosrc INTO _src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='drive_minutes' LIMIT 1;
  IF _src NOT LIKE '%public.road_legs%' THEN
    RAISE EXCEPTION 'drive_minutes does not consult the measured legs';
  END IF;
  -- The fallback is the whole safety argument. Losing it would make every
  -- unmeasured pair NULL, and plan_visits COALESCEs NULL travel to zero.
  IF _src NOT LIKE '%haversine_km%' THEN
    RAISE EXCEPTION 'drive_minutes lost its estimate fallback; unmeasured legs would cost nothing';
  END IF;

  -- It takes a tenant id and does not check the caller, so it must not be
  -- reachable by one. Asserted here as well as in the source test, because a
  -- replay can prove it from any starting state.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'drive_minutes'
       AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
         OR has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) THEN
    RAISE EXCEPTION 'drive_minutes is executable by anon or authenticated, and it answers questions about any tenant';
  END IF;
END
$verify$;
