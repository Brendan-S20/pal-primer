-- Vaccine rules are read only for mobile grooming. Documents stay private.
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS vaccine_rule text NOT NULL DEFAULT 'warn',
  ADD COLUMN IF NOT EXISTS required_vaccines text[] NOT NULL DEFAULT '{rabies}';
ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_vaccine_rule_check;
ALTER TABLE public.organizations ADD CONSTRAINT organizations_vaccine_rule_check
  CHECK (vaccine_rule IN ('off', 'warn', 'block'));
ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_required_vaccines_check;
ALTER TABLE public.organizations ADD CONSTRAINT organizations_required_vaccines_check
  CHECK (array_position(required_vaccines, NULL) IS NULL AND required_vaccines <@
    ARRAY['rabies', 'dhpp', 'bordetella', 'leptospirosis', 'canine_influenza']::text[]);

CREATE TABLE IF NOT EXISTS public.pet_vaccinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  dog_id uuid NOT NULL REFERENCES public.dogs(id) ON DELETE CASCADE,
  vaccine text NOT NULL CHECK (vaccine IN ('rabies', 'dhpp', 'bordetella', 'leptospirosis', 'canine_influenza', 'other')),
  vaccine_note text CHECK (char_length(vaccine_note) <= 80),
  given_on date,
  expires_on date NOT NULL,
  storage_path text UNIQUE,
  file_name text CHECK (char_length(file_name) <= 200),
  source text NOT NULL CHECK (source IN ('office', 'portal')),
  verified_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  verified_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (vaccine <> 'other' OR NULLIF(btrim(vaccine_note), '') IS NOT NULL),
  CHECK (given_on IS NULL OR given_on <= expires_on),
  CHECK ((verified_by IS NULL) = (verified_at IS NULL))
);
CREATE INDEX IF NOT EXISTS pet_vaccinations_dog_vaccine_expiry_idx
  ON public.pet_vaccinations (dog_id, vaccine, expires_on DESC);

CREATE OR REPLACE FUNCTION public.pet_vaccinations_before_write()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _org uuid;
BEGIN
  -- Lock the dog so simultaneous portal confirmations share the same cap.
  SELECT organization_id INTO _org FROM public.dogs WHERE id = NEW.dog_id FOR UPDATE;
  IF _org IS NULL THEN RAISE EXCEPTION 'Pet not found'; END IF;
  NEW.organization_id := _org;
  IF NEW.storage_path IS NOT NULL AND (
    NEW.storage_path NOT LIKE _org::text || '/' || NEW.dog_id::text || '/%'
    OR NEW.storage_path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp|heic|heif|pdf)$'
  ) THEN
    RAISE EXCEPTION 'Vaccine document path must belong to the pet';
  END IF;
  IF NEW.source = 'portal' AND (
    SELECT count(*) FROM public.pet_vaccinations
    WHERE dog_id = NEW.dog_id AND source = 'portal' AND id <> NEW.id
  ) >= 20 THEN
    RAISE EXCEPTION 'A pet can have at most 20 portal vaccine records';
  END IF;
  -- ON DELETE SET NULL for an auth user must also clear the paired timestamp.
  IF TG_OP = 'UPDATE' AND OLD.verified_by IS NOT NULL AND NEW.verified_by IS NULL THEN
    NEW.verified_at := NULL;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.pet_vaccinations_before_write() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS pet_vaccinations_before_write ON public.pet_vaccinations;
CREATE TRIGGER pet_vaccinations_before_write BEFORE INSERT OR UPDATE ON public.pet_vaccinations
  FOR EACH ROW EXECUTE FUNCTION public.pet_vaccinations_before_write();

ALTER TABLE public.pet_vaccinations ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.pet_vaccinations');
REVOKE ALL ON public.pet_vaccinations FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pet_vaccinations TO authenticated;
GRANT ALL ON public.pet_vaccinations TO service_role;

-- public.dogs SELECT uses may_read_property(property_id). Keep the same rule.
DROP POLICY IF EXISTS "Read vaccine records on properties you may see" ON public.pet_vaccinations;
CREATE POLICY "Read vaccine records on properties you may see" ON public.pet_vaccinations
  FOR SELECT TO authenticated USING (
    public.is_org_member(auth.uid(), organization_id) AND EXISTS (
      SELECT 1 FROM public.dogs d WHERE d.id = dog_id
        AND d.organization_id = pet_vaccinations.organization_id
        AND public.may_read_property(d.property_id)
    )
  );
DROP POLICY IF EXISTS "Office inserts vaccine records" ON public.pet_vaccinations;
CREATE POLICY "Office inserts vaccine records" ON public.pet_vaccinations
  FOR INSERT TO authenticated WITH CHECK (public.can_write_org(auth.uid(), organization_id));
