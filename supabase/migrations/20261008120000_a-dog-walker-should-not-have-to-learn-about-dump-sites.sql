-- What this business runs: an org-level list of service lines.
--
-- The first step toward opening HoundStack to other route-based pet services
-- (dog walking, pet sitting, mobile grooming). The core of the product --
-- clients, properties, plans, visits, routes, My Day, invoices, the portal,
-- timesheets, reports -- is not about dog waste. A handful of modules are:
-- the waste log and its dump sites, waste stations and DNA, the yard outline
-- and area pricing, the first cleanup, the seasonal deep clean and the
-- re-clean guarantee. This column is what lets the screens ask "does this
-- business do pet waste?" instead of assuming it.
--
-- ── WHAT THIS IS, AND WHAT IT IS NOT ──────────────────────────────────────
--
-- It copies `commercial_accounts` (20260809010000), and for the same reason:
-- it is the owner's own description of their own business, read for
-- RENDERING. There is no adversary -- the person who could bypass it is the
-- person who set it -- so nothing on the server refuses a write because of
-- it, and nothing is deleted when a line is removed. A business that stops
-- doing pet waste keeps its dump sites and its waste log; it stops being
-- shown them.
--
-- It is NOT the service catalog. Booking a 30-minute walk at 11:00 and
-- another at 16:00 on the same day needs a services table, time slots in
-- place of UNIQUE (subscription_id, scheduled_on), a weekday-set cadence and
-- pets that are not all dogs; see docs/other-trades-service-catalog.md. Until
-- that lands, the settings screen offers only pet waste as selectable and
-- marks the others "coming soon".
--
-- ── WHY AN ARRAY AND NOT A SINGLE VALUE ───────────────────────────────────
--
-- A scooping business that also walks dogs is the common case, not the
-- exotic one, and the second line is how most of them would grow. A single
-- enum would force a choice nobody in that business would make.
--
-- ── WHY text[] WITH A CHECK RATHER THAN AN ENUM ARRAY ─────────────────────
--
-- Adding a value to a Postgres enum cannot run inside the transaction that
-- then uses it, and every addition is a migration that has to replay on a
-- fresh build. A CHECK through an IMMUTABLE function (the same shape as
-- visit_checklist_is_valid) gives the same guarantee and changes in one
-- CREATE OR REPLACE.
--
-- ── WRITE PATH: NOTHING WIDENED ───────────────────────────────────────────
--
-- Written by setServiceLines through updateOwnOrg, i.e. a plain UPDATE on
-- public.organizations under the "Settings managers update own org" policy
-- (manage_settings; 20260731180000, re-scoped 20260809200000) and the
-- restrictive MFA policy. No grant is added and no policy is touched.
-- Deliberately NOT added to tg_orgs_protect_platform_columns: that trigger
-- guards what the platform sells, and this is the owner's preference.
--
-- ── BACKFILL ──────────────────────────────────────────────────────────────
--
-- Every existing organization is a pet-waste business, so the backfill is the
-- default. ADD COLUMN ... DEFAULT fills every existing row; the UPDATE below
-- only matters if the column already existed without a usable value, and it
-- makes no assertion about which organizations exist (CLAUDE.md: a fresh
-- build has none).

