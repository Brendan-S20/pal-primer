-- The owner chooses whether a missing vaccine stops a Start (#729).
--
-- The owner, 2026-11-08, verbatim: "The tenant, or business owner needs to
-- have a way to choose." So: one setting per business, chosen by its OWNER
-- and nobody else, with two values:
--
--   warn   (the default) Start goes ahead; the tech is told which pet is
--          missing which required vaccine. This is what every business has
--          today, so no existing tenant changes behaviour.
--   block  Start is refused, by the database, until the record is current.
--
-- WHERE IT APPLIES is exactly where vaccine rules already apply, and no
-- wider: a mobile-grooming visit, at a business that runs mobile grooming,
-- whose grooming vaccine rule (organizations.vaccine_rule) is not 'off',
-- checked against the business's own required_vaccines list. This file does
-- not add a vaccine requirement to any other line of business, and it does
-- not change vaccine_rule (which governs BOOKING) or anything about
-- medication or handler qualifications. Extending the Start check to other
-- lines is an owner question listed in the PR.
--
-- WHAT "MISSING" MEANS is what the grooming panel already calls a block
-- under vaccine_rule = 'block' (groomVaccineDecision, src/lib/vaccines.ts):
-- a required vaccine with no record that has not been rejected and does not
-- expire before the business's own today. An unverified portal upload is not
-- missing; it warns, as it does at booking.
--
-- NOTHING RETROACTIVE. Only a visit still 'scheduled' is checked; a visit
-- already in progress is never stopped by this. A REPLAYED start (an offline
-- phone syncing, _started_at in the past) that happened before the owner
-- turned 'block' on is honoured, because the tech really did start before
-- the rule existed.
--
-- WHO MAY CHANGE IT: the owner, through set_vaccine_start_rule(), which
-- writes one row to org_vaccine_policy_changes per change (who, from, to,
-- when). A trigger on organizations refuses any other write to the column
-- from a signed-in caller, so a direct PATCH by an office manager through
-- the table's own update policy cannot move it either. The service role
-- (auth.uid() null) and migrations are not signed-in callers and are let
-- through, as they are for every other organizations column.
--
-- Both Start callers enforce it, because both run start_visit_as: My Day's
-- startVisit (start_visit -> start_visit_as) and the lock-screen hook.
-- start_visit_as below is 20261008150000's body, line for line, with the
-- check inserted after the authorization and before the UPDATE.
--
-- Replays into an empty database: two columns, one table, four functions,
-- one trigger. The check block asserts what this file establishes and needs
-- no row.

-- ── the setting ─────────────────────────────────────────────────────────────

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS vaccine_start_rule text NOT NULL DEFAULT 'warn',
  ADD COLUMN IF NOT EXISTS vaccine_start_rule_set_at timestamptz;
ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_vaccine_start_rule_check;
ALTER TABLE public.organizations ADD CONSTRAINT organizations_vaccine_start_rule_check
  CHECK (vaccine_start_rule IN ('warn', 'block'));

COMMENT ON COLUMN public.organizations.vaccine_start_rule IS
  'What a missing required vaccine does at visit Start, on a mobile-grooming visit: warn (default) or block. Owner-only, through set_vaccine_start_rule(); every change is in org_vaccine_policy_changes.';
COMMENT ON COLUMN public.organizations.vaccine_start_rule_set_at IS
  'When vaccine_start_rule last changed. A replayed start from before this moment is not blocked.';

-- ── the audit trail ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.org_vaccine_policy_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  changed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  setting text NOT NULL,
  old_value text,
  new_value text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_vaccine_policy_changes_setting_check CHECK (setting IN ('vaccine_start_rule')),
  CONSTRAINT org_vaccine_policy_changes_value_check CHECK (
    new_value IN ('warn', 'block') AND (old_value IS NULL OR old_value IN ('warn', 'block')))
);

COMMENT ON TABLE public.org_vaccine_policy_changes IS
  'Every change to a business''s vaccine Start policy: who, from, to, when. Written only by set_vaccine_start_rule(); read by the business''s office.';

