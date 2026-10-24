-- An overnight sitter is not out on a walk that evening (#411 review, item 7).
--
-- tg_visits_stay_sitter refuses a second overnight for one sitter on one
-- night. It never looked at the sitter's other visits, so the office could
-- book an overnight at 7 PM and an 8 PM walk across town for the same person.
--
-- An overnight on night D covers the sitter from the start of its arrival
-- window on D until 8 AM on D + 1. Another visit for the same sitter clashes
-- when its window ends after that arrival on D, or starts before 8 AM on
-- D + 1. A daytime drop-in during an overnight is fine, and so is any visit
-- by another sitter, at the home or anywhere else. A visit with no window has
-- no time to compare and never clashes.
--
-- This warns and never refuses, the way stay_contact_gaps does: the office
-- may know the walk is next door. A Postgres WARNING never reaches the caller
-- through the API, so the warning is a function the server functions call
-- after they write, and the office screen shows what it returns.
--
--   overnight_clashes(_visit_ids)   each clash among these visits, either
--                                   side: an overnight that covers another
--                                   visit, or a visit an overnight covers
--   stay_sitter_clashes(_stay_id)   the same for every scheduled visit of a
--                                   stay
--
-- Only rows the caller may write (can_write_org) come back; a sitter or
-- another business gets none.
--
-- Replays into an empty database: three functions. No row is needed and no
-- number is asserted.

CREATE OR REPLACE FUNCTION public.overnight_covers(
  _night date, _arrival time, _on date, _earliest time, _latest time
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(
    (_on = _night AND COALESCE(_latest, _earliest) > _arrival)
    OR (_on = _night + 1 AND _earliest < time '08:00'),
    false);
$function$;

REVOKE ALL ON FUNCTION public.overnight_covers(date, time, date, time, time) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.overnight_covers(date, time, date, time, time) TO authenticated, service_role;

COMMENT ON FUNCTION public.overnight_covers(date, time, date, time, time) IS
  'Whether an overnight on _night arriving from _arrival covers a visit on _on with the window _earliest to _latest: after the arrival that evening, or before 8 AM the next morning. Mirrored by overnightCovers in src/lib/stays.ts. Migration 20261017030000.';

CREATE OR REPLACE FUNCTION public.overnight_clashes(_visit_ids uuid[])
RETURNS TABLE (
  sitter_name text,
  night_of date,
  arrival time,
  visit_on date,
  visit_earliest time,
  visit_latest time,
  client_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH v AS (
    SELECT v.id, v.organization_id, v.assigned_staff_id, v.scheduled_on, v.status, v.client_id,
           s.earliest_time, s.latest_time,
           COALESCE(st.kind = 'overnight', false) AS overnight,
           st.overnight_arrival_earliest AS arrival
      FROM public.visits v
      JOIN public.subscriptions s ON s.id = v.subscription_id
      LEFT JOIN public.stays st ON st.id = s.stay_id
  ),
  mine AS (
    SELECT * FROM v
     WHERE v.id = ANY(_visit_ids)
       AND v.assigned_staff_id IS NOT NULL
       AND v.status = 'scheduled'
       AND public.can_write_org((SELECT auth.uid()), v.organization_id)
  ),
  pairs AS (
    -- One side is the overnight (n), the other the visit it may cover (w).
    SELECT CASE WHEN m.overnight THEN m.scheduled_on ELSE o.scheduled_on END AS n_on,
           CASE WHEN m.overnight THEN m.arrival ELSE o.arrival END AS n_arrival,
           CASE WHEN m.overnight THEN o.scheduled_on ELSE m.scheduled_on END AS w_on,
           CASE WHEN m.overnight THEN o.earliest_time ELSE m.earliest_time END AS w_earliest,
           CASE WHEN m.overnight THEN o.latest_time ELSE m.latest_time END AS w_latest,
           CASE WHEN m.overnight THEN o.client_id ELSE m.client_id END AS w_client,
           m.assigned_staff_id
      FROM mine m
      JOIN v o ON o.assigned_staff_id = m.assigned_staff_id
              AND o.organization_id = m.organization_id
              AND o.id <> m.id
              AND o.scheduled_on BETWEEN m.scheduled_on - 1 AND m.scheduled_on + 1
              AND o.status NOT IN ('canceled', 'skipped', 'missed')
              AND o.overnight <> m.overnight
  )
  SELECT DISTINCT st.display_name, p.n_on, p.n_arrival, p.w_on, p.w_earliest, p.w_latest, c.display_name
    FROM pairs p
    JOIN public.staff st ON st.id = p.assigned_staff_id
    LEFT JOIN public.clients c ON c.id = p.w_client
   WHERE public.overnight_covers(p.n_on, p.n_arrival, p.w_on, p.w_earliest, p.w_latest)
   ORDER BY 2, 4, 5;
$function$;

REVOKE ALL ON FUNCTION public.overnight_clashes(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.overnight_clashes(uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.overnight_clashes(uuid[]) IS
  'For these scheduled visits, the same sitter''s other visits that fall inside an overnight (overnight_covers), from either side. Office only (can_write_org). Warns, never refuses. Migration 20261017030000.';

CREATE OR REPLACE FUNCTION public.stay_sitter_clashes(_stay_id uuid)
RETURNS TABLE (
  sitter_name text,
  night_of date,
  arrival time,
  visit_on date,
  visit_earliest time,
  visit_latest time,
  client_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT * FROM public.overnight_clashes(ARRAY(
    SELECT v.id FROM public.visits v
      JOIN public.subscriptions s ON s.id = v.subscription_id
     WHERE s.stay_id = _stay_id AND v.status = 'scheduled'));
$function$;

REVOKE ALL ON FUNCTION public.stay_sitter_clashes(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stay_sitter_clashes(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.stay_sitter_clashes(uuid) IS
  'overnight_clashes for every scheduled visit of a stay. Office only. Migration 20261017030000.';

-- ── What this file establishes, checked from any starting state ───────────
DO $check$
BEGIN
  IF to_regprocedure('public.overnight_clashes(uuid[])') IS NULL
     OR to_regprocedure('public.stay_sitter_clashes(uuid)') IS NULL
     OR has_function_privilege('anon', 'public.overnight_clashes(uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.stay_sitter_clashes(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.overnight_clashes(uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.stay_sitter_clashes(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the overnight clash functions are missing or have the wrong grants';
  END IF;
  IF NOT public.overnight_covers('2026-12-24', '19:00', '2026-12-24', '19:00', '20:00')
     OR NOT public.overnight_covers('2026-12-24', '19:00', '2026-12-25', '07:00', '07:30')
     OR public.overnight_covers('2026-12-24', '19:00', '2026-12-24', '12:00', '13:00')
     OR public.overnight_covers('2026-12-24', '19:00', '2026-12-24', '17:00', '19:00')
     OR public.overnight_covers('2026-12-24', '19:00', '2026-12-25', '09:00', '10:00')
     OR public.overnight_covers('2026-12-24', '19:00', '2026-12-24', NULL, NULL) THEN
    RAISE EXCEPTION 'overnight_covers does not draw the overnight where this file says';
  END IF;
END
$check$;
