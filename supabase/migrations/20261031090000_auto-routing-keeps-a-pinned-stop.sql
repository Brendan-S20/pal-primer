-- Auto-routing keeps a stop that was pinned to its technician (#609, D10).
--
-- A dispatcher assigns some visits by hand for a reason the planner cannot
-- see: the one walker a dog tolerates, the tech who holds the key. The panel
-- now keeps every current assignment by default and moves work between
-- techs only when the dispatcher opts in for that one run. A pinned visit is
-- kept even then.
--
-- One column, and two named functions spliced in place:
--
--   * route_day_inputs: a pinned visit with a technician is `fixed`, whatever
--     _reassign says, and the read says it is pinned.
--   * apply_route_plan: refuses a plan that moves a pinned visit to anyone
--     else, and does not take a pinned visit off its technician when the
--     plan leaves it off every route.
--
-- RLS on visits is unchanged: the column is written through the same
-- policies as the rest of the row.

ALTER TABLE public.visits
  ADD COLUMN IF NOT EXISTS route_pinned boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.visits.route_pinned IS
  'Kept with its assigned technician by auto-routing, even on a run that may move work between techs. Set by hand in the visit drawer. Migration 20261031090000.';

-- ── route_day_inputs ─────────────────────────────────────────────────────
DO $read$
DECLARE
  def text;
  old_fixed constant text :=
    '''fixed'', (NOT COALESCE(_reassign, false) AND v.assigned_staff_id IS NOT NULL),';
  new_fixed constant text :=
    '''fixed'', ((NOT COALESCE(_reassign, false) OR v.route_pinned) AND v.assigned_staff_id IS NOT NULL),'
    || E'\n           ''pinned'', v.route_pinned,';
  n integer;
BEGIN
  def := pg_get_functiondef('public.route_day_inputs(uuid,uuid[],date,boolean)'::regprocedure);
  IF strpos(def, 'v.route_pinned') > 0 THEN
    RETURN;
  END IF;
  n := (length(def) - length(replace(def, old_fixed, ''))) / length(old_fixed);
  IF n <> 1 THEN
    RAISE EXCEPTION 'route_day_inputs carries the fixed line % time(s), not once; the splice anchor moved.', n;
  END IF;
  EXECUTE replace(def, old_fixed, new_fixed);
END
$read$;

-- ── apply_route_plan ─────────────────────────────────────────────────────
DO $write$
DECLARE
  def text;
  guard_anchor constant text :=
    'RAISE EXCEPTION ''The plan moves a stop between technicians without permission to reassign'';'
    || E'\n  END IF;';
  guard constant text :=
    E'\n\n  -- A pinned stop stays with its technician, reassign or not (#609).'
    || E'\n  IF EXISTS ('
    || E'\n       SELECT 1 FROM _arp_in a JOIN public.visits v ON v.id = a.vid'
    || E'\n        WHERE v.route_pinned AND v.assigned_staff_id IS NOT NULL'
    || E'\n          AND v.assigned_staff_id <> a.sid) THEN'
    || E'\n    RAISE EXCEPTION ''The plan moves a stop that is pinned to its technician'';'
    || E'\n  END IF;';
  old_left constant text :=
    'SET assigned_staff_id = CASE WHEN COALESCE(_reassign, false) THEN NULL ELSE v.assigned_staff_id END,';
  new_left constant text :=
    'SET assigned_staff_id = CASE WHEN COALESCE(_reassign, false) AND NOT v.route_pinned THEN NULL ELSE v.assigned_staff_id END,';
  n integer;
BEGIN
  def := pg_get_functiondef(
    'public.apply_route_plan(uuid,uuid[],date,boolean,jsonb,boolean,uuid[])'::regprocedure);
  IF strpos(def, 'route_pinned') > 0 THEN
    RETURN;
  END IF;
  n := (length(def) - length(replace(def, guard_anchor, ''))) / length(guard_anchor);
  IF n <> 1 THEN
    RAISE EXCEPTION 'apply_route_plan carries the reassign check % time(s), not once; the splice anchor moved.', n;
  END IF;
  n := (length(def) - length(replace(def, old_left, ''))) / length(old_left);
  IF n <> 1 THEN
    RAISE EXCEPTION 'apply_route_plan carries the unassign line % time(s), not once; the splice anchor moved.', n;
  END IF;
  def := replace(def, guard_anchor, guard_anchor || guard);
  def := replace(def, old_left, new_left);
  EXECUTE def;
END
$write$;

-- ── What this file establishes ───────────────────────────────────────────
DO $post$
DECLARE
  _src text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'visits'
       AND column_name = 'route_pinned' AND is_nullable = 'NO'
       AND column_default = 'false'
  ) THEN
    RAISE EXCEPTION 'visits.route_pinned is missing, nullable, or not false by default';
  END IF;

  SELECT p.prosrc INTO _src FROM pg_proc p
   WHERE p.oid = 'public.route_day_inputs(uuid,uuid[],date,boolean)'::regprocedure;
  IF strpos(_src, '(NOT COALESCE(_reassign, false) OR v.route_pinned) AND v.assigned_staff_id IS NOT NULL') = 0
     OR strpos(_src, '''pinned'', v.route_pinned') = 0 THEN
    RAISE EXCEPTION 'route_day_inputs does not hold a pinned visit on its technician';
  END IF;
  -- The duration splice from 20261024100200 survived this one.
  IF strpos(_src, 'stop_service_min(v.duration_min, sv.default_duration_min, p.service_duration_min)') = 0 THEN
    RAISE EXCEPTION 'route_day_inputs lost the visit length';
  END IF;

  SELECT p.prosrc INTO _src FROM pg_proc p
   WHERE p.oid = 'public.apply_route_plan(uuid,uuid[],date,boolean,jsonb,boolean,uuid[])'::regprocedure;
  IF strpos(_src, 'The plan moves a stop that is pinned to its technician') = 0 THEN
    RAISE EXCEPTION 'apply_route_plan does not refuse a plan that moves a pinned visit';
  END IF;
  IF strpos(_src, 'COALESCE(_reassign, false) AND NOT v.route_pinned THEN NULL') = 0
     OR strpos(_src, 'COALESCE(_reassign, false) THEN NULL ELSE') > 0 THEN
    RAISE EXCEPTION 'apply_route_plan can still take a pinned visit off its technician';
  END IF;
  IF strpos(_src, 'stop_service_min(v.duration_min, sv.default_duration_min, p.service_duration_min)') = 0 THEN
    RAISE EXCEPTION 'apply_route_plan lost the visit length';
  END IF;

  -- The splice keeps the grants (CREATE OR REPLACE does), and anon still
  -- cannot reach either function.
  IF has_function_privilege('anon', 'public.route_day_inputs(uuid,uuid[],date,boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.apply_route_plan(uuid,uuid[],date,boolean,jsonb,boolean,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can call a routing function';
  END IF;
END
$post$;