CREATE INDEX IF NOT EXISTS org_vaccine_policy_changes_org_recent_idx
  ON public.org_vaccine_policy_changes (organization_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS org_vaccine_policy_changes_changed_by_idx
  ON public.org_vaccine_policy_changes (changed_by) WHERE changed_by IS NOT NULL;

ALTER TABLE public.org_vaccine_policy_changes ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.org_vaccine_policy_changes');
REVOKE ALL ON public.org_vaccine_policy_changes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.org_vaccine_policy_changes TO authenticated;
GRANT ALL ON public.org_vaccine_policy_changes TO service_role;

DROP POLICY IF EXISTS "Office reads its vaccine policy changes" ON public.org_vaccine_policy_changes;
CREATE POLICY "Office reads its vaccine policy changes" ON public.org_vaccine_policy_changes
  FOR SELECT TO authenticated
  USING (public.can_write_org((SELECT auth.uid()), organization_id));

-- ── only the owner, only through the function ───────────────────────────────

CREATE OR REPLACE FUNCTION public.organizations_guard_vaccine_start_rule()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF (NEW.vaccine_start_rule IS DISTINCT FROM OLD.vaccine_start_rule
      OR NEW.vaccine_start_rule_set_at IS DISTINCT FROM OLD.vaccine_start_rule_set_at)
     AND auth.uid() IS NOT NULL
     AND COALESCE(current_setting('app.vaccine_start_rule_writer', true), '') <> '1'
  THEN
    RAISE EXCEPTION 'Only the owner can change the vaccine Start rule'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.organizations_guard_vaccine_start_rule() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS organizations_guard_vaccine_start_rule ON public.organizations;
CREATE TRIGGER organizations_guard_vaccine_start_rule
  BEFORE UPDATE OF vaccine_start_rule, vaccine_start_rule_set_at ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.organizations_guard_vaccine_start_rule();

CREATE OR REPLACE FUNCTION public.set_vaccine_start_rule(_org_id uuid, _rule text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _old text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), _org_id, 'owner') THEN
    RAISE EXCEPTION 'Only the owner can change the vaccine Start rule'
      USING ERRCODE = '42501';
  END IF;
  IF _rule IS NULL OR _rule NOT IN ('warn', 'block') THEN
    RAISE EXCEPTION 'The vaccine Start rule is warn or block';
  END IF;

  SELECT vaccine_start_rule INTO _old FROM public.organizations WHERE id = _org_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Business not found'; END IF;
  IF _old = _rule THEN RETURN _rule; END IF;

  PERFORM set_config('app.vaccine_start_rule_writer', '1', true);
  UPDATE public.organizations
     SET vaccine_start_rule = _rule,
         vaccine_start_rule_set_at = now()
   WHERE id = _org_id;
  PERFORM set_config('app.vaccine_start_rule_writer', '', true);

  INSERT INTO public.org_vaccine_policy_changes (organization_id, changed_by, setting, old_value, new_value)
  VALUES (_org_id, auth.uid(), 'vaccine_start_rule', _old, _rule);
  RETURN _rule;
