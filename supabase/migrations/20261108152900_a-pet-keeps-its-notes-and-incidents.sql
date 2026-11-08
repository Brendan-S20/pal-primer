-- A pet keeps its safety notes and incidents (#729).
--
-- The owner, 2026-11-08, verbatim: "Notes plus incident logs, with
-- timestamp, photo and who reported it."
--
-- One table, two kinds of entry, both on the PET rather than on a visit or
-- a line of business, so a bite reported on a walk is in front of the
-- groomer who sees the same dog next week:
--
--   * note      a safety note ("muzzle for nails", "slips collars")
--   * incident  something that happened: what kind, when, what, optionally
--               a photo
--
-- Every entry carries WHO reported it (reported_by, and reporter_name as it
-- read at the time, so the log still says who after a person leaves) and
-- WHEN (occurred_at, when it happened; created_at, when it was written).
--
-- The log is append-only, and that is the audit trail: no browser key may
-- UPDATE or DELETE a row, and a trigger refuses any change a person makes
-- even through the service role. The two exceptions are the foreign keys'
-- own ON DELETE SET NULL (a deleted visit or auth user), which the trigger
-- lets through because they change nothing but that one column. A wrong
-- entry is corrected by writing another one. Whether the office should be
-- able to RETRACT an entry (kept, but marked) is an owner question listed in
-- the PR, not something this file decides.
--
-- Who sees it: the same people who see the pet. public.dogs is read through
-- may_read_property(property_id) — the client directory, or an address on
-- the caller's own route — and so is this. Who writes it: the same, so a
-- tech in a driveway can report what happened to a dog on their route.
-- Nothing here is gated by service line, and nothing here touches vaccines,
-- medication or handler qualifications.
--
-- The photo follows pet-vaccine-records (20261024100100) exactly: a private
-- bucket, paths <org>/<dog>/<uuid>.<ext>, a SECURITY DEFINER helper that
-- parses the path without a cast error, and storage policies that ask it.
-- Images only, 10 MB. Read and upload only: like the rows, a photo is not
-- replaced or removed by a browser key.
--
-- Replays into an empty database: one table, its trigger, one bucket, one
-- helper, policies, grants. The check block asserts what this file
-- establishes and needs no row.

CREATE TABLE IF NOT EXISTS public.pet_safety_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  dog_id uuid NOT NULL REFERENCES public.dogs(id) ON DELETE CASCADE,
  visit_id uuid REFERENCES public.visits(id) ON DELETE SET NULL,
  entry_type text NOT NULL,
  incident_kind text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  body text NOT NULL,
  storage_path text UNIQUE,
  reported_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reporter_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pet_safety_entries_type_check CHECK (entry_type IN ('note', 'incident')),
  CONSTRAINT pet_safety_entries_kind_check CHECK (incident_kind IS NULL OR incident_kind IN (
    'bite', 'scratch', 'aggression', 'escape', 'injury_to_pet', 'injury_to_person',
    'illness', 'property_damage', 'other')),
  -- An incident says what kind; a note does not.
  CONSTRAINT pet_safety_entries_kind_matches_type CHECK ((entry_type = 'incident') = (incident_kind IS NOT NULL)),
  CONSTRAINT pet_safety_entries_body_length CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000),
  CONSTRAINT pet_safety_entries_reporter_name_length CHECK (char_length(btrim(reporter_name)) BETWEEN 1 AND 160)
);

COMMENT ON TABLE public.pet_safety_entries IS
  'Per-pet safety notes and incident log (#729). Append-only: the rows are the audit trail. Read and written by whoever may see the pet (may_read_property), whatever the service line.';

