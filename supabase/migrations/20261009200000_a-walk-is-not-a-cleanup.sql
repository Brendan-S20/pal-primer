-- A walk is not a cleanup: the service catalog (phase 1).
--
-- The owner decided on 2026-10-09 that dog walking, pet sitting and mobile
-- grooming go live alongside pet waste removal. Step 1 (20261008120000) let a
-- business SAY what it runs. This is the first thing that lets it SELL more
-- than one thing: a per-business list of services -- "30-minute walk",
-- "Overnight stay", "Full groom (90 min)", "Pet waste removal" -- each with
-- its line, how it is priced and how long it usually takes. See
-- docs/other-trades-service-catalog.md, Appendix A; phase 2 points plans and
-- visits at these rows.
--
-- ── PRICING: "BOTH, BUSINESS CHOOSES" ────────────────────────────────────
--
-- price_unit is how the base price is counted: per `visit` (flat), per `hour`,
-- or per `night`. The owner's answer to "flat or hourly" was that the business
-- chooses, so both are offered on every line; `night` exists for sitting and
-- only for sitting (services_night_is_for_sitting), because an overnight stay
-- is the one service whose natural unit is a night.
--
-- base_price_cents is NULLABLE on purpose, with two meanings that read the
-- same way to the database and differently on screen:
--   * a pet-waste service priced by the business's ZONES, which is how every
--     pet-waste business is priced today and stays priced (phase 5 keeps zone
--     pricing as the pet-waste path) -- the seeded row below is one of these;
--   * a new service whose owner has not set a price yet. The design leaves
--     suggested prices blank on purpose: a suggested number is the one that
--     ships unread.
-- extra_pet_cents is the charge for each pet beyond the first, per unit.
--
-- default_duration_min is NULLABLE for the same pet-waste reason: a cleanup
-- takes as long as the YARD takes (properties.service_duration_min, which the
-- route planner already reads). A walk takes as long as the walk, and the
-- server functions require it for every line except pet waste.
--
-- ── WHO MAY DO WHAT ──────────────────────────────────────────────────────
--
-- Members read (a tech's card will name the service in phase 2). Writes need
-- manage_pricing -- owner and office manager -- the same split as zones
-- (20260708200000, split per command in 20260810120000). There is no DELETE
-- for the API: phase 2 points plans and visits at these rows, and a service
-- that has been sold is deactivated, not erased. Two-step sign-in applies, as
-- on every RLS table.
--
-- ── THE SEED ─────────────────────────────────────────────────────────────
--
-- One "Pet waste removal" per organization that exists when this runs, so the
-- phase 2 backfill has a row to point every current plan and visit at. It is
-- an INSERT ... SELECT over whatever organizations exist -- none on a fresh
-- build, and that is fine -- guarded by the unique (organization_id,
-- lower(name)) index, so running it twice adds nothing. A business that has
-- already told us it does not run pet waste gets the row INACTIVE: its old
-- plans (if any) can still point at it, and its Services page does not offer
-- it. No row count is asserted anywhere: a count is a fact about a database,
-- not about this file.

-- ── 1. The table ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  service_line text NOT NULL,
  price_unit text NOT NULL DEFAULT 'visit',
  base_price_cents integer,
  extra_pet_cents integer NOT NULL DEFAULT 0,
  default_duration_min smallint,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT services_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  -- The same values as organizations.service_lines (service_lines_are_valid).
  CONSTRAINT services_service_line_check
    CHECK (service_line IN ('pet_waste', 'dog_walking', 'pet_sitting', 'mobile_grooming', 'other')),
  CONSTRAINT services_price_unit_check CHECK (price_unit IN ('visit', 'hour', 'night')),
  CONSTRAINT services_night_is_for_sitting
    CHECK (price_unit <> 'night' OR service_line = 'pet_sitting'),
  -- $100,000 is not a price anybody charges for a walk; it is a typo.
  CONSTRAINT services_base_price_range
    CHECK (base_price_cents IS NULL OR base_price_cents BETWEEN 0 AND 10000000),
  CONSTRAINT services_extra_pet_range CHECK (extra_pet_cents BETWEEN 0 AND 10000000),
  -- One minute to twelve hours: an overnight stay is priced by the night,
  -- not by a 720-minute duration.
  CONSTRAINT services_duration_range
    CHECK (default_duration_min IS NULL OR default_duration_min BETWEEN 1 AND 720)
);

COMMENT ON TABLE public.services IS
  'What a business sells: one row per service (a 30-minute walk, an overnight stay, pet waste removal). price_unit is visit | hour | night (night for pet_sitting only). base_price_cents NULL means priced by zones (pet waste) or not set yet. Members read; manage_pricing writes; no API delete -- deactivate. Migration 20261009200000; plans and visits point here from phase 2.';

-- One name per business, whatever its case: "30-minute walk" and
-- "30-Minute Walk" are the same thing on an invoice.
CREATE UNIQUE INDEX IF NOT EXISTS services_org_name
  ON public.services (organization_id, lower(name));

