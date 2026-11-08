-- A walker has a dog cap, and a group walk keeps to it (#731).
--
-- Owner decision, 2026-11-08: "Several pets from different clients share one
-- visit, each client billed separately, plus cap on dogs per walker and staff
-- assigned by capacity".
--
-- The shared visit and the separate bills already exist (20261015200000): a
-- group walk links each client's own visit, and each visit is billed once
-- through invoice_line_items.visit_id, which is unique. Nothing here touches
-- billing.
--
-- What is new is the cap. staff.max_dogs_per_walk is how many dogs one person
-- may walk at once. NULL, the default for every row, means no cap of their own,
-- so a business that never sets it behaves exactly as before. When it is set,
-- a group walk with that walker holds no more than the smaller of the
-- service's group size and the walker's cap:
--
--   * a walk joining a group whose walker would go over is refused;
--   * giving a group to a walker whose cap its dogs already exceed is refused.
--
-- Lowering a cap does not rewrite or refuse anything already booked: a group
-- that is now over shows as over on the board, and the office decides. That is
-- deliberate. A settings change that fails because of next Tuesday's walk, or
-- one that silently empties it, would both be worse.
--
-- Solo walks are not capped here: a solo walk is one client's dogs, and
-- whether one household's dogs count against a walker's cap is an open
-- question for the owner (listed on the PR).
--
-- Two new trigger functions and two new triggers. Neither existing group
-- trigger is restated. The member trigger is named so it sorts after
-- visits_validate_walk_group, which runs first and copies the group's walker
-- onto a joining walk, detaches a skipped or moved one, and takes the group
-- row lock this trigger takes again.
--
-- Replays into an empty database: the tables and walk_dogs_on_visit exist by
-- this point, nothing reads or writes rows, and the check reads the catalog.

ALTER TABLE public.staff ADD COLUMN IF NOT EXISTS max_dogs_per_walk integer;
ALTER TABLE public.staff DROP CONSTRAINT IF EXISTS staff_max_dogs_per_walk_check;
ALTER TABLE public.staff ADD CONSTRAINT staff_max_dogs_per_walk_check
  CHECK (max_dogs_per_walk IS NULL OR max_dogs_per_walk BETWEEN 1 AND 50);
COMMENT ON COLUMN public.staff.max_dogs_per_walk IS
  'Most dogs this person walks at once, 1 to 50. NULL means no cap of their own. A group walk holds the smaller of this and services.max_dogs. Migration 20261108150000.';

-- ── A walk joining a capped walker's group ───────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_walker_dog_cap_on_member()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _group public.walk_groups%ROWTYPE;
  _cap integer;
  _name text;
  _dogs integer;
  _total integer;
BEGIN
  IF NEW.walk_group_id IS NULL OR NEW.status NOT IN ('scheduled', 'in_progress') THEN
    RETURN NEW;
  END IF;
  -- Same group, same plan, already holding a place: nothing about the count
  -- changed. validate_walk_group_member makes the same call.
  IF TG_OP = 'UPDATE'
    AND NEW.walk_group_id IS NOT DISTINCT FROM OLD.walk_group_id
    AND NEW.subscription_id IS NOT DISTINCT FROM OLD.subscription_id
    AND OLD.status IN ('scheduled', 'in_progress') THEN
    RETURN NEW;
  END IF;
  SELECT * INTO _group FROM public.walk_groups WHERE id = NEW.walk_group_id FOR UPDATE;
  IF NOT FOUND OR _group.assigned_staff_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT s.max_dogs_per_walk, s.display_name INTO _cap, _name
    FROM public.staff s WHERE s.id = _group.assigned_staff_id;
  IF _cap IS NULL THEN
    RETURN NEW;
  END IF;
  -- NEW is not visible to walk_dogs_on_visit on INSERT.
  SELECT greatest(coalesce(
    (SELECT s.dog_count FROM public.subscriptions s WHERE s.id = NEW.subscription_id),
    (SELECT count(*)::integer FROM public.dogs d WHERE d.property_id = NEW.property_id AND d.active),
    1), 1) INTO _dogs;
  SELECT coalesce(sum(public.walk_dogs_on_visit(v.id)), 0)::integer + _dogs INTO _total
    FROM public.visits v WHERE v.walk_group_id = NEW.walk_group_id AND v.id <> NEW.id
      AND v.status IN ('scheduled', 'in_progress');
  IF _total > _cap THEN
    RAISE EXCEPTION '% walks up to % dogs at a time. This group would have %.',
      coalesce(_name, 'This walker'), _cap, _total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.enforce_walker_dog_cap_on_member() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS visits_validate_walk_group_walker_cap ON public.visits;
CREATE TRIGGER visits_validate_walk_group_walker_cap
  BEFORE INSERT OR UPDATE OF walk_group_id, subscription_id, status
  ON public.visits
  FOR EACH ROW EXECUTE FUNCTION public.enforce_walker_dog_cap_on_member();

-- ── A group given to a capped walker ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_walker_dog_cap_on_group()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _cap integer;
  _name text;
  _total integer;
BEGIN
  IF NEW.assigned_staff_id IS NULL OR TG_OP = 'INSERT' THEN
    -- A new group has no walks yet; its first walk is checked as it joins.
    RETURN NEW;
  END IF;
  IF NEW.assigned_staff_id IS NOT DISTINCT FROM OLD.assigned_staff_id THEN
    RETURN NEW;
  END IF;
  SELECT s.max_dogs_per_walk, s.display_name INTO _cap, _name
    FROM public.staff s WHERE s.id = NEW.assigned_staff_id;
  IF _cap IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT coalesce(sum(public.walk_dogs_on_visit(v.id)), 0)::integer INTO _total
    FROM public.visits v WHERE v.walk_group_id = NEW.id
      AND v.status IN ('scheduled', 'in_progress');
  IF _total > _cap THEN
    RAISE EXCEPTION '% walks up to % dogs at a time. This group has %.',
      coalesce(_name, 'This walker'), _cap, _total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.enforce_walker_dog_cap_on_group() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS walk_groups_walker_cap ON public.walk_groups;
CREATE TRIGGER walk_groups_walker_cap
  BEFORE INSERT OR UPDATE OF assigned_staff_id ON public.walk_groups
  FOR EACH ROW EXECUTE FUNCTION public.enforce_walker_dog_cap_on_group();

-- ── What this file establishes, checked on any starting state ────────────
DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'staff' AND column_name = 'max_dogs_per_walk'
       AND is_nullable = 'YES' AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'staff.max_dogs_per_walk must exist, nullable, with no default (no cap unless set).';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
         AND t.tgname IN ('visits_validate_walk_group_walker_cap', 'walk_groups_walker_cap')) <> 2 THEN
    RAISE EXCEPTION 'Both walker dog cap triggers must exist.';
  END IF;
  IF has_function_privilege('anon', 'public.enforce_walker_dog_cap_on_member()', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.enforce_walker_dog_cap_on_member()', 'EXECUTE')
    OR has_function_privilege('anon', 'public.enforce_walker_dog_cap_on_group()', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.enforce_walker_dog_cap_on_group()', 'EXECUTE') THEN
    RAISE EXCEPTION 'A walker dog cap trigger function is callable by a client role.';
  END IF;
END
$check$;