DROP POLICY IF EXISTS "Office updates vaccine records" ON public.pet_vaccinations;
CREATE POLICY "Office updates vaccine records" ON public.pet_vaccinations
  FOR UPDATE TO authenticated USING (public.can_write_org(auth.uid(), organization_id))
  WITH CHECK (public.can_write_org(auth.uid(), organization_id));
DROP POLICY IF EXISTS "Office deletes vaccine records" ON public.pet_vaccinations;
CREATE POLICY "Office deletes vaccine records" ON public.pet_vaccinations
  FOR DELETE TO authenticated USING (public.can_write_org(auth.uid(), organization_id));

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('pet-vaccine-records', 'pet-vaccine-records', false, 10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'])
ON CONFLICT (id) DO UPDATE SET public = false,
  file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE OR REPLACE FUNCTION public.can_use_vaccine_record(name text, write boolean)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _parts text[] := string_to_array(name, '/');
  _org uuid;
  _dog uuid;
BEGIN
  IF auth.uid() IS NULL OR array_length(_parts, 1) <> 3
    OR _parts[1] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR _parts[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR _parts[3] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|heic|heif|pdf)$'
  THEN RETURN false; END IF;
  _org := _parts[1]::uuid;
  _dog := _parts[2]::uuid;
  RETURN public.is_org_member(auth.uid(), _org)
    AND EXISTS (SELECT 1 FROM public.dogs d
      WHERE d.id = _dog AND d.organization_id = _org
        AND public.may_read_property(d.property_id))
    AND (NOT write OR public.can_write_org(auth.uid(), _org));
END;
$$;
REVOKE ALL ON FUNCTION public.can_use_vaccine_record(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_use_vaccine_record(text, boolean) TO authenticated, service_role;

DROP POLICY IF EXISTS "vaccine records read" ON storage.objects;
CREATE POLICY "vaccine records read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'pet-vaccine-records' AND public.can_use_vaccine_record(name, false));
DROP POLICY IF EXISTS "vaccine records upload" ON storage.objects;
CREATE POLICY "vaccine records upload" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'pet-vaccine-records' AND public.can_use_vaccine_record(name, true));
DROP POLICY IF EXISTS "vaccine records update" ON storage.objects;
CREATE POLICY "vaccine records update" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'pet-vaccine-records' AND public.can_use_vaccine_record(name, true))
  WITH CHECK (bucket_id = 'pet-vaccine-records' AND public.can_use_vaccine_record(name, true));
DROP POLICY IF EXISTS "vaccine records delete" ON storage.objects;
CREATE POLICY "vaccine records delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'pet-vaccine-records' AND public.can_use_vaccine_record(name, true));

DO $$
DECLARE _cmd text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'pet-vaccine-records'
    AND NOT public AND file_size_limit = 10485760 AND allowed_mime_types =
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']) THEN
    RAISE EXCEPTION 'Vaccine bucket must exist with private upload limits';
  END IF;
  FOREACH _cmd IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
      AND cmd = _cmd AND roles = ARRAY['authenticated']::name[] AND permissive = 'PERMISSIVE'
      AND COALESCE(qual, '') || COALESCE(with_check, '') LIKE '%pet-vaccine-records%can_use_vaccine_record%') THEN
      RAISE EXCEPTION 'Vaccine storage % policy missing', _cmd;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'pet_vaccinations'
      AND cmd = _cmd AND permissive = 'PERMISSIVE') THEN
      RAISE EXCEPTION 'Vaccine table % policy missing', _cmd;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.pet_vaccinations'::regclass AND relrowsecurity)
    OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'pet_vaccinations'
      AND permissive = 'RESTRICTIVE')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.pet_vaccinations'::regclass
      AND tgname = 'pet_vaccinations_before_write' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
      AND indexname = 'pet_vaccinations_dog_vaccine_expiry_idx')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.organizations'::regclass
      AND conname = 'organizations_required_vaccines_check')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.organizations'::regclass
      AND conname = 'organizations_vaccine_rule_check') THEN
    RAISE EXCEPTION 'Vaccine table, trigger, index, MFA or settings constraints missing';
  END IF;
  IF has_function_privilege('anon', 'public.can_use_vaccine_record(text,boolean)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.pet_vaccinations_before_write()', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.pet_vaccinations_before_write()', 'EXECUTE')
    OR has_table_privilege('anon', 'public.pet_vaccinations', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'Vaccine records grant unexpected anonymous or trigger access';
  END IF;
END;
$$;