CREATE INDEX IF NOT EXISTS pet_safety_entries_dog_recent_idx
  ON public.pet_safety_entries (dog_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS pet_safety_entries_organization_id_idx
  ON public.pet_safety_entries (organization_id);
CREATE INDEX IF NOT EXISTS pet_safety_entries_visit_id_idx
  ON public.pet_safety_entries (visit_id) WHERE visit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pet_safety_entries_reported_by_idx
  ON public.pet_safety_entries (reported_by) WHERE reported_by IS NOT NULL;

CREATE OR REPLACE FUNCTION public.pet_safety_entries_before_write()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _org uuid;
  _property uuid;
  _name text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Append-only. The one change let through is a foreign key's own
    -- ON DELETE SET NULL, which moves nothing but that column to NULL.
    IF (NEW.visit_id IS NULL OR NEW.visit_id = OLD.visit_id)
       AND (NEW.reported_by IS NULL OR NEW.reported_by = OLD.reported_by)
       AND (ROW(NEW.id, NEW.organization_id, NEW.dog_id, NEW.entry_type, NEW.incident_kind,
                NEW.occurred_at, NEW.body, NEW.storage_path, NEW.reporter_name, NEW.created_at)
            IS NOT DISTINCT FROM
            ROW(OLD.id, OLD.organization_id, OLD.dog_id, OLD.entry_type, OLD.incident_kind,
                OLD.occurred_at, OLD.body, OLD.storage_path, OLD.reporter_name, OLD.created_at))
       AND (NEW.visit_id IS DISTINCT FROM OLD.visit_id OR NEW.reported_by IS DISTINCT FROM OLD.reported_by)
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'A safety log entry cannot be changed; add a new entry instead';
  END IF;

  SELECT organization_id, property_id INTO _org, _property
    FROM public.dogs WHERE id = NEW.dog_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Pet not found'; END IF;
  NEW.organization_id := _org;

  IF NEW.visit_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.visits v
     WHERE v.id = NEW.visit_id AND v.organization_id = _org AND v.property_id = _property
  ) THEN
    RAISE EXCEPTION 'That visit is not at this pet''s address';
  END IF;

  IF NEW.storage_path IS NOT NULL AND (
    NEW.storage_path NOT LIKE _org::text || '/' || NEW.dog_id::text || '/%'
    OR NEW.storage_path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp|heic|heif)$'
  ) THEN
    RAISE EXCEPTION 'Safety photo path must belong to the pet';
  END IF;

  -- When it happened may be earlier than now, never later (five minutes of
  -- phone-clock slack), and not before the pet could have been on the books.
  IF NEW.occurred_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'An incident cannot be in the future';
  END IF;
  IF NEW.occurred_at < now() - interval '5 years' THEN
    RAISE EXCEPTION 'An incident more than five years ago belongs in the pet''s notes';
  END IF;

  -- A signed-in caller reports as themselves, under their own staff name.
  -- The service role (auth.uid() null) must say who, and gets no default.
  IF auth.uid() IS NOT NULL THEN
    NEW.reported_by := auth.uid();
    SELECT NULLIF(btrim(s.display_name), '') INTO _name
      FROM public.staff s
     WHERE s.user_id = auth.uid() AND s.organization_id = _org
     ORDER BY s.active DESC
     LIMIT 1;
    NEW.reporter_name := COALESCE(_name, NULLIF(btrim(NEW.reporter_name), ''), 'Staff member');
  ELSIF NEW.reported_by IS NULL OR NULLIF(btrim(NEW.reporter_name), '') IS NULL THEN
    RAISE EXCEPTION 'A safety log entry must say who reported it';
  END IF;

  NEW.created_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.pet_safety_entries_before_write() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS pet_safety_entries_before_write ON public.pet_safety_entries;
CREATE TRIGGER pet_safety_entries_before_write BEFORE INSERT OR UPDATE ON public.pet_safety_entries
  FOR EACH ROW EXECUTE FUNCTION public.pet_safety_entries_before_write();

ALTER TABLE public.pet_safety_entries ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.pet_safety_entries');
REVOKE ALL ON public.pet_safety_entries FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.pet_safety_entries TO authenticated;
GRANT ALL ON public.pet_safety_entries TO service_role;

-- The same question public.dogs asks: may the caller see this pet's address?
DROP POLICY IF EXISTS "Read safety entries on pets you may see" ON public.pet_safety_entries;
CREATE POLICY "Read safety entries on pets you may see" ON public.pet_safety_entries
  FOR SELECT TO authenticated USING (
    public.is_org_member((SELECT auth.uid()), organization_id) AND EXISTS (
      SELECT 1 FROM public.dogs d WHERE d.id = dog_id
        AND d.organization_id = pet_safety_entries.organization_id
        AND public.may_read_property(d.property_id)
    )
  );
-- organization_id is set by the trigger from the dog, before this check runs,
-- so a row naming another org's dog is checked against THAT org and refused.
DROP POLICY IF EXISTS "Report safety entries on pets you may see" ON public.pet_safety_entries;
CREATE POLICY "Report safety entries on pets you may see" ON public.pet_safety_entries
  FOR INSERT TO authenticated WITH CHECK (
    public.is_org_member((SELECT auth.uid()), organization_id)
    AND reported_by = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.dogs d WHERE d.id = dog_id
        AND d.organization_id = pet_safety_entries.organization_id
        AND public.may_read_property(d.property_id)
    )
  );

