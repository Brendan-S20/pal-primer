-- A one-person scooping business runs its own route (D13, onboarding audit
-- 2026-11-09).
--
-- 20261108170100 taught fill_visit_walker that a dog walk in a business
-- whose ONLY active person runs routes is that person's walk, and left the
-- same question for a cleanup open ("an owner question"). The onboarding
-- audit answered it: an owner-operator saved their first weekly scooping
-- plan and every visit read "Unassigned", with nobody else in the business
-- it could ever go to.
--
-- The new-client form now puts that owner on routes and gives them the
-- plan's visits (src/lib/solo-owner-route.server.ts). This is the half the
-- browser cannot reach: the nightly generator keeps making visits for that
-- plan past the first 60 days, and every one of them arrived unassigned.
--
-- ── WHAT CHANGES ─────────────────────────────────────────────────────────
--
-- Rule 2 (the one person) now covers a pet-waste visit as well as a dog
-- walk: a visit whose service line is 'pet_waste', or whose plan names no
-- service at all (a scooping plan priced from its zone has none). Every
-- other condition is as before, restated unchanged: exactly one active
-- person, who runs routes and is not off that day; a plan's walker still
-- wins; a stay is still the stay's; it still never overwrites and never
-- fails an insert.
--
-- Still NOT covered: grooming, training and sitting. A groom has overlap
-- rules (two-grooms-cannot-share-a-groomer) that RAISE on a clash, and this
-- trigger must never be a reason an insert fails.
--
-- Replays into an empty database: the function and trigger exist by this
-- point (20261108170100), nothing reads or writes rows, and the check below
-- reads the catalog.

CREATE OR REPLACE FUNCTION public.fill_visit_walker()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _plan_walker uuid;
  _stay uuid;
  _line text;
  _only uuid;
  _people integer;
BEGIN
  IF NEW.assigned_staff_id IS NOT NULL OR NEW.subscription_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT s.assigned_staff_id, s.stay_id INTO _plan_walker, _stay
    FROM public.subscriptions s
   WHERE s.id = NEW.subscription_id AND s.organization_id = NEW.organization_id;
  IF NOT FOUND OR _stay IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- 1. The plan's walker.
  IF _plan_walker IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.staff st
       WHERE st.id = _plan_walker AND st.organization_id = NEW.organization_id
         AND COALESCE(st.active, true) AND COALESCE(st.is_field_tech, false)
    ) AND NOT public.is_staff_off(_plan_walker, NEW.scheduled_on) THEN
      NEW.assigned_staff_id := _plan_walker;
    END IF;
    RETURN NEW;
  END IF;

  -- 2. A dog walk or a cleanup in a one-person business.
  SELECT sv.service_line INTO _line
    FROM public.services sv
   WHERE sv.id = COALESCE(NEW.service_id,
                          (SELECT s.service_id FROM public.subscriptions s WHERE s.id = NEW.subscription_id));
  IF _line IS NOT NULL AND _line NOT IN ('dog_walking', 'pet_waste') THEN
    RETURN NEW;
  END IF;
  SELECT count(*)::integer, (array_agg(st.id))[1] INTO _people, _only
    FROM public.staff st
   WHERE st.organization_id = NEW.organization_id AND COALESCE(st.active, true);
  IF _people = 1 AND EXISTS (
       SELECT 1 FROM public.staff st WHERE st.id = _only AND COALESCE(st.is_field_tech, false)
     ) AND NOT public.is_staff_off(_only, NEW.scheduled_on) THEN
    NEW.assigned_staff_id := _only;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.fill_visit_walker() FROM PUBLIC, anon, authenticated;

-- ── What this file establishes ───────────────────────────────────────────
DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.visits'::regclass AND t.tgname = 'visits_plan_walker'
       AND NOT t.tgisinternal
       AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 AND (t.tgtype & 16) = 0
  ) THEN
    RAISE EXCEPTION 'visits_plan_walker must still be BEFORE INSERT only.';
  END IF;
  IF has_function_privilege('anon', 'public.fill_visit_walker()', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.fill_visit_walker()', 'EXECUTE') THEN
    RAISE EXCEPTION 'fill_visit_walker is callable by a client role.';
  END IF;
  IF position('pet_waste' IN (SELECT p.prosrc FROM pg_proc p
                               WHERE p.oid = 'public.fill_visit_walker()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'fill_visit_walker does not cover a one-person pet-waste business.';
  END IF;
END
$check$;
