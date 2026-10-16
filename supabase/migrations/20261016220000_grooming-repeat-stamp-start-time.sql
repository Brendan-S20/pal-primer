-- A groom plan keeps what was booked, and every visit the plan produces
-- carries it, whichever generator inserts the visit and however far out.
--
-- Until this file the booking call stamped the length, price and summary on
-- the visits it generated itself (the first 60 days) and charged the add-ons
-- for those visits only. The nightly generator and generate_visits_through
-- insert later visits with none of it, so a client on a six-week cycle got
-- one or two correct grooms and then the service default with no add-ons.
--
-- Also here: a groom's start time and the business's setup and cleanup
-- minutes (so a booking can hold the whole appointment), per-pet handling
-- flags, and per-pet groom notes with history.

-- ── 1. What the plan was booked with ─────────────────────────────────────

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS groom_start_time time,
  ADD COLUMN IF NOT EXISTS groom_duration_min integer,
  ADD COLUMN IF NOT EXISTS groom_summary text,
  ADD COLUMN IF NOT EXISTS groom_addons jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_groom_duration_min_check;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_groom_duration_min_check
  CHECK (groom_duration_min IS NULL OR groom_duration_min BETWEEN 1 AND 10000);
ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_groom_summary_check;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_groom_summary_check
  CHECK (groom_summary IS NULL OR char_length(groom_summary) <= 240);
ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_groom_addons_check;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_groom_addons_check
  CHECK (jsonb_typeof(groom_addons) = 'array' AND jsonb_array_length(groom_addons) <= 20);

COMMENT ON COLUMN public.subscriptions.groom_duration_min IS
  'Set when the office books a groom: pet minutes, add-on minutes and the business''s setup and cleanup minutes. Copied onto every visit the plan generates by visits_groom_plan_stamp. Null means this plan is not a groom.';
COMMENT ON COLUMN public.subscriptions.groom_start_time IS
  'The groom''s start on the business''s clock. Copied to visits.start_time.';
COMMENT ON COLUMN public.subscriptions.groom_addons IS
  'Add-ons booked with the groom: [{"addon_service_id", "quantity", "unit_price_cents", "name"}]. Charged on each visit when it is completed.';

ALTER TABLE public.visits ADD COLUMN IF NOT EXISTS start_time time;
COMMENT ON COLUMN public.visits.start_time IS
  'A fixed appointment''s start on the business''s clock (grooms). Null for a route stop, which the planner times.';

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS groom_buffer_min smallint NOT NULL DEFAULT 15;
ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_groom_buffer_min_check;
ALTER TABLE public.organizations ADD CONSTRAINT organizations_groom_buffer_min_check
  CHECK (groom_buffer_min BETWEEN 0 AND 240);
COMMENT ON COLUMN public.organizations.groom_buffer_min IS
  'Setup and cleanup minutes added to every groom''s length. Drive time is not included.';

-- ── 2. Every generated visit carries the plan ────────────────────────────

CREATE OR REPLACE FUNCTION public.tg_visits_groom_plan_stamp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _plan record;
BEGIN
  IF NEW.subscription_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT s.groom_duration_min, s.groom_summary, s.groom_start_time, s.price_cents
    INTO _plan
    FROM public.subscriptions s
   WHERE s.id = NEW.subscription_id
     AND s.organization_id = NEW.organization_id;
  IF NOT FOUND OR _plan.groom_duration_min IS NULL THEN
    RETURN NEW;
  END IF;
  -- An insert that names its own values keeps them.
  NEW.duration_min := COALESCE(NEW.duration_min, _plan.groom_duration_min);
  NEW.groom_summary := COALESCE(NEW.groom_summary, _plan.groom_summary);
  NEW.start_time := COALESCE(NEW.start_time, _plan.groom_start_time);
  NEW.price_cents := COALESCE(NEW.price_cents, _plan.price_cents);
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_visits_groom_plan_stamp() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS visits_groom_plan_stamp ON public.visits;
CREATE TRIGGER visits_groom_plan_stamp
  BEFORE INSERT ON public.visits
  FOR EACH ROW EXECUTE FUNCTION public.tg_visits_groom_plan_stamp();

-- Add-ons are charged when the groom is done, so a skipped or missed groom
-- bills nothing and a canceled plan leaves no charge behind on a deleted
-- visit. Once per visit and add-on: a reopened and recompleted groom is not
-- charged twice.
CREATE OR REPLACE FUNCTION public.tg_visits_groom_plan_addons()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _addons jsonb;
  _item jsonb;
  _svc record;
  _qty integer;
  _price integer;
  _amt integer;
  _charge_id uuid;
  _ledger_id uuid;
