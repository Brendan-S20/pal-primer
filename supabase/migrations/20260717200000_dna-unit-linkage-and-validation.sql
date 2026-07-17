-- QA round 3 phase 6 (B8, I9): connect DNA records to the client→property→unit
-- chain, add chain-of-custody + registration fields (provider references only,
-- never raw genetic markers), server-enforced name validation, and an
-- idempotent reconciliation that flags orphan dogs for management review.

-- ── dna_matches: unit link + chain of custody + provider references ──────────
ALTER TABLE public.dna_matches
  ADD COLUMN IF NOT EXISTS unit_id uuid REFERENCES public.property_units(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS collected_by_staff_id uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS kit_reference text CHECK (kit_reference IS NULL OR char_length(kit_reference) <= 120),
  ADD COLUMN IF NOT EXISTS dna_provider text CHECK (dna_provider IS NULL OR char_length(dna_provider) <= 120),
  ADD COLUMN IF NOT EXISTS report_reference text CHECK (report_reference IS NULL OR char_length(report_reference) <= 200);

CREATE INDEX IF NOT EXISTS dna_matches_unit_idx ON public.dna_matches (unit_id) WHERE unit_id IS NOT NULL;

-- ── dogs: management-review flag + registration (kit / provider) refs ────────
ALTER TABLE public.dogs
  ADD COLUMN IF NOT EXISTS unit_review_needed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dna_provider text CHECK (dna_provider IS NULL OR char_length(dna_provider) <= 120),
  ADD COLUMN IF NOT EXISTS dna_kit_reference text CHECK (dna_kit_reference IS NULL OR char_length(dna_kit_reference) <= 120);

CREATE INDEX IF NOT EXISTS dogs_unit_review_idx ON public.dogs (organization_id) WHERE unit_review_needed;

-- ── Shared server-enforced name validation (I11) ────────────────────────────
-- Dog / zone / promo NAMES must contain a letter (rejects "1", "01", "12"),
-- be at least 2 chars, and not be a known placeholder ("Ew", "test", …).
-- Legitimate short names ("Bo", "Al", "Ax") pass.
CREATE OR REPLACE FUNCTION public.is_valid_entity_name(_name text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN _name IS NULL THEN false
    WHEN char_length(btrim(_name)) < 2 THEN false
    WHEN btrim(_name) !~ '[A-Za-z]' THEN false
    WHEN lower(btrim(_name)) = ANY (ARRAY[
      'ew','na','n/a','tbd','test','asdf','qwerty','none','null','xxx','xx',
      'unknown','placeholder','.','-','--','...'
    ]) THEN false
    ELSE true
  END
$$;

-- Labels (unit / station descriptors) allow pure numbers ("101", "B-12") but
-- still reject whitespace-only and placeholder junk.
CREATE OR REPLACE FUNCTION public.is_valid_label(_label text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN _label IS NULL THEN false
    WHEN char_length(btrim(_label)) < 1 THEN false
    WHEN lower(btrim(_label)) = ANY (ARRAY[
      'na','n/a','tbd','test','asdf','none','null','xxx','.','-','--','...'
    ]) THEN false
    ELSE true
  END
$$;

-- Dog-name validation trigger. Only enforces when the name actually changes so
-- historical rows with legacy placeholder names (I6) can still be touched for
-- unrelated column updates (e.g. reconciliation below).
CREATE OR REPLACE FUNCTION public.tg_dogs_name_validate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.name IS NOT DISTINCT FROM OLD.name THEN
    RETURN NEW;
  END IF;
  IF NOT public.is_valid_entity_name(NEW.name) THEN
    RAISE EXCEPTION 'Enter a real dog name (at least two characters, not a placeholder like "%")', NEW.name;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS dogs_name_validate ON public.dogs;
CREATE TRIGGER dogs_name_validate
  BEFORE INSERT OR UPDATE ON public.dogs
  FOR EACH ROW EXECUTE FUNCTION public.tg_dogs_name_validate();

-- ── dna_matches cross-tenant validation (mirrors round-8 unit triggers) ─────
CREATE OR REPLACE FUNCTION public.tg_dna_matches_validate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF NEW.property_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.properties p
     WHERE p.id = NEW.property_id AND p.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Property does not belong to this organization';
  END IF;
  IF NEW.client_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.clients c
     WHERE c.id = NEW.client_id AND c.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Client does not belong to this organization';
  END IF;
  IF NEW.unit_id IS NOT NULL AND NEW.property_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.property_units u
     WHERE u.id = NEW.unit_id AND u.property_id = NEW.property_id
  ) THEN
    RAISE EXCEPTION 'Unit does not belong to this property';
  END IF;
  IF NEW.matched_dog_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.dogs d
     WHERE d.id = NEW.matched_dog_id AND d.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Matched dog does not belong to this organization';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS dna_matches_validate ON public.dna_matches;
CREATE TRIGGER dna_matches_validate
  BEFORE INSERT OR UPDATE ON public.dna_matches
  FOR EACH ROW EXECUTE FUNCTION public.tg_dna_matches_validate();

-- ── Idempotent reconciliation (I5): orphan dogs → management review ──────────
-- A dog on a property that HAS units but is not assigned to one is ambiguous:
-- flag it for management review rather than silently guessing a unit.
UPDATE public.dogs d
   SET unit_review_needed = true
 WHERE d.unit_id IS NULL
   AND EXISTS (SELECT 1 FROM public.property_units pu WHERE pu.property_id = d.property_id)
   AND d.unit_review_needed IS DISTINCT FROM true;

-- A dog that is assigned, or whose property has no units at all, is never in
-- review (keeps the flag correct if units were later added/removed).
UPDATE public.dogs d
   SET unit_review_needed = false
 WHERE d.unit_review_needed = true
   AND (d.unit_id IS NOT NULL
        OR NOT EXISTS (SELECT 1 FROM public.property_units pu WHERE pu.property_id = d.property_id));
