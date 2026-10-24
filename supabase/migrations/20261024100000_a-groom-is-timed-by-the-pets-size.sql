-- G1: pet facts and per-pet appointment prices and lengths. No existing pricing path changes.
ALTER TABLE public.dogs ADD COLUMN IF NOT EXISTS coat_type text;
ALTER TABLE public.dogs ADD COLUMN IF NOT EXISTS weight_lb numeric(5,1);
ALTER TABLE public.dogs DROP CONSTRAINT IF EXISTS dogs_coat_type_check;
ALTER TABLE public.dogs ADD CONSTRAINT dogs_coat_type_check
  CHECK (coat_type IN ('short','medium','long','double','curly','wire'));
ALTER TABLE public.dogs DROP CONSTRAINT IF EXISTS dogs_weight_lb_check;
ALTER TABLE public.dogs ADD CONSTRAINT dogs_weight_lb_check CHECK (weight_lb > 0 AND weight_lb <= 300);

CREATE TABLE IF NOT EXISTS public.service_size_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES public.services(id) ON DELETE CASCADE,
  size text NOT NULL CHECK (size IN ('small','medium','large','xlarge')),
  coat_type text CHECK (coat_type IN ('short','medium','long','double','curly','wire')),
  duration_min smallint NOT NULL CHECK (duration_min BETWEEN 1 AND 720),
  price_cents integer NOT NULL CHECK (price_cents BETWEEN 0 AND 10000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_size_rules_service_size_coat_key UNIQUE NULLS NOT DISTINCT (service_id, size, coat_type)
);
CREATE INDEX IF NOT EXISTS service_size_rules_service_id_idx ON public.service_size_rules(service_id);

CREATE OR REPLACE FUNCTION public.tg_service_size_rules_service()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  service_line text;
BEGIN
  SELECT s.organization_id, s.service_line INTO NEW.organization_id, service_line
    FROM public.services s WHERE s.id = NEW.service_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Service not found.' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF service_line <> 'mobile_grooming' THEN
    RAISE EXCEPTION 'Size rules are only for mobile grooming services.' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.tg_service_size_rules_service() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS service_size_rules_service ON public.service_size_rules;
CREATE TRIGGER service_size_rules_service BEFORE INSERT OR UPDATE ON public.service_size_rules
  FOR EACH ROW EXECUTE FUNCTION public.tg_service_size_rules_service();

ALTER TABLE public.service_size_rules ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.service_size_rules');
REVOKE ALL ON public.service_size_rules FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.service_size_rules TO authenticated;
GRANT ALL ON public.service_size_rules TO service_role;
DROP POLICY IF EXISTS "Members read size rules" ON public.service_size_rules;
CREATE POLICY "Members read size rules" ON public.service_size_rules FOR SELECT TO authenticated
  USING (public.is_org_member((SELECT auth.uid()), organization_id));
DROP POLICY IF EXISTS "Office inserts size rules" ON public.service_size_rules;
CREATE POLICY "Office inserts size rules" ON public.service_size_rules FOR INSERT TO authenticated
  WITH CHECK (public.can_write_org((SELECT auth.uid()), organization_id));
DROP POLICY IF EXISTS "Office updates size rules" ON public.service_size_rules;
CREATE POLICY "Office updates size rules" ON public.service_size_rules FOR UPDATE TO authenticated
  USING (public.can_write_org((SELECT auth.uid()), organization_id))
  WITH CHECK (public.can_write_org((SELECT auth.uid()), organization_id));
DROP POLICY IF EXISTS "Office deletes size rules" ON public.service_size_rules;
CREATE POLICY "Office deletes size rules" ON public.service_size_rules FOR DELETE TO authenticated
  USING (public.can_write_org((SELECT auth.uid()), organization_id));

ALTER TABLE public.addon_services ADD COLUMN IF NOT EXISTS duration_min smallint NOT NULL DEFAULT 0;
ALTER TABLE public.addon_services ADD COLUMN IF NOT EXISTS service_line text;
ALTER TABLE public.addon_services DROP CONSTRAINT IF EXISTS addon_services_duration_min_check;
ALTER TABLE public.addon_services ADD CONSTRAINT addon_services_duration_min_check CHECK (duration_min BETWEEN 0 AND 480);
ALTER TABLE public.addon_services DROP CONSTRAINT IF EXISTS addon_services_service_line_check;
ALTER TABLE public.addon_services ADD CONSTRAINT addon_services_service_line_check
  CHECK (service_line IS NULL OR service_line IN ('pet_waste','dog_walking','pet_sitting','mobile_grooming','training','other'));

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'dogs' AND column_name = 'coat_type')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'dogs' AND column_name = 'weight_lb' AND numeric_precision = 5 AND numeric_scale = 1)
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'addon_services' AND column_name = 'duration_min' AND is_nullable = 'NO')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'addon_services' AND column_name = 'service_line') THEN
    RAISE EXCEPTION 'Grooming columns are missing.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.service_size_rules'::regclass AND relrowsecurity)
    OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid = 'public.service_size_rules'::regclass AND indisunique AND indnullsnotdistinct)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.service_size_rules'::regclass AND tgname = 'service_size_rules_service' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'Size rule security, uniqueness or service trigger is missing.';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'service_size_rules' AND permissive = 'PERMISSIVE') <> 4
    OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'service_size_rules' AND permissive = 'RESTRICTIVE')
    OR has_table_privilege('anon', 'public.service_size_rules', 'SELECT')
    OR has_function_privilege('authenticated', 'public.tg_service_size_rules_service()', 'EXECUTE')
    OR has_function_privilege('anon', 'public.tg_service_size_rules_service()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Size rule policies or grants are missing.';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE
      (conrelid = 'public.dogs'::regclass AND conname IN ('dogs_coat_type_check','dogs_weight_lb_check')) OR
      (conrelid = 'public.addon_services'::regclass AND conname IN ('addon_services_duration_min_check','addon_services_service_line_check')) OR
      (conrelid = 'public.service_size_rules'::regclass AND contype = 'c')) <> 8 THEN
    RAISE EXCEPTION 'Grooming bounds are missing.';
  END IF;
END;
$post$;