-- ── The rule, once ────────────────────────────────────────────────────────
-- Non-empty, one-dimensional, no NULLs, no duplicates, every element known.
-- `other` is accepted by the database so a future "something else" answer
-- needs no migration; the settings screen does not offer it.
CREATE OR REPLACE FUNCTION public.service_lines_are_valid(_lines text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN _lines IS NULL THEN false
    WHEN cardinality(_lines) = 0 THEN false
    WHEN array_ndims(_lines) <> 1 THEN false
    ELSE NOT EXISTS (
           SELECT 1 FROM unnest(_lines) AS l(line)
            WHERE line IS NULL
               OR line NOT IN ('pet_waste', 'dog_walking', 'pet_sitting', 'mobile_grooming', 'other')
         )
     AND (SELECT count(DISTINCT line) FROM unnest(_lines) AS l(line)) = cardinality(_lines)
  END;
$function$;

-- A CHECK runs its function as whoever is writing the row, so the roles that
-- write organizations keep EXECUTE; anon never writes one.
REVOKE ALL ON FUNCTION public.service_lines_are_valid(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.service_lines_are_valid(text[]) TO authenticated, service_role;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS service_lines text[] NOT NULL DEFAULT '{pet_waste}'::text[];

UPDATE public.organizations
   SET service_lines = '{pet_waste}'::text[]
 WHERE service_lines IS NULL OR cardinality(service_lines) = 0;

ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_service_lines_valid;
ALTER TABLE public.organizations ADD CONSTRAINT organizations_service_lines_valid
  CHECK (public.service_lines_are_valid(service_lines));

COMMENT ON COLUMN public.organizations.service_lines IS
  'Owner-set: which route-based pet services this business runs (pet_waste, dog_walking, pet_sitting, mobile_grooming, other). Read for rendering only: without pet_waste, the waste log, dump sites, stations/DNA, yard outline, area pricing, first cleanup, deep clean and re-clean screens are hidden from THIS ORG''S STAFF. Never gates a write and never deletes data -- see migration 20261008120000.';

-- ── What this file establishes, checked from any starting state ───────────
DO $post$
DECLARE
  _col record;
  _bad integer;
BEGIN
  SELECT data_type, is_nullable, column_default INTO _col
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'organizations'
     AND column_name = 'service_lines';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organizations.service_lines was not added';
  END IF;
  IF _col.data_type <> 'ARRAY' OR _col.is_nullable <> 'NO' THEN
    RAISE EXCEPTION 'organizations.service_lines is % (nullable %), expected a NOT NULL array',
      _col.data_type, _col.is_nullable;
  END IF;
  IF _col.column_default IS NULL OR _col.column_default NOT LIKE '%pet_waste%' THEN
    RAISE EXCEPTION 'organizations.service_lines default is %, expected {pet_waste}', _col.column_default;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.organizations'::regclass
       AND conname = 'organizations_service_lines_valid'
       AND contype = 'c'
       AND convalidated
  ) THEN
    RAISE EXCEPTION 'organizations_service_lines_valid is missing or not validated';
  END IF;

  -- The rule itself, on literals: true for every shape the app writes, false
  -- for every shape it must refuse. Proves the function, not the data.
  IF NOT public.service_lines_are_valid('{pet_waste}')
     OR NOT public.service_lines_are_valid('{pet_waste,dog_walking}')
     OR NOT public.service_lines_are_valid('{dog_walking,pet_sitting,mobile_grooming,other}') THEN
    RAISE EXCEPTION 'service_lines_are_valid refuses a valid set';
  END IF;
  IF public.service_lines_are_valid('{}')
     OR public.service_lines_are_valid(NULL)
     OR public.service_lines_are_valid('{lawn_care}')
     OR public.service_lines_are_valid(ARRAY['pet_waste', NULL])
     OR public.service_lines_are_valid('{pet_waste,pet_waste}')
     OR public.service_lines_are_valid('{{pet_waste}}') THEN
    RAISE EXCEPTION 'service_lines_are_valid accepts an invalid set';
  END IF;

  IF has_function_privilege('anon', 'public.service_lines_are_valid(text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute service_lines_are_valid';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.service_lines_are_valid(text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated cannot execute service_lines_are_valid, so its own org writes would fail the CHECK';
  END IF;

  -- Holds on any data: the constraint is validated, so this can only fail if
  -- the constraint above did not take. Zero rows on a fresh build is fine.
  SELECT count(*) INTO _bad FROM public.organizations
   WHERE NOT public.service_lines_are_valid(service_lines);
  IF _bad <> 0 THEN
    RAISE EXCEPTION '% organization(s) hold an invalid service_lines', _bad;
  END IF;
END
$post$;