DROP TRIGGER IF EXISTS services_touch_updated_at ON public.services;
CREATE TRIGGER services_touch_updated_at
  BEFORE UPDATE ON public.services
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- ── 2. Who may read and write it ─────────────────────────────────────────

ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;

-- Two-step sign-in, like every RLS table (20261002010000_a-password-was-the-only-lock).
SELECT public.require_mfa_policy('public.services');

REVOKE ALL ON public.services FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.services TO authenticated;
GRANT ALL ON public.services TO service_role;

DROP POLICY IF EXISTS "Members read services" ON public.services;
CREATE POLICY "Members read services" ON public.services
  FOR SELECT TO authenticated
  USING (public.is_org_member((SELECT auth.uid()), organization_id));

DROP POLICY IF EXISTS "Pricing managers write services (insert)" ON public.services;
CREATE POLICY "Pricing managers write services (insert)" ON public.services
  FOR INSERT TO authenticated
  WITH CHECK (public.has_permission((SELECT auth.uid()), organization_id, 'manage_pricing'::text));

DROP POLICY IF EXISTS "Pricing managers write services (update)" ON public.services;
CREATE POLICY "Pricing managers write services (update)" ON public.services
  FOR UPDATE TO authenticated
  USING (public.has_permission((SELECT auth.uid()), organization_id, 'manage_pricing'::text))
  WITH CHECK (public.has_permission((SELECT auth.uid()), organization_id, 'manage_pricing'::text));

-- ── 3. The seed: one "Pet waste removal" per existing business ────────────

INSERT INTO public.services
  (organization_id, name, service_line, price_unit, base_price_cents, default_duration_min, active)
SELECT o.id, 'Pet waste removal', 'pet_waste', 'visit', NULL, NULL,
       'pet_waste' = ANY (o.service_lines)
  FROM public.organizations o
ON CONFLICT (organization_id, lower(name)) DO NOTHING;

-- ── What this file establishes, checked from any starting state ───────────
DO $post$
DECLARE
  _missing integer;
  _bad text;
BEGIN
  IF to_regclass('public.services') IS NULL THEN
    RAISE EXCEPTION 'public.services was not created';
  END IF;

  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.services'::regclass) THEN
    RAISE EXCEPTION 'row level security is not enabled on public.services';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'services'
       AND policyname = 'two-step sign-in, when the user has it'
       AND permissive = 'RESTRICTIVE'
  ) THEN
    RAISE EXCEPTION 'public.services has no two-step sign-in policy';
  END IF;

  -- Permissive policies only (the MFA policy is RESTRICTIVE and FOR ALL):
  -- one read, one insert, one update, and nothing that deletes.
  SELECT string_agg(cmd || ':' || policyname, ', ') INTO _bad
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'services'
     AND permissive = 'PERMISSIVE'
     AND cmd NOT IN ('SELECT', 'INSERT', 'UPDATE');
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'public.services has a permissive policy beyond read/insert/update: %', _bad;
  END IF;
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'services'
         AND permissive = 'PERMISSIVE') <> 3 THEN
    RAISE EXCEPTION 'public.services should carry exactly three permissive policies';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'services'
       AND permissive = 'PERMISSIVE' AND cmd IN ('INSERT', 'UPDATE')
       AND coalesce(qual, '') || coalesce(with_check, '') NOT LIKE '%manage_pricing%'
  ) THEN
    RAISE EXCEPTION 'a write policy on public.services does not ask for manage_pricing';
  END IF;

  IF has_table_privilege('anon', 'public.services', 'SELECT')
     OR has_table_privilege('anon', 'public.services', 'INSERT')
     OR has_table_privilege('anon', 'public.services', 'UPDATE')
     OR has_table_privilege('anon', 'public.services', 'DELETE') THEN
    RAISE EXCEPTION 'anon holds a privilege on public.services';
  END IF;
  IF has_table_privilege('authenticated', 'public.services', 'DELETE') THEN
    RAISE EXCEPTION 'authenticated can DELETE from public.services; a sold service is deactivated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indrelid = 'public.services'::regclass
       AND i.indexrelid = 'public.services_org_name'::regclass
       AND i.indisunique AND i.indisvalid
  ) THEN
    RAISE EXCEPTION 'services_org_name is missing, not unique, or invalid';
  END IF;

  -- The seed, as a property rather than a number: every organization that
  -- exists now has its pet-waste service. Zero organizations satisfies it.
  SELECT count(*) INTO _missing
    FROM public.organizations o
   WHERE NOT EXISTS (
     SELECT 1 FROM public.services s
      WHERE s.organization_id = o.id AND lower(s.name) = 'pet waste removal'
   );
  IF _missing <> 0 THEN
    RAISE EXCEPTION '% organization(s) have no "Pet waste removal" service after the seed', _missing;
  END IF;
END
$post$;
