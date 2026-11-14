-- A walk over its dog cap is warned, then allowed (#731).
--
-- PROPOSED, FILE ONLY. Not applied to any database by the change that adds it.
--
-- Brendan, 2026-11-10 2:24 PM ET: "Warn but allow going over the dog cap".
-- This replaces 20261108170000's refusal:
--   * an assignment that would put a walk over its walker's dog cap is shown
--     a warning first ("This walk will have 7 dogs; the cap is 6."), and the
--     person can still go ahead;
--   * going ahead saves it and records who went over the cap and by how much
--     (walk_dog_cap_overrides);
--   * nothing goes over silently: the database still refuses an over-cap
--     write that was not confirmed, from every path, so drag on the board,
--     bulk assign and Cover (which all end in reassign_visit,
--     bulk_reassign_visits and redistribute_staff_work) meet the same check
--     as the Group walks panel. The app turns that refusal into the warning.
--
-- What "a walk" is, unchanged from 20261108170000: a group walk, and the dogs
-- one walker holds on it, scheduled or in progress. The cap is the walker's
-- staff.max_dogs_per_walk; NULL is no cap. What changed beyond refuse/allow:
-- the check now also runs when a group's walks are handed to a walker one at
-- a time (visits.assigned_staff_id). 20261108170000 only checked through the
-- group's own walker, so that path went over the cap with nothing said (the
-- hole the 2026-11-10 audit on #731 found).
--
-- How a confirmation reaches the database: the request carries the header
-- `x-dog-cap-acknowledged: yes` (PostgREST exposes it as request.headers, the
-- way 20260913100000 reads its own). A SQL caller can set
-- `houndstack.dog_cap_acknowledged = 'on'` for its transaction instead. The
-- header is the person's "Assign anyway", not an authorization: every write
-- it rides on is authorized exactly as before.
--
-- The refusal keeps 20261108170000's class, check_violation, so every caller
-- that already handled it still does. It is told apart from the time-off
-- guard (also 23514) by its HINT, 'dog_cap', and its DETAIL is JSON with the
-- numbers the warning shows.

-- ── Who went over the cap, and by how much ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.walk_dog_cap_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  walk_group_id   uuid NOT NULL REFERENCES public.walk_groups(id) ON DELETE CASCADE,
  staff_id        uuid NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
  dogs            integer NOT NULL,
  cap             integer NOT NULL,
  over_by         integer GENERATED ALWAYS AS (dogs - cap) STORED,
  -- auth.uid() of the person who confirmed; NULL for the service role.
  recorded_by     uuid,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  -- One row per walk and walker per transaction: a group handed over walk by
  -- walk fires the check once per walk, and the last count is what went in.
  recorded_tx     bigint NOT NULL DEFAULT txid_current(),
  CONSTRAINT walk_dog_cap_overrides_over CHECK (dogs > cap),
  CONSTRAINT walk_dog_cap_overrides_once UNIQUE (walk_group_id, staff_id, recorded_tx)
);
CREATE INDEX IF NOT EXISTS walk_dog_cap_overrides_org_idx
  ON public.walk_dog_cap_overrides (organization_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS walk_dog_cap_overrides_staff_idx
  ON public.walk_dog_cap_overrides (staff_id);
COMMENT ON TABLE public.walk_dog_cap_overrides IS
  'A walk confirmed over its walker''s dog cap: who confirmed it, when, and by how much. Written only by walk_dog_cap_guard. Migration 20261111160000.';

ALTER TABLE public.walk_dog_cap_overrides ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.walk_dog_cap_overrides FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.walk_dog_cap_overrides FROM authenticated;
GRANT SELECT ON public.walk_dog_cap_overrides TO authenticated;
DROP POLICY IF EXISTS "Office reads dog cap overrides" ON public.walk_dog_cap_overrides;
CREATE POLICY "Office reads dog cap overrides" ON public.walk_dog_cap_overrides
  FOR SELECT TO authenticated
  USING (public.can_write_org((SELECT auth.uid()), organization_id));
SELECT public.require_mfa_policy('public.walk_dog_cap_overrides');

-- ── The one check every path meets ────────────────────────────────────────
-- Dogs `_walker` holds on group `_group` (scheduled or in progress; a walk
-- with no walker of its own counts for the group's walker). Over the cap and
-- not confirmed: refused. Over and confirmed: recorded.
CREATE OR REPLACE FUNCTION public.walk_dog_cap_guard(_group uuid, _walker uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _org uuid;
  _group_walker uuid;
  _cap integer;
  _name text;
  _dogs integer;
  _ack boolean;
BEGIN
  IF _group IS NULL OR _walker IS NULL THEN
    RETURN;
  END IF;
  SELECT s.max_dogs_per_walk, s.display_name INTO _cap, _name
    FROM public.staff s WHERE s.id = _walker;
  IF _cap IS NULL THEN
    RETURN;
  END IF;
  SELECT g.organization_id, g.assigned_staff_id INTO _org, _group_walker
    FROM public.walk_groups g WHERE g.id = _group;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT coalesce(sum(public.walk_dogs_on_visit(v.id)), 0)::integer INTO _dogs
    FROM public.visits v
   WHERE v.walk_group_id = _group
     AND v.status IN ('scheduled', 'in_progress')
     AND coalesce(v.assigned_staff_id, _group_walker) = _walker;
  IF _dogs <= _cap THEN
    RETURN;
  END IF;
  _ack := coalesce(current_setting('houndstack.dog_cap_acknowledged', true), '') = 'on'
    OR coalesce(
         nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-dog-cap-acknowledged',
         '') = 'yes';
  IF NOT _ack THEN
    RAISE EXCEPTION 'This walk will have % dogs; the cap is %.', _dogs, _cap
      USING ERRCODE = 'check_violation',
            HINT = 'dog_cap',
            DETAIL = json_build_object(
              'walk_group_id', _group, 'staff_id', _walker,
              'walker', _name, 'dogs', _dogs, 'cap', _cap)::text;
  END IF;
  INSERT INTO public.walk_dog_cap_overrides
    (organization_id, walk_group_id, staff_id, dogs, cap, recorded_by)
  VALUES (_org, _group, _walker, _dogs, _cap, auth.uid())
  ON CONFLICT ON CONSTRAINT walk_dog_cap_overrides_once
    DO UPDATE SET dogs = EXCLUDED.dogs, cap = EXCLUDED.cap, recorded_at = now();
END;
$function$;
REVOKE ALL ON FUNCTION public.walk_dog_cap_guard(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ── A walk joining, or being handed within, a group ───────────────────────
-- AFTER, so the count sees the row as written (20261108170000 had to add the
-- new row by hand because a BEFORE trigger cannot see it).
CREATE OR REPLACE FUNCTION public.enforce_walker_dog_cap_on_member()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.walk_group_id IS NULL OR NEW.status NOT IN ('scheduled', 'in_progress') THEN
    RETURN NULL;
  END IF;
  -- Same group, plan and walker, already holding a place: the count did not
  -- change.
  IF TG_OP = 'UPDATE'
    AND NEW.walk_group_id IS NOT DISTINCT FROM OLD.walk_group_id
    AND NEW.subscription_id IS NOT DISTINCT FROM OLD.subscription_id
    AND NEW.assigned_staff_id IS NOT DISTINCT FROM OLD.assigned_staff_id
    AND OLD.status IN ('scheduled', 'in_progress') THEN
    RETURN NULL;
  END IF;
  PERFORM public.walk_dog_cap_guard(
    NEW.walk_group_id,
    coalesce(NEW.assigned_staff_id,
             (SELECT g.assigned_staff_id FROM public.walk_groups g WHERE g.id = NEW.walk_group_id)));
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.enforce_walker_dog_cap_on_member() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS visits_validate_walk_group_walker_cap ON public.visits;
CREATE TRIGGER visits_validate_walk_group_walker_cap
  AFTER INSERT OR UPDATE OF walk_group_id, subscription_id, status, assigned_staff_id
  ON public.visits
  FOR EACH ROW EXECUTE FUNCTION public.enforce_walker_dog_cap_on_member();

-- ── A group given to a walker ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_walker_dog_cap_on_group()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.assigned_staff_id IS NULL
    OR NEW.assigned_staff_id IS NOT DISTINCT FROM OLD.assigned_staff_id THEN
    RETURN NULL;
  END IF;
  PERFORM public.walk_dog_cap_guard(NEW.id, NEW.assigned_staff_id);
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.enforce_walker_dog_cap_on_group() FROM PUBLIC, anon, authenticated;

-- AFTER and named to sort after walk_groups_copy_walker's AFTER trigger in
-- the old order too; the guard counts each walk's own walker or the group's,
-- so it is right either way.
DROP TRIGGER IF EXISTS walk_groups_walker_cap ON public.walk_groups;
CREATE TRIGGER walk_groups_walker_cap
  AFTER UPDATE OF assigned_staff_id ON public.walk_groups
  FOR EACH ROW EXECUTE FUNCTION public.enforce_walker_dog_cap_on_group();

-- ── Which walks are over the cap now, for the board and My Day ────────────
-- One row per walk and walker over the cap on `_day`. The office sees its
-- whole org; anyone else (a walker on My Day) sees only their own walks.
CREATE OR REPLACE FUNCTION public.walks_over_dog_cap(_org uuid, _day date)
RETURNS TABLE (walk_group_id uuid, staff_id uuid, visit_ids uuid[], dogs integer, cap integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH held AS (
    SELECT v.walk_group_id, coalesce(v.assigned_staff_id, g.assigned_staff_id) AS staff_id,
           v.id AS visit_id, public.walk_dogs_on_visit(v.id) AS dogs
      FROM public.visits v
      JOIN public.walk_groups g ON g.id = v.walk_group_id
     WHERE v.organization_id = _org
       AND g.organization_id = _org
       AND v.scheduled_on = _day
       AND v.status IN ('scheduled', 'in_progress')
  )
  SELECT h.walk_group_id, h.staff_id, array_agg(h.visit_id ORDER BY h.visit_id),
         sum(h.dogs)::integer, s.max_dogs_per_walk
    FROM held h
    JOIN public.staff s ON s.id = h.staff_id AND s.organization_id = _org
   WHERE s.max_dogs_per_walk IS NOT NULL
     AND public.is_org_member(auth.uid(), _org)
     AND (public.can_write_org(auth.uid(), _org) OR s.user_id = auth.uid())
   GROUP BY h.walk_group_id, h.staff_id, s.max_dogs_per_walk
  HAVING sum(h.dogs) > s.max_dogs_per_walk;
$function$;
REVOKE ALL ON FUNCTION public.walks_over_dog_cap(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.walks_over_dog_cap(uuid, date) TO authenticated, service_role;

-- ── What this file establishes, checked on any starting state ────────────
DO $check$
DECLARE _src text;
BEGIN
  IF (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
         AND t.tgname IN ('visits_validate_walk_group_walker_cap', 'walk_groups_walker_cap')
         AND (t.tgtype & 2) = 0) <> 2 THEN
    RAISE EXCEPTION 'Both walker dog cap triggers must exist and run AFTER the write.';
  END IF;
  SELECT p.prosrc INTO _src FROM pg_proc p
   WHERE p.oid = 'public.walk_dog_cap_guard(uuid, uuid)'::regprocedure;
  IF strpos(_src, 'IF NOT _ack THEN') = 0 OR strpos(_src, 'INSERT INTO public.walk_dog_cap_overrides') = 0 THEN
    RAISE EXCEPTION 'walk_dog_cap_guard must refuse an unconfirmed over-cap write and record a confirmed one.';
  END IF;
  IF has_function_privilege('anon', 'public.walk_dog_cap_guard(uuid, uuid)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.walk_dog_cap_guard(uuid, uuid)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.enforce_walker_dog_cap_on_member()', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.enforce_walker_dog_cap_on_member()', 'EXECUTE')
    OR has_function_privilege('anon', 'public.enforce_walker_dog_cap_on_group()', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.enforce_walker_dog_cap_on_group()', 'EXECUTE')
    OR has_function_privilege('anon', 'public.walks_over_dog_cap(uuid, date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A dog cap function is callable by a role that must not call it.';
  END IF;
  IF has_table_privilege('authenticated', 'public.walk_dog_cap_overrides', 'INSERT')
    OR has_table_privilege('authenticated', 'public.walk_dog_cap_overrides', 'UPDATE')
    OR has_table_privilege('authenticated', 'public.walk_dog_cap_overrides', 'DELETE') THEN
    RAISE EXCEPTION 'walk_dog_cap_overrides must be written only by walk_dog_cap_guard.';
  END IF;
END
$check$;