BEGIN
  SELECT s.groom_addons INTO _addons
    FROM public.subscriptions s
   WHERE s.id = NEW.subscription_id
     AND s.organization_id = NEW.organization_id
     AND s.groom_duration_min IS NOT NULL;
  IF _addons IS NULL OR jsonb_array_length(_addons) = 0 THEN
    RETURN NEW;
  END IF;

  FOR _item IN SELECT value FROM jsonb_array_elements(_addons) LOOP
    SELECT a.id, a.name, a.unit_price_cents INTO _svc
      FROM public.addon_services a
     WHERE a.id = NULLIF(_item->>'addon_service_id', '')::uuid
       AND a.organization_id = NEW.organization_id;
    CONTINUE WHEN NOT FOUND;
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.addon_charges c
       WHERE c.visit_id = NEW.id
         AND c.addon_service_id = _svc.id
         AND c.note = 'Booked with the groom'
         AND c.status <> 'voided'
    );
    _qty := GREATEST(COALESCE((_item->>'quantity')::integer, 1), 1);
    _price := GREATEST(COALESCE((_item->>'unit_price_cents')::integer, _svc.unit_price_cents), 0);
    _amt := _price * _qty;

    INSERT INTO public.addon_charges(
      organization_id, client_id, property_id, addon_service_id, visit_id, description,
      unit_price_cents, quantity, amount_cents, occurred_on, source, note, created_by
    ) VALUES (
      NEW.organization_id, NEW.client_id, NEW.property_id, _svc.id, NEW.id,
      COALESCE(NULLIF(_item->>'name', ''), _svc.name),
      _price, _qty, _amt, NEW.scheduled_on, 'office', 'Booked with the groom', auth.uid()
    ) RETURNING id INTO _charge_id;

    -- The same prepaid handling create_addon_charge applies.
    IF public.client_default_billing_cadence(NEW.client_id) = 'prepaid' AND _amt > 0 THEN
      INSERT INTO public.credit_ledger(organization_id, client_id, delta_cents, kind, note)
      VALUES (NEW.organization_id, NEW.client_id, -_amt, 'addon_debit',
              'Add-on: ' || COALESCE(NULLIF(_item->>'name', ''), _svc.name))
      RETURNING id INTO _ledger_id;
      UPDATE public.addon_charges
         SET status = 'paid_from_credit', credit_ledger_id = _ledger_id, updated_at = now()
       WHERE id = _charge_id;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_visits_groom_plan_addons() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS visits_groom_plan_addons ON public.visits;
CREATE TRIGGER visits_groom_plan_addons
  AFTER UPDATE OF status ON public.visits
  FOR EACH ROW
  WHEN (NEW.status = 'completed' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.tg_visits_groom_plan_addons();

-- ── 3. How to handle each pet ────────────────────────────────────────────

ALTER TABLE public.dogs
  ADD COLUMN IF NOT EXISTS muzzle_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bite_history boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS senior_or_medical boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS handling_notes text;
ALTER TABLE public.dogs DROP CONSTRAINT IF EXISTS dogs_handling_notes_check;
ALTER TABLE public.dogs ADD CONSTRAINT dogs_handling_notes_check
  CHECK (handling_notes IS NULL OR char_length(handling_notes) <= 1000);

-- ── 4. What was done to each pet, groom by groom ─────────────────────────

CREATE TABLE IF NOT EXISTS public.pet_groom_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  dog_id uuid NOT NULL REFERENCES public.dogs(id) ON DELETE CASCADE,
  visit_id uuid NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  groomed_on date NOT NULL,
  blade text CHECK (blade IS NULL OR char_length(blade) <= 120),
  style text CHECK (style IS NULL OR char_length(style) <= 240),
  problems text CHECK (problems IS NULL OR char_length(problems) <= 1000),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pet_groom_notes_visit_dog_key UNIQUE (visit_id, dog_id),
  CONSTRAINT pet_groom_notes_not_blank CHECK (
    NULLIF(btrim(COALESCE(blade, '')), '') IS NOT NULL
    OR NULLIF(btrim(COALESCE(style, '')), '') IS NOT NULL
    OR NULLIF(btrim(COALESCE(problems, '')), '') IS NOT NULL
  )
);
CREATE INDEX IF NOT EXISTS pet_groom_notes_dog_groomed_idx
  ON public.pet_groom_notes (dog_id, groomed_on DESC);
CREATE INDEX IF NOT EXISTS pet_groom_notes_organization_id_idx
  ON public.pet_groom_notes (organization_id);
CREATE INDEX IF NOT EXISTS pet_groom_notes_created_by_idx
  ON public.pet_groom_notes (created_by);

