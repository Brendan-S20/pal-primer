-- Group walks link independently billed visits. Solo plans and generation stay unchanged.
ALTER TABLE public.services ADD COLUMN IF NOT EXISTS max_dogs integer;
ALTER TABLE public.services DROP CONSTRAINT IF EXISTS services_max_dogs_check;
ALTER TABLE public.services ADD CONSTRAINT services_max_dogs_check
  CHECK (max_dogs IS NULL OR (max_dogs BETWEEN 1 AND 50 AND service_line = 'dog_walking'));
COMMENT ON COLUMN public.services.max_dogs IS
  'Maximum dogs in a group walk, from 1 to 50. NULL means this is not a group walk service.';

CREATE TABLE IF NOT EXISTS public.walk_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES public.services(id),
  scheduled_on date NOT NULL,
  assigned_staff_id uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  earliest_time time,
  latest_time time,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 500),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT walk_groups_window_check CHECK (
    earliest_time IS NULL OR latest_time IS NULL OR earliest_time < latest_time
  )
);
CREATE INDEX IF NOT EXISTS walk_groups_org_day_idx ON public.walk_groups(organization_id, scheduled_on);
CREATE INDEX IF NOT EXISTS walk_groups_service_idx ON public.walk_groups(service_id);
CREATE INDEX IF NOT EXISTS walk_groups_staff_idx ON public.walk_groups(assigned_staff_id);
ALTER TABLE public.walk_groups ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.walk_groups');
DROP POLICY IF EXISTS "Members read walk groups" ON public.walk_groups;
CREATE POLICY "Members read walk groups" ON public.walk_groups FOR SELECT TO authenticated
  USING (public.is_org_member((SELECT auth.uid()), organization_id));
DROP POLICY IF EXISTS "Office inserts walk groups" ON public.walk_groups;
CREATE POLICY "Office inserts walk groups" ON public.walk_groups FOR INSERT TO authenticated
  WITH CHECK (public.can_write_org((SELECT auth.uid()), organization_id));
DROP POLICY IF EXISTS "Office updates walk groups" ON public.walk_groups;
CREATE POLICY "Office updates walk groups" ON public.walk_groups FOR UPDATE TO authenticated
  USING (public.can_write_org((SELECT auth.uid()), organization_id))
  WITH CHECK (public.can_write_org((SELECT auth.uid()), organization_id));
DROP POLICY IF EXISTS "Office deletes walk groups" ON public.walk_groups;
CREATE POLICY "Office deletes walk groups" ON public.walk_groups FOR DELETE TO authenticated
  USING (public.can_write_org((SELECT auth.uid()), organization_id));
REVOKE ALL ON TABLE public.walk_groups FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.walk_groups TO authenticated, service_role;

ALTER TABLE public.visits ADD COLUMN IF NOT EXISTS walk_group_id uuid
  REFERENCES public.walk_groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS visits_walk_group_idx ON public.visits(walk_group_id);

CREATE OR REPLACE FUNCTION public.validate_walk_group()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.services s WHERE s.id = NEW.service_id
      AND s.organization_id = NEW.organization_id
      AND s.service_line = 'dog_walking' AND s.max_dogs IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Choose a group walk service. Set its group size in Settings > Services.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.assigned_staff_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.staff s WHERE s.id = NEW.assigned_staff_id
      AND s.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Choose a walker from this business.' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (
      NEW.organization_id IS DISTINCT FROM OLD.organization_id
      OR NEW.scheduled_on IS DISTINCT FROM OLD.scheduled_on
      OR NEW.service_id IS DISTINCT FROM OLD.service_id
    ) AND EXISTS (SELECT 1 FROM public.visits v WHERE v.walk_group_id = OLD.id) THEN
      RAISE EXCEPTION 'Remove the walks before changing the group day or service.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.validate_walk_group() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS walk_groups_validate ON public.walk_groups;
CREATE TRIGGER walk_groups_validate BEFORE INSERT OR UPDATE ON public.walk_groups
  FOR EACH ROW EXECUTE FUNCTION public.validate_walk_group();

CREATE OR REPLACE FUNCTION public.walk_dogs_on_visit(_visit_id uuid)
RETURNS integer LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT greatest(coalesce(
    s.dog_count,
    (SELECT count(*)::integer FROM public.dogs d WHERE d.property_id = v.property_id AND d.active),
    1), 1)
  FROM public.visits v LEFT JOIN public.subscriptions s ON s.id = v.subscription_id
  WHERE v.id = _visit_id;
