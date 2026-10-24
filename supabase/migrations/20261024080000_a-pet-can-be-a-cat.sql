-- A pet can be a cat: pet sitting (#411), part 1 of 2 (pets and care).
--
-- A sitter looks after cats, rabbits and fish as well as dogs, and needs to
-- know how each one is fed and medicated. This file:
--
--   1. gives public.dogs a species ('dog', 'cat', 'other') and a short note
--      for 'other' ("rabbit"). The table keeps its name, its policies and
--      every foreign key: renaming it would touch every reader in the app for
--      no change in behaviour. Every existing row is a dog (the default).
--   2. adds public.pet_care_instructions, one row per pet: feeding, a list of
--      medications with dose and times, and other care (litter, plants, mail).
--   3. keeps the group-walk rules counting DOGS. walk_dogs_on_visit and
--      validate_walk_group_member (20261015200000) counted every active row at
--      a property; a cat must not take a place in a group walk, and a cat is
--      never "a dog marked aggressive". Restated with species = 'dog' and
--      otherwise unchanged.
--
-- What does not change: subscriptions.dog_count. It stays a count of dogs on
-- every plan a scooper or a walker sells. A pet-waste business never sees the
-- species picker, so all of its rows stay 'dog' and every count it reads is
-- the count it read before.
--
-- Replays into an empty database: a column with a default, a table, two
-- functions and policies. No row is needed and no number is asserted.

-- ── 1. Species ────────────────────────────────────────────────────────────

ALTER TABLE public.dogs ADD COLUMN IF NOT EXISTS species text NOT NULL DEFAULT 'dog';
ALTER TABLE public.dogs ADD COLUMN IF NOT EXISTS species_note text;

ALTER TABLE public.dogs DROP CONSTRAINT IF EXISTS dogs_species_check;
ALTER TABLE public.dogs ADD CONSTRAINT dogs_species_check
  CHECK (species IN ('dog', 'cat', 'other'));
ALTER TABLE public.dogs DROP CONSTRAINT IF EXISTS dogs_species_note_length;
ALTER TABLE public.dogs ADD CONSTRAINT dogs_species_note_length
  CHECK (species_note IS NULL OR char_length(species_note) <= 40);

COMMENT ON TABLE public.dogs IS
  'Every pet a client has, at a property. Named for dogs because that is all it held until pet sitting (#411); since migration 20261024080000 a row may be a cat or another pet (species). Counts that mean dogs (subscriptions.dog_count, group walks, the scooping estimate) filter species = ''dog''.';
COMMENT ON COLUMN public.dogs.species IS
  'dog, cat or other. Default dog, so every row written before pet sitting is a dog. Migration 20261024080000.';
COMMENT ON COLUMN public.dogs.species_note IS
  'What kind of pet, for species other ("rabbit"). Up to 40 characters. Migration 20261024080000.';

-- ── 2. Care instructions ─────────────────────────────────────────────────

-- A medication list: an array of up to 20 objects, each
--   { name: text 1-80, dose: text <= 80 | null, times: ["HH:MM", ...] <= 6,
--     notes: text <= 200 | null }
-- and no other keys. plpgsql rather than one SQL expression so every step
-- runs in order: jsonb_array_length raises on a non-array, and SQL does not
-- promise to evaluate AND terms left to right.
CREATE OR REPLACE FUNCTION public.pet_meds_are_valid(_meds jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  _item jsonb;
  _time jsonb;
  _key text;
BEGIN
  IF _meds IS NULL OR jsonb_typeof(_meds) <> 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(_meds) > 20 THEN RETURN false; END IF;
  FOR _item IN SELECT value FROM jsonb_array_elements(_meds) LOOP
    IF jsonb_typeof(_item) <> 'object' THEN RETURN false; END IF;
    FOR _key IN SELECT jsonb_object_keys(_item) LOOP
      IF _key NOT IN ('name', 'dose', 'times', 'notes') THEN RETURN false; END IF;
    END LOOP;
    IF jsonb_typeof(_item -> 'name') IS DISTINCT FROM 'string'
       OR char_length(btrim(_item ->> 'name')) NOT BETWEEN 1 AND 80 THEN
      RETURN false;
    END IF;
    IF COALESCE(jsonb_typeof(_item -> 'dose'), 'null') NOT IN ('string', 'null')
       OR char_length(COALESCE(_item ->> 'dose', '')) > 80 THEN
      RETURN false;
    END IF;
    IF COALESCE(jsonb_typeof(_item -> 'notes'), 'null') NOT IN ('string', 'null')
       OR char_length(COALESCE(_item ->> 'notes', '')) > 200 THEN
      RETURN false;
    END IF;
    IF _item ? 'times' THEN
      IF jsonb_typeof(_item -> 'times') <> 'array' THEN RETURN false; END IF;
      IF jsonb_array_length(_item -> 'times') > 6 THEN RETURN false; END IF;
      FOR _time IN SELECT value FROM jsonb_array_elements(_item -> 'times') LOOP
        IF jsonb_typeof(_time) <> 'string'
           OR (_time #>> '{}') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
          RETURN false;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.pet_meds_are_valid(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pet_meds_are_valid(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.pet_meds_are_valid(jsonb) IS
  'True for a medication list pet_care_instructions.meds may hold: an array of up to 20 {name, dose, times ["HH:MM"], notes}. Mirrored by medsProblem in src/lib/pets.ts. Migration 20261024080000.';

CREATE TABLE IF NOT EXISTS public.pet_care_instructions (
  pet_id uuid PRIMARY KEY REFERENCES public.dogs(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  feeding text CHECK (feeding IS NULL OR char_length(feeding) <= 500),
  meds jsonb NOT NULL DEFAULT '[]'::jsonb,
  other_care text CHECK (other_care IS NULL OR char_length(other_care) <= 1000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid DEFAULT auth.uid(),
  CONSTRAINT pet_care_meds_is_array CHECK (jsonb_typeof(meds) = 'array'),
  CONSTRAINT pet_care_meds_valid CHECK (public.pet_meds_are_valid(meds))
);

CREATE INDEX IF NOT EXISTS pet_care_instructions_org_idx
  ON public.pet_care_instructions(organization_id);

COMMENT ON TABLE public.pet_care_instructions IS
  'How a pet is looked after, one row per pet (public.dogs): feeding, medications (name, dose, times, notes) and other care such as litter, plants and mail. Read by the office and by a sitter who may see the property; written by the office (can_write_org, the same as dogs). Migration 20261024080000.';

-- The row's business is the pet's business. Set from the pet rather than
-- trusted from the caller, and stamped with who changed it.
CREATE OR REPLACE FUNCTION public.tg_pet_care_instructions_pet()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _org uuid;
BEGIN
  SELECT d.organization_id INTO _org FROM public.dogs d WHERE d.id = NEW.pet_id;
  IF _org IS NULL THEN
    RAISE EXCEPTION 'That pet was not found.' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.organization_id IS DISTINCT FROM _org THEN
    RAISE EXCEPTION 'That pet belongs to another business.' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  NEW.updated_by := COALESCE(auth.uid(), NEW.updated_by);
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_pet_care_instructions_pet() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS pet_care_instructions_pet ON public.pet_care_instructions;
CREATE TRIGGER pet_care_instructions_pet
  BEFORE INSERT OR UPDATE ON public.pet_care_instructions
  FOR EACH ROW EXECUTE FUNCTION public.tg_pet_care_instructions_pet();

ALTER TABLE public.pet_care_instructions ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.pet_care_instructions');

-- Read: a member of the business who may see the pet's property, which is
-- the rule public.dogs reads by (the office sees every property, a tech the
-- ones they have a visit at).
DROP POLICY IF EXISTS "Members read pet care" ON public.pet_care_instructions;
CREATE POLICY "Members read pet care" ON public.pet_care_instructions
  FOR SELECT TO authenticated
  USING (
    public.is_org_member((SELECT auth.uid()), organization_id)
    AND EXISTS (
      SELECT 1 FROM public.dogs d
       WHERE d.id = pet_id
         AND public.may_read_property_row(d.organization_id, d.property_id)
    )
  );
DROP POLICY IF EXISTS "Office inserts pet care" ON public.pet_care_instructions;
CREATE POLICY "Office inserts pet care" ON public.pet_care_instructions
  FOR INSERT TO authenticated
  WITH CHECK (public.can_write_org((SELECT auth.uid()), organization_id));
DROP POLICY IF EXISTS "Office updates pet care" ON public.pet_care_instructions;
CREATE POLICY "Office updates pet care" ON public.pet_care_instructions
  FOR UPDATE TO authenticated
  USING (public.can_write_org((SELECT auth.uid()), organization_id))
  WITH CHECK (public.can_write_org((SELECT auth.uid()), organization_id));
DROP POLICY IF EXISTS "Office deletes pet care" ON public.pet_care_instructions;
CREATE POLICY "Office deletes pet care" ON public.pet_care_instructions
  FOR DELETE TO authenticated
  USING (public.can_write_org((SELECT auth.uid()), organization_id));

REVOKE ALL ON TABLE public.pet_care_instructions FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pet_care_instructions TO authenticated, service_role;

-- ── 3. Group walks count dogs ─────────────────────────────────────────────
-- Restated from 20261015200000 with species = 'dog' on every read of
-- public.dogs. Nothing else in either body changes.

CREATE OR REPLACE FUNCTION public.walk_dogs_on_visit(_visit_id uuid)
RETURNS integer LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT greatest(coalesce(
    s.dog_count,
    (SELECT count(*)::integer FROM public.dogs d
      WHERE d.property_id = v.property_id AND d.active AND d.species = 'dog'),
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
  _kept boolean := false;
BEGIN
  IF NEW.walk_group_id IS NULL THEN RETURN NEW; END IF;
  -- The row keeps the group it had: something else about the visit changed.
  IF TG_OP = 'UPDATE' AND NEW.walk_group_id IS NOT DISTINCT FROM OLD.walk_group_id THEN
    _kept := true;
    IF NEW.status IN ('skipped', 'canceled') THEN
      NEW.walk_group_id := NULL;
      RETURN NEW;
    END IF;
    SELECT * INTO _group FROM public.walk_groups WHERE id = NEW.walk_group_id;
    IF NOT FOUND OR NEW.organization_id IS DISTINCT FROM _group.organization_id
      OR NEW.scheduled_on IS DISTINCT FROM _group.scheduled_on
      OR NEW.service_id IS DISTINCT FROM _group.service_id THEN
      NEW.walk_group_id := NULL;
      RETURN NEW;
    END IF;
    -- Completed stays, and does not hold a place. Recheck capacity when the
    -- dog count changes, or when a walk that was not holding a place comes
    -- back to scheduled or in progress.
    IF NEW.status NOT IN ('scheduled', 'in_progress') THEN
      RETURN NEW;
    END IF;
    IF OLD.status IN ('scheduled', 'in_progress')
      AND NEW.subscription_id IS NOT DISTINCT FROM OLD.subscription_id THEN
      RETURN NEW;
    END IF;
  END IF;
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
    (SELECT count(*)::integer FROM public.dogs d
      WHERE d.property_id = NEW.property_id AND d.active AND d.species = 'dog'),
    1), 1) INTO _dogs;
  -- Only walks still to happen hold a place. Skipping or canceling already
  -- detaches a member above; the status filter is the second guard, and it
  -- also leaves a completed walk in the group without holding its place.
  SELECT coalesce(sum(public.walk_dogs_on_visit(v.id)), 0)::integer + _dogs INTO _total
    FROM public.visits v WHERE v.walk_group_id = NEW.walk_group_id AND v.id <> NEW.id
      AND v.status IN ('scheduled', 'in_progress');
  IF _total > _capacity THEN
    RAISE EXCEPTION 'This group walk is full: % of % dogs.', _total, _capacity
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.visits v
    WHERE v.walk_group_id = NEW.walk_group_id AND v.id <> NEW.id
      AND v.status IN ('scheduled', 'in_progress')
      AND v.client_id <> NEW.client_id
      AND (
        EXISTS (SELECT 1 FROM public.dogs d WHERE d.property_id = NEW.property_id
          AND d.active AND d.species = 'dog' AND d.temperament = 'aggressive')
        OR EXISTS (SELECT 1 FROM public.dogs d WHERE d.property_id = v.property_id
          AND d.active AND d.species = 'dog' AND d.temperament = 'aggressive')
      )
  ) THEN
    RAISE EXCEPTION 'A dog marked aggressive walks alone. Book a solo walk instead.'
      USING ERRCODE = 'check_violation';
  END IF;
  -- A walk joining the group takes its walker. One already in it keeps
  -- whoever it has, so a plan change does not undo a reassignment.
  IF NOT _kept AND _group.assigned_staff_id IS NOT NULL THEN
    NEW.assigned_staff_id := _group.assigned_staff_id;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.validate_walk_group_member() FROM PUBLIC, anon, authenticated;

-- ── What this file establishes, checked from any starting state ───────────
DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'dogs' AND column_name = 'species'
       AND is_nullable = 'NO' AND column_default LIKE '''dog''%'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'dogs' AND column_name = 'species_note'
  ) THEN
    RAISE EXCEPTION 'public.dogs.species (NOT NULL DEFAULT dog) or species_note is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.dogs'::regclass AND conname = 'dogs_species_check')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.dogs'::regclass AND conname = 'dogs_species_note_length') THEN
    RAISE EXCEPTION 'the species constraints on public.dogs are missing';
  END IF;

  IF to_regclass('public.pet_care_instructions') IS NULL THEN
    RAISE EXCEPTION 'public.pet_care_instructions is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class
                  WHERE oid = 'public.pet_care_instructions'::regclass AND relrowsecurity)
     OR NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname = 'public' AND tablename = 'pet_care_instructions'
                       AND policyname = 'two-step sign-in, when the user has it'
                       AND permissive = 'RESTRICTIVE') THEN
    RAISE EXCEPTION 'pet_care_instructions lacks row level security or the two-step policy';
  END IF;
  -- Exactly one permissive policy per command, and no FOR ALL.
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'pet_care_instructions'
         AND permissive = 'PERMISSIVE') <> 4
     OR EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'public' AND tablename = 'pet_care_instructions'
                   AND permissive = 'PERMISSIVE' AND cmd = 'ALL') THEN
    RAISE EXCEPTION 'pet_care_instructions should have four permissive policies, one per command';
  END IF;
  IF has_table_privilege('anon', 'public.pet_care_instructions',
                         'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION 'anonymous callers can reach pet_care_instructions';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.pet_care_instructions'::regclass
                    AND tgname = 'pet_care_instructions_pet' AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'trigger pet_care_instructions_pet is missing or disabled';
  END IF;
  IF has_function_privilege('authenticated', 'public.tg_pet_care_instructions_pet()', 'EXECUTE') THEN
    RAISE EXCEPTION 'tg_pet_care_instructions_pet is callable through the API';
  END IF;

  -- The medication rule, as the CHECK will apply it.
  IF NOT public.pet_meds_are_valid('[]')
     OR NOT public.pet_meds_are_valid('[{"name": "Insulin", "dose": "2 units", "times": ["08:00", "20:00"], "notes": null}]')
     OR NOT public.pet_meds_are_valid('[{"name": "Fish oil"}]')
     OR public.pet_meds_are_valid('{}')
     OR public.pet_meds_are_valid('[{"name": ""}]')
     OR public.pet_meds_are_valid('[{"name": "Pill", "times": ["8am"]}]')
     OR public.pet_meds_are_valid('[{"name": "Pill", "times": "08:00"}]')
     OR public.pet_meds_are_valid('[{"name": "Pill", "colour": "red"}]')
     OR public.pet_meds_are_valid('["Pill"]') THEN
    RAISE EXCEPTION 'pet_meds_are_valid does not hold the rule it documents';
  END IF;

  -- The group-walk rules read dogs only.
  IF (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid = 'public.walk_dogs_on_visit(uuid)'::regprocedure) NOT LIKE '%species = ''dog''%'
     OR (SELECT p.prosrc FROM pg_proc p
          WHERE p.oid = 'public.validate_walk_group_member()'::regprocedure) NOT LIKE '%species = ''dog''%' THEN
    RAISE EXCEPTION 'the group-walk rules still count every pet as a dog';
  END IF;
  IF has_function_privilege('authenticated', 'public.validate_walk_group_member()', 'EXECUTE') THEN
    RAISE EXCEPTION 'validate_walk_group_member is callable through the API';
  END IF;
END
$check$;