-- The tenant, the date and the pet all come from the visit. The office, or
-- the groomer the visit is assigned to, may write; nobody else.
CREATE OR REPLACE FUNCTION public.tg_pet_groom_notes_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _visit record;
BEGIN
  SELECT v.organization_id, v.property_id, v.scheduled_on, v.assigned_staff_id
    INTO _visit
    FROM public.visits v WHERE v.id = NEW.visit_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Visit not found.' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.dogs d
     WHERE d.id = NEW.dog_id
       AND d.organization_id = _visit.organization_id
       AND d.property_id = _visit.property_id
  ) THEN
    RAISE EXCEPTION 'That pet is not at this visit''s address.' USING ERRCODE = 'check_violation';
  END IF;
  IF auth.uid() IS NOT NULL
     AND NOT public.can_write_org(auth.uid(), _visit.organization_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.staff s
        WHERE s.id = _visit.assigned_staff_id
          AND s.user_id = auth.uid()
     ) THEN
    RAISE EXCEPTION 'Only the office or the assigned groomer can write this note.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.organization_id := _visit.organization_id;
  NEW.groomed_on := _visit.scheduled_on;
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := auth.uid();
  ELSE
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_pet_groom_notes_before_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS pet_groom_notes_before_write ON public.pet_groom_notes;
CREATE TRIGGER pet_groom_notes_before_write
  BEFORE INSERT OR UPDATE ON public.pet_groom_notes
  FOR EACH ROW EXECUTE FUNCTION public.tg_pet_groom_notes_before_write();

ALTER TABLE public.pet_groom_notes ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.pet_groom_notes');
REVOKE ALL ON public.pet_groom_notes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pet_groom_notes TO authenticated;
GRANT ALL ON public.pet_groom_notes TO service_role;

-- Same read rule as public.dogs: may_read_property.
DROP POLICY IF EXISTS "Read groom notes on properties you may see" ON public.pet_groom_notes;
CREATE POLICY "Read groom notes on properties you may see" ON public.pet_groom_notes
  FOR SELECT TO authenticated USING (
    public.is_org_member((SELECT auth.uid()), organization_id) AND EXISTS (
      SELECT 1 FROM public.dogs d WHERE d.id = dog_id
        AND d.organization_id = pet_groom_notes.organization_id
        AND public.may_read_property(d.property_id)
    )
  );
-- Writes are narrowed to the office or the assigned groomer by the trigger.
DROP POLICY IF EXISTS "Members write groom notes" ON public.pet_groom_notes;
CREATE POLICY "Members write groom notes" ON public.pet_groom_notes
  FOR INSERT TO authenticated WITH CHECK (public.is_org_member((SELECT auth.uid()), organization_id));
DROP POLICY IF EXISTS "Members update groom notes" ON public.pet_groom_notes;
CREATE POLICY "Members update groom notes" ON public.pet_groom_notes
  FOR UPDATE TO authenticated USING (public.is_org_member((SELECT auth.uid()), organization_id))
  WITH CHECK (public.is_org_member((SELECT auth.uid()), organization_id));
DROP POLICY IF EXISTS "Office deletes groom notes" ON public.pet_groom_notes;
CREATE POLICY "Office deletes groom notes" ON public.pet_groom_notes
  FOR DELETE TO authenticated USING (public.can_write_org((SELECT auth.uid()), organization_id));

-- ── 5. What this file establishes ────────────────────────────────────────

DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.visits'::regclass AND tgname = 'visits_groom_plan_stamp' AND tgenabled = 'O'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.visits'::regclass AND tgname = 'visits_groom_plan_addons' AND tgenabled = 'O'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.pet_groom_notes'::regclass AND tgname = 'pet_groom_notes_before_write' AND tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'A groom plan trigger is missing.';
  END IF;
  IF has_function_privilege('authenticated', 'public.tg_visits_groom_plan_stamp()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.tg_visits_groom_plan_stamp()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tg_visits_groom_plan_addons()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.tg_visits_groom_plan_addons()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tg_pet_groom_notes_before_write()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.tg_pet_groom_notes_before_write()', 'EXECUTE') THEN
    RAISE EXCEPTION 'A groom trigger function is callable by a signed-in user.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.pet_groom_notes'::regclass AND relrowsecurity)
     OR (SELECT count(*) FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'pet_groom_notes' AND permissive = 'PERMISSIVE') <> 4
     OR NOT EXISTS (SELECT 1 FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'pet_groom_notes' AND permissive = 'RESTRICTIVE')
     OR has_table_privilege('anon', 'public.pet_groom_notes', 'SELECT') THEN
    RAISE EXCEPTION 'pet_groom_notes security is missing.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'visits' AND column_name = 'start_time'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'groom_buffer_min'
       AND is_nullable = 'NO' AND column_default = '15'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'dogs' AND column_name = 'muzzle_required'
  ) THEN
    RAISE EXCEPTION 'A grooming column is missing.';
  END IF;
END
$post$;