-- ── the photo ───────────────────────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('pet-safety-photos', 'pet-safety-photos', false, 10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
ON CONFLICT (id) DO UPDATE SET public = false,
  file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE OR REPLACE FUNCTION public.can_use_pet_safety_photo(name text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _parts text[] := string_to_array(name, '/');
  _org uuid;
  _dog uuid;
BEGIN
  IF auth.uid() IS NULL OR COALESCE(array_length(_parts, 1), 0) <> 3
    OR _parts[1] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR _parts[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR _parts[3] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|heic|heif)$'
  THEN RETURN false; END IF;
  _org := _parts[1]::uuid;
  _dog := _parts[2]::uuid;
  RETURN public.is_org_member(auth.uid(), _org)
    AND EXISTS (SELECT 1 FROM public.dogs d
      WHERE d.id = _dog AND d.organization_id = _org
        AND public.may_read_property(d.property_id));
END;
$$;
REVOKE ALL ON FUNCTION public.can_use_pet_safety_photo(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_use_pet_safety_photo(text) TO authenticated, service_role;

DROP POLICY IF EXISTS "pet safety photos read" ON storage.objects;
CREATE POLICY "pet safety photos read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'pet-safety-photos' AND public.can_use_pet_safety_photo(name));
DROP POLICY IF EXISTS "pet safety photos upload" ON storage.objects;
CREATE POLICY "pet safety photos upload" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'pet-safety-photos' AND public.can_use_pet_safety_photo(name));

-- ── what this file establishes ──────────────────────────────────────────────
DO $check$
DECLARE _cmd text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'pet-safety-photos'
    AND NOT public AND file_size_limit = 10485760 AND allowed_mime_types =
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']) THEN
    RAISE EXCEPTION 'pet-safety-photos must exist, private, images only, 10 MB';
  END IF;
  FOREACH _cmd IN ARRAY ARRAY['SELECT', 'INSERT'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
      AND cmd = _cmd AND roles = ARRAY['authenticated']::name[] AND permissive = 'PERMISSIVE'
      AND COALESCE(qual, '') || COALESCE(with_check, '') LIKE '%pet-safety-photos%can_use_pet_safety_photo%') THEN
      RAISE EXCEPTION 'pet-safety-photos % policy missing', _cmd;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'pet_safety_entries'
      AND cmd = _cmd AND permissive = 'PERMISSIVE') THEN
      RAISE EXCEPTION 'pet_safety_entries % policy missing', _cmd;
    END IF;
  END LOOP;
  -- Append-only: nothing lets a browser key change or remove a photo or a row.
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
      AND cmd IN ('UPDATE', 'DELETE', 'ALL') AND permissive = 'PERMISSIVE'
      AND COALESCE(qual, '') || COALESCE(with_check, '') LIKE '%pet-safety-photos%')
    OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'pet_safety_entries'
      AND cmd IN ('UPDATE', 'DELETE', 'ALL') AND permissive = 'PERMISSIVE')
    OR has_table_privilege('authenticated', 'public.pet_safety_entries', 'UPDATE')
    OR has_table_privilege('authenticated', 'public.pet_safety_entries', 'DELETE') THEN
    RAISE EXCEPTION 'pet safety log must be append-only for browser keys';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.pet_safety_entries'::regclass AND relrowsecurity)
    OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'pet_safety_entries'
      AND permissive = 'RESTRICTIVE')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.pet_safety_entries'::regclass
      AND tgname = 'pet_safety_entries_before_write' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'pet_safety_entries RLS, two-step sign-in policy or trigger missing';
  END IF;
  IF has_function_privilege('anon', 'public.can_use_pet_safety_photo(text)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.pet_safety_entries_before_write()', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.pet_safety_entries_before_write()', 'EXECUTE')
    OR has_table_privilege('anon', 'public.pet_safety_entries', 'SELECT')
    OR has_table_privilege('anon', 'public.pet_safety_entries', 'INSERT') THEN
    RAISE EXCEPTION 'pet safety log grants unexpected anonymous or trigger access';
  END IF;
END;
$check$;
