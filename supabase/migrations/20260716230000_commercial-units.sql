-- Commercial units model (HOA/commercial properties): PooPrints-style
-- per-unit dogs, DNA registration status, offending incidents, and per-unit
-- charges. Residential clients are untouched — units only exist for
-- commercial properties.

-- ── property_units ──────────────────────────────────────────────────────────
CREATE TABLE public.property_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  unit_label text NOT NULL CHECK (char_length(unit_label) <= 80),
  resident_name text CHECK (char_length(resident_name) <= 160),
  resident_phone text CHECK (char_length(resident_phone) <= 40),
  resident_email text CHECK (char_length(resident_email) <= 200),
  notes text CHECK (char_length(notes) <= 1000),
  -- Denormalized count of waste_violation / dna_match incidents so unit lists
  -- can badge repeat offenders without an aggregate per row.
  offending_count integer NOT NULL DEFAULT 0 CHECK (offending_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, unit_label)
);

CREATE INDEX property_units_property_idx ON public.property_units (property_id, unit_label);
CREATE INDEX property_units_org_idx ON public.property_units (organization_id);

ALTER TABLE public.property_units ENABLE ROW LEVEL SECURITY;

CREATE POLICY property_units_select ON public.property_units
  FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY property_units_write ON public.property_units
  FOR ALL TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id))
  WITH CHECK (public.can_write_org(auth.uid(), organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.property_units TO authenticated;
GRANT ALL ON public.property_units TO service_role;

-- ── dogs: unit link + DNA registration status ───────────────────────────────
ALTER TABLE public.dogs
  ADD COLUMN unit_id uuid REFERENCES public.property_units(id) ON DELETE SET NULL,
  ADD COLUMN dna_status text NOT NULL DEFAULT 'not_registered'
    CHECK (dna_status IN ('not_registered', 'pending', 'registered'));

CREATE INDEX dogs_unit_idx ON public.dogs (unit_id) WHERE unit_id IS NOT NULL;

-- ── unit_incidents ──────────────────────────────────────────────────────────
CREATE TABLE public.unit_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  unit_id uuid NOT NULL REFERENCES public.property_units(id) ON DELETE CASCADE,
  dog_id uuid REFERENCES public.dogs(id) ON DELETE SET NULL,
  incident_on date NOT NULL DEFAULT CURRENT_DATE,
  kind text NOT NULL CHECK (kind IN ('waste_violation', 'dna_match', 'complaint', 'other')),
  notes text CHECK (char_length(notes) <= 1000),
  -- Snapshot of what was billed for this incident (the actual charge goes
  -- through create_addon_charge so it lands on the next invoice).
  charged_cents integer CHECK (charged_cents >= 0),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX unit_incidents_unit_idx ON public.unit_incidents (unit_id, incident_on DESC);
CREATE INDEX unit_incidents_org_idx ON public.unit_incidents (organization_id);

ALTER TABLE public.unit_incidents ENABLE ROW LEVEL SECURITY;

CREATE POLICY unit_incidents_select ON public.unit_incidents
  FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY unit_incidents_write ON public.unit_incidents
  FOR ALL TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id))
  WITH CHECK (public.can_write_org(auth.uid(), organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.unit_incidents TO authenticated;
GRANT ALL ON public.unit_incidents TO service_role;

-- ── zones: commercial pricing components ────────────────────────────────────
-- Commercial zone price = base + per-unit x units + per-acre x acres, then
-- the frequency multiplier (see computeCommercialZonePrice in src/lib/pricing.ts).
ALTER TABLE public.zones
  ADD COLUMN commercial_base_cents integer CHECK (commercial_base_cents >= 0),
  ADD COLUMN commercial_per_unit_cents integer CHECK (commercial_per_unit_cents >= 0),
  ADD COLUMN commercial_per_acre_cents integer CHECK (commercial_per_acre_cents >= 0);
