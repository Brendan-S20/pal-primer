-- Walker assignment is narrow and atomic (#731, after review of #733).
--
-- Two faults in the walker batch, both found by reading the code against the
-- policies it runs under.
--
-- ── 1. A dispatcher could not save a plan's walker ───────────────────────
--
-- setPlanWalker admitted a dispatcher (can_write_org) and then wrote
-- subscriptions through the signed-in client. The subscriptions UPDATE policy
-- is manage_pricing (20260810120000, "subscriptions: priced by whoever sets
-- pricing (update)"), which a dispatcher does not hold, so the UPDATE matched
-- no row and the dispatcher read "That plan was not found."
--
-- The fix is not to widen that policy: it guards a plan's price, cadence and
-- dates, and a dispatcher is deliberately not trusted with them. It is the
-- shape book_training_package_plan already uses (20261027130000): a SECURITY
-- DEFINER function that takes ONLY what it writes. set_plan_walker takes a
-- plan and a walker, checks can_write_org on the plan's own business, checks
-- the walker is an active person there who runs routes, and writes
-- subscriptions.assigned_staff_id and nothing else. A plan in another business
-- and a plan that does not exist read the same, "Not authorized", as the
-- precedent does.
--
-- ── 2. Assign by capacity could overwrite a hand assignment ──────────────
--
-- The server read the day, planned, then wrote
--   UPDATE walk_groups SET assigned_staff_id = X WHERE id = g AND assigned_staff_id IS NULL
-- which guards only the group row. copy_walk_group_walker (20261015200000)
-- then copies X onto every scheduled member. A dispatcher who assigned or
-- pinned a member by hand between the read and that write had their walker
-- replaced: the copy waits for the dispatcher's row lock, and under READ
-- COMMITTED it re-reads the row afterwards, still matches it, and writes X.
--
-- assign_walk_group_if_open makes the check and the write one atomic step:
--   * lock the group row (a walk joining the group already takes this lock,
--     validate_walk_group_member);
--   * lock EVERY row in the group, unconditionally. A conditional FOR UPDATE
--     is not enough: a member whose hand assignment is not yet committed still
--     reads as unassigned, so a WHERE on assigned_staff_id would skip it
--     without waiting for it;
--   * only then read, in a new statement, whether any walk still to happen is
--     held or pinned; if so, write nothing.
-- A hand assignment committed first is seen and the group is left alone. One
-- that arrives after the locks waits, and lands after the copy, so it is the
-- assignment that stands. Either way nobody's hand assignment is replaced.
--
-- What does NOT change: choosing a group's walker by hand (setWalkGroupWalker)
-- still copies onto its scheduled walks, as before; that is a person deciding.
-- No policy, no table and no existing function is altered.
--
-- Replays into an empty database: both functions are new, nothing reads or
-- writes rows, and the check reads the catalog.

-- ── set_plan_walker ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_plan_walker(_subscription_id uuid, _walker_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _org uuid;
  _name text;
  _active boolean;
  _runs boolean;
BEGIN
  SELECT s.organization_id INTO _org FROM public.subscriptions s WHERE s.id = _subscription_id;
  IF NOT FOUND OR NOT public.can_write_org((SELECT auth.uid()), _org) THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege', MESSAGE = 'Not authorized';
  END IF;
  IF _walker_id IS NOT NULL THEN
    SELECT st.display_name, COALESCE(st.active, true), COALESCE(st.is_field_tech, false)
      INTO _name, _active, _runs
      FROM public.staff st
     WHERE st.id = _walker_id AND st.organization_id = _org;
    IF NOT FOUND OR NOT _active THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Choose a walker from this business.';
    END IF;
    IF NOT _runs THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('%s is not set up to run routes. Turn on "Runs routes" for them in Settings → Users & roles first.',
                         COALESCE(NULLIF(btrim(_name), ''), 'That person'));
    END IF;
  END IF;
  UPDATE public.subscriptions SET assigned_staff_id = _walker_id WHERE id = _subscription_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_plan_walker(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_plan_walker(uuid, uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.set_plan_walker(uuid, uuid) IS
  'Sets a walk plan''s walker (subscriptions.assigned_staff_id) for anyone public.can_write_org admits (owner, office_manager, dispatcher). Writes no other column; the subscriptions write policy stays manage_pricing. Migration 20261108150200 (#731).';

-- ── assign_walk_group_if_open ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.assign_walk_group_if_open(_group_id uuid, _walker_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _org uuid;
  _walker uuid;
BEGIN
  SELECT g.organization_id INTO _org FROM public.walk_groups g WHERE g.id = _group_id;
  IF NOT FOUND OR NOT public.can_write_org((SELECT auth.uid()), _org) THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege', MESSAGE = 'Not authorized';
  END IF;
  IF _walker_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Choose a walker.';
  END IF;

  -- 1. The group, then 2. every walk in it, always in that order.
  SELECT g.assigned_staff_id INTO _walker FROM public.walk_groups g WHERE g.id = _group_id FOR UPDATE;
  IF _walker IS NOT NULL THEN
    RETURN 'has_walker';
  END IF;
  PERFORM 1 FROM public.visits v WHERE v.walk_group_id = _group_id ORDER BY v.id FOR UPDATE;

  -- 3. Read under those locks, in a statement of its own, so what is read is
  --    what was committed before the locks were granted.
  IF EXISTS (
    SELECT 1 FROM public.visits v
     WHERE v.walk_group_id = _group_id
       AND v.status IN ('scheduled', 'in_progress')
       AND (v.assigned_staff_id IS NOT NULL OR v.route_pinned)
  ) THEN
    RETURN 'members_assigned';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.visits v
     WHERE v.walk_group_id = _group_id AND v.status IN ('scheduled', 'in_progress')
  ) THEN
    RETURN 'empty';
  END IF;

  -- The cap (walk_groups_walker_cap), the walker's business
  -- (validate_walk_group) and the walker's day off and runs-routes (the
  -- visits guards, through copy_walk_group_walker) are still the database's.
  UPDATE public.walk_groups SET assigned_staff_id = _walker_id WHERE id = _group_id;
  RETURN 'assigned';
END;
$function$;

REVOKE ALL ON FUNCTION public.assign_walk_group_if_open(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_walk_group_if_open(uuid, uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.assign_walk_group_if_open(uuid, uuid) IS
  'Gives a group walk to a walker only if, under row locks on the group and every walk in it, the group has no walker and no walk still to happen is held or pinned. Returns assigned, has_walker, members_assigned or empty. For Assign by capacity. Migration 20261108150200 (#731).';

-- ── What this file establishes ───────────────────────────────────────────
DO $check$
DECLARE
  _fn regprocedure;
  _qual text;
BEGIN
  FOREACH _fn IN ARRAY ARRAY[
    'public.set_plan_walker(uuid, uuid)'::regprocedure,
    'public.assign_walk_group_if_open(uuid, uuid)'::regprocedure
  ] LOOP
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = _fn) THEN
      RAISE EXCEPTION '% must be SECURITY DEFINER', _fn;
    END IF;
    IF has_function_privilege('anon', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% is executable by anon', _fn;
    END IF;
    IF NOT has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% is not executable by authenticated', _fn;
    END IF;
  END LOOP;
  -- Nothing here widens who may write a plan: the UPDATE policy still asks
  -- for manage_pricing.
  SELECT p.qual INTO _qual FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = 'subscriptions'
     AND p.policyname = 'subscriptions: priced by whoever sets pricing (update)';
  IF _qual IS NULL OR strpos(_qual, 'manage_pricing') = 0 THEN
    RAISE EXCEPTION 'the subscriptions UPDATE policy no longer asks for manage_pricing: %', _qual;
  END IF;
END
$check$;