$function$;
REVOKE ALL ON FUNCTION public.walk_dogs_on_visit(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.walk_dogs_on_visit(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.validate_walk_group_member()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _group public.walk_groups%ROWTYPE;
  _capacity integer;
  _dogs integer;
  _total integer;
BEGIN
  IF NEW.walk_group_id IS NULL THEN RETURN NEW; END IF;
  -- Serialize joins to the same group before reading its members.
  SELECT * INTO _group FROM public.walk_groups WHERE id = NEW.walk_group_id FOR UPDATE;
  IF NOT FOUND OR NEW.organization_id IS DISTINCT FROM _group.organization_id
    OR NEW.scheduled_on IS DISTINCT FROM _group.scheduled_on
    OR NEW.service_id IS DISTINCT FROM _group.service_id
    OR NEW.status IN ('canceled', 'skipped', 'completed') THEN
    RAISE EXCEPTION 'That walk is on another day or for another service.'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT max_dogs INTO _capacity FROM public.services WHERE id = _group.service_id;
  IF _capacity IS NULL THEN
    RAISE EXCEPTION 'Choose a group walk service. Set its group size in Settings > Services.'
      USING ERRCODE = 'check_violation';
  END IF;
  -- NEW is not visible to walk_dogs_on_visit on INSERT. Read its plan and property directly.
  SELECT greatest(coalesce(
    (SELECT s.dog_count FROM public.subscriptions s WHERE s.id = NEW.subscription_id),
    (SELECT count(*)::integer FROM public.dogs d WHERE d.property_id = NEW.property_id AND d.active),
    1), 1) INTO _dogs;
  SELECT coalesce(sum(public.walk_dogs_on_visit(v.id)), 0)::integer + _dogs INTO _total
    FROM public.visits v WHERE v.walk_group_id = NEW.walk_group_id AND v.id <> NEW.id;
  IF _total > _capacity THEN
    RAISE EXCEPTION 'This group walk is full: % of % dogs.', _total, _capacity
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.visits v
    WHERE v.walk_group_id = NEW.walk_group_id AND v.id <> NEW.id
      AND v.client_id <> NEW.client_id
      AND (
        EXISTS (SELECT 1 FROM public.dogs d WHERE d.property_id = NEW.property_id
          AND d.active AND d.temperament = 'aggressive')
        OR EXISTS (SELECT 1 FROM public.dogs d WHERE d.property_id = v.property_id
          AND d.active AND d.temperament = 'aggressive')
      )
  ) THEN
    RAISE EXCEPTION 'A dog marked aggressive walks alone. Book a solo walk instead.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF _group.assigned_staff_id IS NOT NULL THEN
    NEW.assigned_staff_id := _group.assigned_staff_id;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.validate_walk_group_member() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS visits_validate_walk_group ON public.visits;
CREATE TRIGGER visits_validate_walk_group
  BEFORE INSERT OR UPDATE OF walk_group_id, scheduled_on, service_id, subscription_id ON public.visits
  FOR EACH ROW EXECUTE FUNCTION public.validate_walk_group_member();

CREATE OR REPLACE FUNCTION public.copy_walk_group_walker()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.visits SET assigned_staff_id = NEW.assigned_staff_id, sequence = NULL
    WHERE walk_group_id = NEW.id AND status = 'scheduled';
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.copy_walk_group_walker() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS walk_groups_copy_walker ON public.walk_groups;
CREATE TRIGGER walk_groups_copy_walker AFTER UPDATE OF assigned_staff_id ON public.walk_groups
  FOR EACH ROW WHEN (OLD.assigned_staff_id IS DISTINCT FROM NEW.assigned_staff_id)
  EXECUTE FUNCTION public.copy_walk_group_walker();

CREATE OR REPLACE FUNCTION public.guard_visit_walk_group()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL
    AND NOT public.can_write_org(auth.uid(), OLD.organization_id)
    AND NEW.walk_group_id IS DISTINCT FROM OLD.walk_group_id THEN
    RAISE EXCEPTION 'Not authorized to change the group on a visit.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.guard_visit_walk_group() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS visits_guard_walk_group ON public.visits;
CREATE TRIGGER visits_guard_walk_group BEFORE UPDATE OF walk_group_id ON public.visits
  FOR EACH ROW EXECUTE FUNCTION public.guard_visit_walk_group();

DO $check$
BEGIN
  IF to_regclass('public.walk_groups') IS NULL
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'visits' AND column_name = 'walk_group_id')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'services' AND column_name = 'max_dogs') THEN
    RAISE EXCEPTION 'Group walk table or columns are missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('public.walk_groups', 'walk_groups_validate'),
      ('public.walk_groups', 'walk_groups_copy_walker'),
      ('public.visits', 'visits_validate_walk_group'),
      ('public.visits', 'visits_guard_walk_group')
    ) AS expected(rel, name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = expected.rel::regclass
      AND t.tgname = expected.name AND NOT t.tgisinternal AND t.tgenabled <> 'D')
  ) THEN RAISE EXCEPTION 'Group walk triggers are missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.walk_groups'::regclass AND relrowsecurity)
    OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'walk_groups'
      AND policyname = 'two-step sign-in, when the user has it' AND permissive = 'RESTRICTIVE') THEN
    RAISE EXCEPTION 'Group walk RLS or MFA policy is missing';
  END IF;
  IF has_table_privilege('anon', 'public.walk_groups', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION 'Anonymous callers can access walk_groups';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.services'::regclass AND conname = 'services_max_dogs_check')
    OR to_regprocedure('public.walk_dogs_on_visit(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Group walk capacity constraint or dog count function is missing';
  END IF;
  IF has_function_privilege('anon', 'public.walk_dogs_on_visit(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Anonymous callers can count walk dogs';
  END IF;
END;
$check$;
