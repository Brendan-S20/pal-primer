-- A visit knows its service: the service catalog, phase 2.
--
-- Phase 1 (20261009200000_a-walk-is-not-a-cleanup) gave every business a list
-- of what it sells. Nothing pointed at it: a plan was "a recurring pet waste
-- removal" because ServicesTab said so in a string literal, and a visit was
-- whatever its plan was. This file points plans and visits at a row of
-- public.services. See docs/other-trades-service-catalog.md, "Migration
-- order", step 2.
--
-- ── WHAT IT ADDS ─────────────────────────────────────────────────────────
--
--   subscriptions.service_id   what the plan sells. Nullable uuid, FK to
--   visits.service_id          services(id), indexed. NOT NULL comes later
--                              (see the end of this header).
--
--   ensure_default_services(org)  the org's default service -- its "Pet waste
--                              removal" -- created if it is missing. Found
--                              by lower(name) first, then by any pet-waste
--                              service the business renamed it to, and only
--                              then inserted, so a business that called it
--                              "Scooping" is not handed a second one.
--
--   a trigger on organizations INSERT that calls it, so a business created
--   after P1's seed has a default service from its first second.
--
--   triggers on subscriptions and visits that
--     * fill an unset service_id: a plan gets the org's default; a visit gets
--       its PLAN's service, else the org's default. This is the "copy the
--       plan's service onto each visit" step, and it is a trigger rather than
--       an edit to generate_visits_core because visits are inserted by at
--       least five SQL paths (generate_visits_core's three INSERTs, the
--       seasonal deep-clean generator, the demo seeder) and the app's one-off
--       booking goes through a plan. One rule on the table covers all of them
--       and every one written later; an edit to one function covers one.
--     * refuse a service that belongs to another business (on any write that
--       sets service_id or organization_id), with foreign_key_violation;
--     * refuse a tech changing a visit's service (same posture as
--       visits_guard_privileged_columns: a JWT without can_write_org).
--
--   when a plan's service changes, the plan's visits that have not happened
--   yet (status 'scheduled', on or after the business's today) follow it.
--   Visits that happened keep the service they were done as: editing a plan
--   does not rewrite history, which is the rule the visit checklist follows.
--
-- ── WHY A TRIGGER ON organizations AND NOT A CALL FROM ONBOARDING ─────────
--
-- Organizations are created by bootstrap_organization, the platform's signup
-- approval, franchise children, the demo seeder, service-role scripts and
-- every SQL proof's fixture. A SECURITY DEFINER function called "from
-- onboarding" covers the paths that remember to call it, and the failure for
-- one that forgets is quiet: a plan with no service, found weeks later. A
-- trigger is one rule on the one table every path writes. (The plan and visit
-- triggers call the same function lazily too, so even an organization that
-- predates the trigger heals the first time it is given a plan.)
--
-- ── THE BACKFILL ─────────────────────────────────────────────────────────
--
-- Every existing plan points at its org's "Pet waste removal" (by
-- lower(name), through ensure_default_services, which also covers a business
-- created between P1's seed and this file). Every existing visit points at
-- its plan's service, else the org's default. Today every plan on the
-- platform IS pet waste removal, so this changes no meaning; it writes it
-- down. Both UPDATEs touch only rows whose service_id is NULL, so running the
-- file twice changes nothing.
--
-- The visit backfill bumps visits.updated_at once (trg_visits_touch). No other
-- trigger reacts to it: the webhook and live-location triggers fire on status
-- only, and the privilege guard returns at once with no JWT.
--
-- ── WHAT A LATER MIGRATION NEEDS BEFORE NOT NULL ─────────────────────────
--
-- 1. A release with this file live, so the app and every SQL path have been
--    writing through these triggers in production for a while.
-- 2. Proof, in that file, that nothing is null: `SELECT count(*) ... WHERE
--    service_id IS NULL` raising if non-zero. That is a property the file can
--    establish from any state, by re-running this backfill first.
-- 3. ALTER ... SET NOT NULL on both columns (or, cheaper on a big visits table,
--    a CHECK (service_id IS NOT NULL) NOT VALID, VALIDATE CONSTRAINT, then
--    SET NOT NULL, which uses the validated check instead of a scan).
-- 4. The UPDATE triggers here allow setting service_id back to NULL; after
--    NOT NULL the column refuses it, which is the point.
-- Before P5/P6 opens the other lines for booking, the paths that create plans
-- without saying which service (CSV import, the public signup, the demo
-- seeder) must pass one; until then they get the org's default, which is
-- what they sell today.

-- ── 1. The columns ───────────────────────────────────────────────────────

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS service_id uuid REFERENCES public.services(id);
ALTER TABLE public.visits
  ADD COLUMN IF NOT EXISTS service_id uuid REFERENCES public.services(id);

COMMENT ON COLUMN public.subscriptions.service_id IS
  'What this plan sells (public.services). Unset on insert means the org''s default service (ensure_default_services). Must be the same organization''s. Migration 20261009230000; NOT NULL in a later file.';
COMMENT ON COLUMN public.visits.service_id IS
  'What this visit is (public.services). Copied from the plan when the visit is inserted; follows a plan change only while the visit is still scheduled and not in the past. Must be the same organization''s. Migration 20261009230000.';

-- Both are read by the visit list and filtered by service in reports; the FK
-- side also needs one so a services row can be checked without a scan.
CREATE INDEX IF NOT EXISTS subscriptions_service_id_idx ON public.subscriptions (service_id);
CREATE INDEX IF NOT EXISTS visits_service_id_idx ON public.visits (service_id);

-- ── 2. The org's default service ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ensure_default_services(_org_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _id uuid;
BEGIN
  IF _org_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT s.id INTO _id
    FROM public.services s
   WHERE s.organization_id = _org_id AND lower(s.name) = 'pet waste removal';
  IF _id IS NOT NULL THEN
    RETURN _id;
  END IF;

  -- Renamed ("Scooping", "Yard cleanup"): still the business's pet-waste
  -- service, and handing it a second one would put two on its Services page.
  SELECT s.id INTO _id
    FROM public.services s
   WHERE s.organization_id = _org_id AND s.service_line = 'pet_waste'
   ORDER BY s.active DESC, s.created_at, s.id
   LIMIT 1;
  IF _id IS NOT NULL THEN
    RETURN _id;
  END IF;

  -- P1's seed, for one business: zone-priced, the yard decides the duration,
  -- inactive where the business has said it does not run pet waste.
  INSERT INTO public.services
    (organization_id, name, service_line, price_unit, base_price_cents, default_duration_min, active)
  SELECT o.id, 'Pet waste removal', 'pet_waste', 'visit', NULL, NULL,
         'pet_waste' = ANY (o.service_lines)
    FROM public.organizations o
   WHERE o.id = _org_id
  ON CONFLICT (organization_id, lower(name)) DO NOTHING
  RETURNING id INTO _id;

  -- Lost a race with a concurrent insert (or the organization does not exist,
  -- in which case this is NULL and the caller's FK says so).
  IF _id IS NULL THEN
    SELECT s.id INTO _id
      FROM public.services s
     WHERE s.organization_id = _org_id AND lower(s.name) = 'pet waste removal';
  END IF;
  RETURN _id;
END;
$function$;

COMMENT ON FUNCTION public.ensure_default_services(uuid) IS
  'The organization''s default service (its "Pet waste removal", found by name, then by line), created if missing. Internal: called by the organizations, subscriptions and visits triggers. Migration 20261009230000.';

-- Internal. It creates rows in any organization it is handed, so nothing
-- with a JWT may call it directly.
REVOKE ALL ON FUNCTION public.ensure_default_services(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_default_services(uuid) TO service_role;

-- ── 3. The backfill ──────────────────────────────────────────────────────
-- Before the triggers below exist, so the visit backfill is the only writer
-- of the visits it touches. The ALTER TABLEs above hold both tables' locks
-- until this transaction commits, so nothing can insert a NULL in between.

WITH d AS (
  SELECT o.id AS org_id, public.ensure_default_services(o.id) AS service_id
    FROM public.organizations o
)
UPDATE public.subscriptions s
   SET service_id = d.service_id
  FROM d
 WHERE s.service_id IS NULL
   AND s.organization_id = d.org_id;

WITH d AS (
  SELECT o.id AS org_id, public.ensure_default_services(o.id) AS service_id
    FROM public.organizations o
)
UPDATE public.visits v
   SET service_id = COALESCE(
         (SELECT sub.service_id FROM public.subscriptions sub
           WHERE sub.id = v.subscription_id AND sub.organization_id = v.organization_id),
         d.service_id)
  FROM d
 WHERE v.service_id IS NULL
   AND v.organization_id = d.org_id;

-- ── 4. A new business gets its default service ───────────────────────────

CREATE OR REPLACE FUNCTION public.tg_organizations_default_services()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.ensure_default_services(NEW.id);
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_organizations_default_services() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS organizations_default_services ON public.organizations;
CREATE TRIGGER organizations_default_services
  AFTER INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.tg_organizations_default_services();

-- ── 5. A plan's service ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tg_subscriptions_service()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.service_id IS NULL THEN
    NEW.service_id := public.ensure_default_services(NEW.organization_id);
  END IF;

  IF NEW.service_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.services s
        WHERE s.id = NEW.service_id AND s.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'That service belongs to another business.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_subscriptions_service() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS subscriptions_service ON public.subscriptions;
CREATE TRIGGER subscriptions_service
  BEFORE INSERT OR UPDATE OF service_id, organization_id ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.tg_subscriptions_service();

-- The plan's visits that have not happened follow a change of service. The
-- business's today, not the server's: a plan edited at 9 pm in Phoenix must
-- not reach back into a day Phoenix has not finished.
CREATE OR REPLACE FUNCTION public.tg_subscriptions_service_reaches_upcoming_visits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _today date;
BEGIN
  SELECT (now() AT TIME ZONE COALESCE(o.timezone, 'America/Chicago'))::date INTO _today
    FROM public.organizations o WHERE o.id = NEW.organization_id;
  UPDATE public.visits v
     SET service_id = NEW.service_id
   WHERE v.subscription_id = NEW.id
     AND v.status = 'scheduled'
     AND v.scheduled_on >= COALESCE(_today, CURRENT_DATE)
     AND v.service_id IS DISTINCT FROM NEW.service_id;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_subscriptions_service_reaches_upcoming_visits() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS subscriptions_service_reaches_upcoming_visits ON public.subscriptions;
CREATE TRIGGER subscriptions_service_reaches_upcoming_visits
  AFTER UPDATE OF service_id ON public.subscriptions
  FOR EACH ROW
  WHEN (OLD.service_id IS DISTINCT FROM NEW.service_id AND NEW.service_id IS NOT NULL)
  EXECUTE FUNCTION public.tg_subscriptions_service_reaches_upcoming_visits();

-- ── 6. A visit's service ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tg_visits_service()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The plan's service, copied: generate_visits_core, the deep-clean
    -- generator and the demo seeder all insert without naming one.
    IF NEW.service_id IS NULL AND NEW.subscription_id IS NOT NULL THEN
      NEW.service_id := (SELECT s.service_id FROM public.subscriptions s
                          WHERE s.id = NEW.subscription_id
                            AND s.organization_id = NEW.organization_id);
    END IF;
    IF NEW.service_id IS NULL THEN
      NEW.service_id := public.ensure_default_services(NEW.organization_id);
    END IF;
  ELSIF NEW.service_id IS DISTINCT FROM OLD.service_id
        AND auth.uid() IS NOT NULL
        AND NOT public.can_write_org(auth.uid(), OLD.organization_id) THEN
    -- What the visit IS decides what it is billed as; a tech completes it,
    -- the office decides it. No JWT (service role, cron) passes, as in
    -- visits_guard_privileged_columns.
    RAISE EXCEPTION 'Not authorized to change service_id on a visit.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.service_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.services s
        WHERE s.id = NEW.service_id AND s.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'That service belongs to another business.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_visits_service() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS visits_service ON public.visits;
CREATE TRIGGER visits_service
  BEFORE INSERT OR UPDATE OF service_id, organization_id ON public.visits
  FOR EACH ROW EXECUTE FUNCTION public.tg_visits_service();

-- ── What this file establishes, checked from any starting state ───────────
DO $post$
DECLARE
  _t text;
  _n integer;
BEGIN
  FOREACH _t IN ARRAY ARRAY['subscriptions', 'visits'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = _t
         AND column_name = 'service_id' AND data_type = 'uuid'
    ) THEN
      RAISE EXCEPTION 'public.%.service_id was not added as uuid', _t;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
       WHERE c.conrelid = format('public.%I', _t)::regclass
         AND c.contype = 'f'
         AND c.confrelid = 'public.services'::regclass
         AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                WHERE attrelid = format('public.%I', _t)::regclass
                                  AND attname = 'service_id')]::smallint[]
    ) THEN
      RAISE EXCEPTION 'public.%.service_id does not reference public.services', _t;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
       WHERE i.indexrelid = format('public.%I', _t || '_service_id_idx')::regclass
         AND i.indisvalid
    ) THEN
      RAISE EXCEPTION 'public.%_service_id_idx is missing or invalid', _t;
    END IF;
  END LOOP;

  -- The backfill, as a property: nothing is left unset. Zero rows satisfies it.
  SELECT count(*) INTO _n FROM public.subscriptions WHERE service_id IS NULL;
  IF _n <> 0 THEN
    RAISE EXCEPTION '% plan(s) have no service after the backfill', _n;
  END IF;
  SELECT count(*) INTO _n FROM public.visits WHERE service_id IS NULL;
  IF _n <> 0 THEN
    RAISE EXCEPTION '% visit(s) have no service after the backfill', _n;
  END IF;

  -- And nothing points across a tenancy line.
  SELECT count(*) INTO _n
    FROM public.subscriptions x JOIN public.services s ON s.id = x.service_id
   WHERE s.organization_id <> x.organization_id;
  IF _n <> 0 THEN
    RAISE EXCEPTION '% plan(s) point at another business''s service', _n;
  END IF;
  SELECT count(*) INTO _n
    FROM public.visits x JOIN public.services s ON s.id = x.service_id
   WHERE s.organization_id <> x.organization_id;
  IF _n <> 0 THEN
    RAISE EXCEPTION '% visit(s) point at another business''s service', _n;
  END IF;

  -- Every business has a default service (the backfill's ensure call).
  SELECT count(*) INTO _n
    FROM public.organizations o
   WHERE NOT EXISTS (SELECT 1 FROM public.services s
                      WHERE s.organization_id = o.id AND s.service_line = 'pet_waste');
  IF _n <> 0 THEN
    RAISE EXCEPTION '% organization(s) have no default service', _n;
  END IF;

  -- The triggers are on the tables they belong to.
  FOREACH _t IN ARRAY ARRAY[
    'organizations:organizations_default_services',
    'subscriptions:subscriptions_service',
    'subscriptions:subscriptions_service_reaches_upcoming_visits',
    'visits:visits_service'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgrelid = format('public.%I', split_part(_t, ':', 1))::regclass
         AND tgname = split_part(_t, ':', 2)
         AND tgenabled <> 'D'
    ) THEN
      RAISE EXCEPTION 'trigger % is missing or disabled', _t;
    END IF;
  END LOOP;

  -- The helper creates rows in any business it is handed: nobody with a JWT.
  IF has_function_privilege('anon', 'public.ensure_default_services(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.ensure_default_services(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ensure_default_services is callable through the API';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc
           WHERE oid = 'public.ensure_default_services(uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'ensure_default_services must run as its owner: a tech''s plan insert reaches it';
  END IF;
END
$post$;
