-- A part-timer was given a full-timer's day.
--
-- daily_capacity_minutes (Settings -> Team) sizes each technician's first
-- share of the day: plan_day_across_staff_dryrun splits the service minutes
-- in proportion to it. Then the rebalancing loop runs, and it evens out
-- ABSOLUTE minutes -- max(t) - min(t) over every technician, moving a stop
-- from the busiest to the idlest until the spread is under ten minutes. A
-- 120-minute part-timer and two 480-minute full-timers are "balanced" when
-- all three have the same number of minutes, so the loop undid the
-- proportional split it started from.
--
-- Found by the routing trials (scripts/routing-trials, scenario
-- `edge-cases`): Ned, set to 120 minutes, was planned 154 -- within ten
-- minutes of each full-timer's day -- and nothing said so.
--
-- The loop now evens out each technician's minutes AS A SHARE OF THEIR
-- CAPACITY, expressed in 480-minute days so the ten-minute threshold keeps
-- its meaning for a full-timer. With every capacity at the default -- the
-- common case, and every case the existing tests describe -- the measure is
-- exactly the old one and so is the plan.
--
-- Spliced by name, raising if the body is not the one this was cut against.
-- Replays into an empty database: the function exists by this point and
-- nothing needs a row.

DO $splice$
DECLARE
  _def text;
  _new text;
  _old constant text := E'        SELECT e.s AS sid, public.dry_day_min(_org_id, e.s) AS t\n';
BEGIN
  _def := pg_get_functiondef('public.plan_day_across_staff_dryrun(uuid,uuid[],date,boolean,text)'::regprocedure);
  IF strpos(_def, 'AS t -- as a share of capacity') > 0 THEN
    RETURN;  -- already spliced
  END IF;
  IF (length(_def) - length(replace(_def, _old, ''))) / length(_old) <> 2 THEN
    RAISE EXCEPTION 'plan_day_across_staff_dryrun no longer measures its spread the way this splice expects; re-cut it against the current body.';
  END IF;
  _new := replace(_def, _old,
    E'        SELECT e.s AS sid,\n'
    || E'               public.dry_day_min(_org_id, e.s) * 480.0\n'
    || E'                 / GREATEST(COALESCE((SELECT st.daily_capacity_minutes FROM public.staff st\n'
    || E'                                       WHERE st.id = e.s), 480), 30)\n'
    || E'                 AS t -- as a share of capacity, in 480-minute days\n');
  EXECUTE _new;
END
$splice$;

DO $check$
DECLARE
  _src text;
BEGIN
  SELECT prosrc INTO _src FROM pg_proc
   WHERE oid = 'public.plan_day_across_staff_dryrun(uuid,uuid[],date,boolean,text)'::regprocedure;
  IF (length(_src) - length(replace(_src, 'AS t -- as a share of capacity', '')))
       / length('AS t -- as a share of capacity') <> 2 THEN
    RAISE EXCEPTION 'plan_day_across_staff_dryrun still balances absolute minutes, ignoring capacity';
  END IF;
END
$check$;
