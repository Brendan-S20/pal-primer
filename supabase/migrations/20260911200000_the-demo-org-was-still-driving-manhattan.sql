-- Demo Pet Waste Co is in Detroit and was still being costed as Manhattan.
--
-- ── THE FAULT ─────────────────────────────────────────────────────────────
--
-- 20260805080000 set that organization to `dense_urban`, road_factor 1.45 and
-- park_walk_min 6, under a heading that says what it was for: "The NYC demo
-- org -- its data is Manhattan". That was correct then.
--
-- Its data is no longer Manhattan. Its 110 properties average 42.486, -83.151:
-- Royal Oak, Ferndale, Berkley. Suburban Detroit. The routing settings never
-- moved with the data, and `dense_urban` costs a kilometre at 11 km/h, which
-- effective_speed_kmh documents in as many words as "Manhattan, Boston core".
--
-- Its own two franchise siblings, Northside and Southside, sit in the same
-- metro and are both `suburban`. The parent is the outlier, and the only
-- organization on this database still carrying `dense_urban`.
--
-- ── WHAT 11 km/h COSTS, MEASURED RATHER THAN ASSERTED ─────────────────────
--
-- 1,514 real legs across four distinct days, routed through OSRM:
--
--     actual road speed    p10 28.4   median 36.9   p90 45.0  km/h
--     actual road factor   p10 1.14   median 1.34   p90 1.79  x straight line
--
-- So the estimator was running 3.4x slow. That is the same fault the header of
-- road-legs.server.ts describes from the other side -- "a hop OSRM drives in
-- 22 minutes was costed at 66.7" -- and this is why.
--
-- `suburban` is 28 km/h, which sits at the measured p10. Deliberately at the
-- conservative end: OSRM returns free-flow times with no traffic, no parking
-- and no waiting, so the true door-to-door figure is below its median, and a
-- planner that promises a customer too early is worse than one that does not.
--
-- road_factor stays at 1.45. Measured median is 1.34 and p90 is 1.79, so 1.45
-- is inside the range and on the safe side of it. The siblings use 1.30, which
-- is slightly optimistic against the same measurement; that difference is a
-- judgement for a human and is deliberately not changed here.
--
-- ── WHAT THIS DOES AND DOES NOT TOUCH ─────────────────────────────────────
--
-- It changes an ESTIMATE, not a measurement. drive_minutes() prefers a cached
-- road_legs row whenever one exists and only falls through to this arithmetic
-- on a miss, so this improves the fallback rather than overriding anything
-- measured.
--
-- Scoped to one organization by id. On any database that does not hold it --
-- including an empty one replaying these files from nothing -- this updates no
-- rows, which is correct and is reported rather than asserted.
DO $do$
DECLARE
  _n integer;
BEGIN
  UPDATE public.organizations
     SET area_type = 'suburban'
   WHERE id = '342d4d1e-56f7-4b6e-ad40-524d370e1a36'
     AND area_type = 'dense_urban';

  GET DIAGNOSTICS _n = ROW_COUNT;

  -- A WARNING and never an EXCEPTION. A fresh build has no such organization,
  -- and a replay that fails because production holds a row it does not is the
  -- exact class of fault CLAUDE.md added the empty-database job to catch.
  IF _n = 0 THEN
    RAISE WARNING 'no dense_urban demo organization on this build, so nothing was re-costed (0 rows)';
  ELSE
    RAISE NOTICE 'demo organization moved from dense_urban (11 km/h) to suburban (28 km/h): % row(s)', _n;
  END IF;
END $do$;
