-- Auto-routing has been refusing every day since 2026-09-03.
--
-- ── THE SYMPTOM ───────────────────────────────────────────────────────────
--
-- Pressing Auto-routing produces one banner per day in the range:
--
--     2026-09-11: permission denied for function plan_day_across_staff
--     2026-09-12: permission denied for function plan_day_across_staff
--     ... 5 more day(s) skipped.
--
-- Every day refused, none planned. On the demo workspace that leaves 25, 19,
-- 19, 19 and 17 visits sitting Unassigned across the week while the lanes for
-- Jordan, Sam and Taylor stay empty.
--
-- ── THE CAUSE ─────────────────────────────────────────────────────────────
--
-- 20260903120000 rewrote the planner to cost the closing drive, and while
-- re-granting the functions it touched it applied the internal-helper pattern
-- to the ENTRY POINT:
--
--     REVOKE ALL ON FUNCTION public.plan_day_across_staff(...) FROM public, anon, authenticated;
--     GRANT EXECUTE ON FUNCTION public.plan_day_across_staff(...) TO service_role;
--
-- That pattern is right for road_km, route_segment_min, staff_end_point,
-- closing_drive_min, dry_day_min, plan_visits, plan_route and
-- plan_day_across_staff_dryrun. Every one of them is reached only from inside
-- another SECURITY DEFINER function, so `authenticated` never calls them and
-- revoking it removes reachable surface for free.
--
-- plan_day_across_staff is not one of those. It is what the Apply button
-- calls. src/lib/visits.functions.ts runs it through the server function's
-- Supabase client, which is built from SUPABASE_PUBLISHABLE_KEY plus the
-- user's JWT (src/integrations/supabase/auth-middleware.ts), so it executes as
-- `authenticated`. Since 2026-09-03 that role has had no EXECUTE.
--
-- Two things make it clear this was collateral rather than a decision.
--
-- First, the function's own first statement is
--
--     IF NOT public.can_write_org(auth.uid(), _org_id) THEN
--       RAISE EXCEPTION 'Not authorized to plan routes for this organization';
--
-- and `auth.uid()` is NULL under service_role. A service_role-only grant is
-- therefore not a stricter configuration, it is one in which the function
-- cannot succeed for anybody. The guard only means anything when the caller
-- is `authenticated`, which is what it was written for.
--
-- Second, every other REVOKE/GRANT pair in that migration carries a comment
-- explaining why service_role alone is correct for that function. This one has
-- none.
--
-- ── WHY PREVIEW KEPT WORKING, WHICH IS WHY NOBODY SAW IT SOONER ───────────
--
-- preview_optimize still holds EXECUTE for `authenticated`, so the panel could
-- still cost a week and show its numbers. Only Apply refused. A dispatcher
-- sees a working preview followed by a wall of per-day refusals, which reads
-- like a data problem with those days rather than a permission on one function.
--
-- ── WHAT THIS CHANGES ─────────────────────────────────────────────────────
--
-- The grant, and nothing else. The function body is untouched, `anon` stays
-- revoked, and the org guard above still does the tenant check on every call.
GRANT EXECUTE ON FUNCTION public.plan_day_across_staff(uuid, uuid[], date, boolean, text)
  TO authenticated;

DO $post$
DECLARE
  _fn regprocedure := 'public.plan_day_across_staff(uuid, uuid[], date, boolean, text)'::regprocedure;
BEGIN
  -- Asserted rather than warned, because a replay can prove this from any
  -- starting state: it is what this migration ESTABLISHES, not something
  -- measured from a database that already exists.
  IF NOT has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'plan_day_across_staff is still not executable by authenticated; Apply would go on refusing every day';
  END IF;

  -- The point was never to widen it. anon must stay out, and the org guard
  -- inside the function is what makes the authenticated grant safe.
  IF has_function_privilege('anon', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'plan_day_across_staff is executable by anon, which this migration must not have done';
  END IF;

  -- The helpers this function calls stay internal. If one of them has picked
  -- up an authenticated grant, the lockdown that 20260903120000 got right has
  -- been undone somewhere and that is worth stopping on.
  IF has_function_privilege(
       'authenticated',
       'public.plan_day_across_staff_dryrun(uuid, uuid[], date, boolean, text)'::regprocedure,
       'EXECUTE') THEN
    RAISE EXCEPTION 'plan_day_across_staff_dryrun is reachable by authenticated; it is internal to the planner and should not be';
  END IF;
END
$post$;
