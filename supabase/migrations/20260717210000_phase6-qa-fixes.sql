-- QA round 3 phase 6 adversarial-review fixes.
--
-- F1 — concurrent station inserts could duplicate station_number (BEFORE INSERT
--   max+1 with no lock, no unique guard). Add an advisory lock per property so
--   concurrent inserts serialize at the source, plus a DEFERRABLE unique
--   constraint as a safety net. DEFERRABLE INITIALLY IMMEDIATE is checked at
--   STATEMENT end (not per row), so renumber_property_stations' single-statement
--   reorder can't trip a transient collision. renumber takes the same advisory
--   lock so it can't race an insert.
-- F2 — 'na' is a plausible short name (blocked by the entity-name blacklist).
--   Dropped from is_valid_entity_name so real names like "Na" pass; genuine
--   junk ("ew", "test", "1") is still rejected.
-- F4 — tg_dna_matches_validate skipped the unit tenant-check when property_id
--   was NULL. Add an independent org-match on unit_id (the unit's property must
--   belong to the row's org) so a unit reference can never cross tenants.

-- ── F1: station numbering integrity ──────────────────────────────────────────
ALTER TABLE public.waste_stations
  DROP CONSTRAINT IF EXISTS waste_stations_property_number_uniq;
ALTER TABLE public.waste_stations
  ADD CONSTRAINT waste_stations_property_number_uniq
  UNIQUE (property_id, station_number) DEFERRABLE INITIALLY IMMEDIATE;

CREATE OR REPLACE FUNCTION public.tg_waste_stations_number()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  -- Serialize numbering for this property so two concurrent inserts can't both
  -- read the same MAX and land on the same station_number.
  PERFORM pg_advisory_xact_lock(hashtext('station-num:' || NEW.property_id::text));
  IF NEW.station_number IS NULL THEN
    NEW.station_number := public.next_station_number(NEW.property_id);
  END IF;
  IF COALESCE(NEW.sort_order, 0) = 0 THEN
    NEW.sort_order := NEW.station_number;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.renumber_property_stations(_property_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE _org uuid; _n integer;
BEGIN
  SELECT organization_id INTO _org FROM public.properties WHERE id = _property_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Property not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  -- Same lock as the insert trigger: renumber and inserts on this property are
  -- mutually exclusive. The reorder is one statement; the DEFERRABLE unique
  -- constraint is validated at statement end, so transient collisions are fine.
  PERFORM pg_advisory_xact_lock(hashtext('station-num:' || _property_id::text));
  WITH numbered AS (
    SELECT id,
           row_number() OVER (ORDER BY sort_order, station_number, created_at, id) AS rn
      FROM public.waste_stations
     WHERE property_id = _property_id
  )
  UPDATE public.waste_stations ws
     SET station_number = numbered.rn,
         sort_order = numbered.rn,
         updated_at = now()
    FROM numbered
   WHERE numbered.id = ws.id;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$fn$;

REVOKE ALL ON FUNCTION public.renumber_property_stations(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.renumber_property_stations(uuid) TO authenticated, service_role;

-- ── F2: 'na' is a real short name, not junk ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_valid_entity_name(_name text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN _name IS NULL THEN false
    WHEN char_length(btrim(_name)) < 2 THEN false
    WHEN btrim(_name) !~ '[A-Za-z]' THEN false
    WHEN lower(btrim(_name)) = ANY (ARRAY[
      'ew','n/a','tbd','test','asdf','qwerty','none','null','xxx','xx',
      'unknown','placeholder','.','-','--','...'
    ]) THEN false
    ELSE true
  END
$$;

-- ── F4: unit reference must not cross tenants even when property_id is NULL ───
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
  -- Independent of property_id: the unit's own property must belong to the
  -- row's org, so a unit reference can never point at another tenant.
  IF NEW.unit_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.property_units u
      JOIN public.properties p ON p.id = u.property_id
     WHERE u.id = NEW.unit_id AND p.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Unit does not belong to this organization';
  END IF;
  -- When both are given, the unit must be under that exact property.
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