END;
$$;
REVOKE ALL ON FUNCTION public.set_vaccine_start_rule(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_vaccine_start_rule(uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.set_vaccine_start_rule(uuid, text) IS
  'The owner sets the business''s vaccine Start rule (warn | block). Anyone else is refused (42501). Each real change writes one org_vaccine_policy_changes row.';

-- ── which pets on a visit are missing what ──────────────────────────────────

CREATE OR REPLACE FUNCTION public.visit_missing_vaccines_unchecked(_visit_id uuid)
RETURNS TABLE (dog_id uuid, dog_name text, vaccine text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH v AS (
    SELECT vi.id, vi.property_id, vi.groom_dog_ids, o.required_vaccines,
           (now() AT TIME ZONE COALESCE(NULLIF(o.timezone, ''), 'UTC'))::date AS today
      FROM public.visits vi
      JOIN public.organizations o ON o.id = vi.organization_id
      JOIN public.services s ON s.id = vi.service_id
     WHERE vi.id = _visit_id
       AND s.service_line = 'mobile_grooming'
       AND 'mobile_grooming' = ANY (o.service_lines)
       AND o.vaccine_rule <> 'off'
  )
  SELECT d.id, d.name, req.vaccine
    FROM v
    JOIN public.dogs d ON d.property_id = v.property_id AND d.active
    CROSS JOIN LATERAL unnest(v.required_vaccines) AS req(vaccine)
   WHERE (COALESCE(cardinality(v.groom_dog_ids), 0) = 0 OR d.id = ANY (v.groom_dog_ids))
     AND NOT EXISTS (
       SELECT 1 FROM public.pet_vaccinations pv
        WHERE pv.dog_id = d.id AND pv.vaccine = req.vaccine
          AND pv.rejected_at IS NULL AND pv.expires_on >= v.today
     )
   ORDER BY d.name, req.vaccine;
$$;
REVOKE ALL ON FUNCTION public.visit_missing_vaccines_unchecked(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.visit_missing_vaccines_unchecked(uuid) TO service_role;

-- The same answer for a signed-in caller who may see the visit: its tech, or
-- the office of the business it belongs to. Anyone else gets an error, never
-- another business's pet names.
CREATE OR REPLACE FUNCTION public.visit_missing_vaccines(_visit_id uuid)
RETURNS TABLE (dog_id uuid, dog_name text, vaccine text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE _org uuid;
BEGIN
  SELECT organization_id INTO _org FROM public.visits WHERE id = _visit_id;
  IF auth.uid() IS NULL OR _org IS NULL OR NOT (
    public.is_visit_tech(auth.uid(), _visit_id) OR public.can_write_org(auth.uid(), _org)
  ) THEN
    RAISE EXCEPTION 'Not authorized for this visit' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT * FROM public.visit_missing_vaccines_unchecked(_visit_id);
END;
$$;
REVOKE ALL ON FUNCTION public.visit_missing_vaccines(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.visit_missing_vaccines(uuid) TO authenticated, service_role;

-- ── the Start ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.start_visit_as(
  _actor uuid,
  _visit_id uuid,
  _started_at timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _when timestamptz := now();
  _status text;
  _rule text;
  _rule_set_at timestamptz;
  _missing text;
BEGIN
  IF _actor IS NULL OR NOT public.is_visit_tech(_actor, _visit_id) THEN
    RAISE EXCEPTION 'Not authorized for this visit';
  END IF;

  -- Same bounds as the completion. A start time matters because completed_at
  -- is validated against it — a replayed start stamped with the sync time
  -- makes a legitimately earlier completion look impossible.
  IF _started_at IS NOT NULL
     AND _started_at <= now()
     AND _started_at >= now() - interval '7 days'
  THEN
    _when := _started_at;
  END IF;

  -- The owner's vaccine Start rule (#729). Only a visit not yet started, and
  -- not a replay of a start made before the rule was turned on.
  SELECT v.status::text, o.vaccine_start_rule, o.vaccine_start_rule_set_at
    INTO _status, _rule, _rule_set_at
    FROM public.visits v JOIN public.organizations o ON o.id = v.organization_id
   WHERE v.id = _visit_id;
  IF _status = 'scheduled' AND _rule = 'block'
     AND (_rule_set_at IS NULL OR _when >= _rule_set_at)
  THEN
    SELECT string_agg(m.dog_name || ' (' || m.vaccine || ')', ', ')
      INTO _missing
      FROM public.visit_missing_vaccines_unchecked(_visit_id) m;
    IF _missing IS NOT NULL THEN
      RAISE EXCEPTION 'VACCINE_START_BLOCKED: required vaccine missing or expired: %', _missing
        USING ERRCODE = 'P0001',
              HINT = 'The owner has set a missing vaccine to stop a Start. Update the pet''s vaccine record first.';
    END IF;
  END IF;

  UPDATE public.visits
     SET status='in_progress',
         started_at = COALESCE(started_at, _when),
         updated_at = now()
   WHERE id = _visit_id AND status IN ('scheduled','in_progress');
END;
$function$;

REVOKE ALL ON FUNCTION public.start_visit_as(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_visit_as(uuid, uuid, timestamptz) TO service_role;

COMMENT ON FUNCTION public.start_visit_as(uuid, uuid, timestamptz) IS
  'start_visit with the actor named instead of read from the session. Service role only: the lock-screen hook calls it for the tech its action token names. start_visit is this with auth.uid(). Refuses a scheduled mobile-grooming visit with a missing required vaccine when the owner has set vaccine_start_rule = block (#729).';

-- ── what this file establishes ──────────────────────────────────────────────
DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.organizations'::regclass
      AND conname = 'organizations_vaccine_start_rule_check')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'organizations' AND column_name = 'vaccine_start_rule'
      AND column_default LIKE '''warn''%' AND is_nullable = 'NO') THEN
    RAISE EXCEPTION 'vaccine_start_rule must exist, NOT NULL, default warn, warn|block only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.organizations'::regclass
      AND tgname = 'organizations_guard_vaccine_start_rule' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'the owner-only guard on vaccine_start_rule is missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.org_vaccine_policy_changes'::regclass)
    OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
      AND tablename = 'org_vaccine_policy_changes' AND permissive = 'RESTRICTIVE')
    OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
      AND tablename = 'org_vaccine_policy_changes' AND permissive = 'PERMISSIVE' AND cmd <> 'SELECT')
    OR has_table_privilege('authenticated', 'public.org_vaccine_policy_changes', 'INSERT')
    OR has_table_privilege('authenticated', 'public.org_vaccine_policy_changes', 'UPDATE')
    OR has_table_privilege('authenticated', 'public.org_vaccine_policy_changes', 'DELETE')
    OR has_table_privilege('anon', 'public.org_vaccine_policy_changes', 'SELECT') THEN
    RAISE EXCEPTION 'org_vaccine_policy_changes must be RLS, two-step, read-only to browser keys';
  END IF;
  IF has_function_privilege('anon', 'public.set_vaccine_start_rule(uuid,text)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.visit_missing_vaccines(uuid)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.visit_missing_vaccines_unchecked(uuid)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.start_visit_as(uuid,uuid,timestamptz)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.organizations_guard_vaccine_start_rule()', 'EXECUTE') THEN
    RAISE EXCEPTION 'vaccine Start rule functions grant unexpected access';
  END IF;
  IF position('visit_missing_vaccines_unchecked' IN
      (SELECT prosrc FROM pg_proc WHERE oid = 'public.start_visit_as(uuid,uuid,timestamptz)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'start_visit_as does not ask the vaccine Start rule';
  END IF;
END;
$check$;
