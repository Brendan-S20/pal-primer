-- A trial with four or more people could not add a client (#569, F-03).
--
-- The chain, as it ran:
--
--   clients INSERT (a signed-in owner)
--     -> trg_clients_active_count       -> refresh_active_client_count
--     -> UPDATE organizations SET active_client_count
--     -> organizations_assign_tier      -> trg_reassign_billing_tier
--     -> assign_billing_tier_for_org    -> UPDATE organizations SET plan_id
--     -> aa_orgs_protect_platform_columns
--        RAISE 'These account fields can only be changed by the platform.'
--
-- A trial is not paying, so assign_billing_tier_for_org puts it on "the
-- smallest plan whose team-size range holds this many people". With 1-3
-- people that is Launch and nothing changes. The 4th person moves the answer
-- to Growth, and the function writes plan_id. plan_id is a protected column,
-- the person whose insert set this off is `authenticated`, and nothing on the
-- path opens app.allow_protected_org_write. So the client insert failed, and
-- with it every row of an import, an archive and an unarchive (each of those
-- changes active_client_count too). Deactivating someone brought the count
-- back under Launch's cap, which is why that "fixed" it.
--
-- Two faults, two changes:
--
-- 1. assign_billing_tier_for_org is the platform deciding a tier. It is
--    SECURITY DEFINER and revoked from every API role (20261009150000), so
--    the only way to reach it is a trigger. It now opens the escape hatch
--    for its own UPDATE and puts the previous value back afterwards, so the
--    hatch is not left open for the rest of the caller's transaction (the
--    trap 20260730190000 describes). A comped org keeps the plan the
--    platform gave it: is_comped means a person chose it.
--
-- 2. organizations_assign_tier fired on `UPDATE OF active_client_count` only.
--    trg_reassign_billing_tier already checks active_seat_count, but the
--    trigger's column list meant a seat change never reached it. That is why
--    the trial sat on Launch with four people until the next client write
--    tried to move it. The trigger now fires on either count, so the tier
--    follows the team when the team changes.
--
-- A trial's tier moving with its team is what assign_billing_tier_for_org has
-- always meant to do. Nothing here bills anyone: a trial has no subscription,
-- and a paying org's tier still comes from its subscription's plan.
--
-- 3. Import "Try again" (src/lib/imports.functions.ts, retryImport). A row
--    whose commit failed is marked action = 'error' so the page can say why,
--    which loses what it was going to do. import_rows.commit_failed_action
--    keeps it, so a commit that wrote nothing can be put back to its preview
--    and committed again. A row that was an error at preview has it NULL.
--
-- Replays into an empty database: functions are replaced, a trigger is
-- dropped and recreated, one nullable column is added. The reconcile at the
-- end reads organizations and finds none on a fresh build. Idempotent.

CREATE OR REPLACE FUNCTION public.assign_billing_tier_for_org(_org_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _seats integer;
  _status text;
  _comped boolean;
  _plan public.platform_plans;
  _sub_slug text;
  _prev_hatch text;
BEGIN
  SELECT active_seat_count, billing_status::text, is_comped
    INTO _seats, _status, _comped
    FROM public.organizations WHERE id = _org_id;
  IF _seats IS NULL THEN RETURN NULL; END IF;

  -- Paying tenants are governed by their subscription, not seat count. WRITE the
  -- subscribed plan's slug to billing_tier (only if it drifted) so a plan switch
  -- can't leave a stale tier. Never touch plan_id here (avoids re-firing the
  -- plan_id-change trigger below).
  IF _status IN ('active', 'grace', 'past_due') THEN
    SELECT p.slug INTO _sub_slug
      FROM public.platform_plans p
      JOIN public.organizations o ON o.plan_id = p.id
     WHERE o.id = _org_id;
    IF _sub_slug IS NOT NULL THEN
      UPDATE public.organizations
         SET billing_tier = _sub_slug
       WHERE id = _org_id AND billing_tier IS DISTINCT FROM _sub_slug;
    END IF;
    RETURN _sub_slug;
  END IF;

  -- A comped org is on the plan the platform chose for it.
  IF COALESCE(_comped, false) THEN
    SELECT p.slug INTO _sub_slug
      FROM public.platform_plans p
      JOIN public.organizations o ON o.plan_id = p.id
     WHERE o.id = _org_id;
    RETURN _sub_slug;
  END IF;

  -- The smallest plan whose team-size range holds this many people. NULL
  -- max_team_size is unbounded.
  SELECT * INTO _plan
  FROM public.platform_plans
  WHERE is_active = true AND is_enterprise = false AND included_seats IS NOT NULL
    AND (max_team_size IS NULL OR max_team_size >= GREATEST(_seats, 1))
  ORDER BY max_team_size ASC NULLS LAST, included_seats ASC, sort_order ASC
  LIMIT 1;

  IF _plan.id IS NULL THEN
    SELECT * INTO _plan
    FROM public.platform_plans
    WHERE is_active = true AND is_enterprise = false AND included_seats IS NOT NULL
    ORDER BY max_team_size DESC NULLS FIRST, included_seats DESC, sort_order DESC
    LIMIT 1;
  END IF;

  IF _plan.id IS NOT NULL THEN
    -- plan_id is protected. This is the platform's own decision, reached only
    -- from a trigger, so it opens the hatch for this one UPDATE and closes it
    -- again. A nested call (orgs_sync_tier_on_plan fires on the plan_id
    -- change) saves '1' and restores '1', so the outer restore still wins.
    _prev_hatch := current_setting('app.allow_protected_org_write', true);
    PERFORM set_config('app.allow_protected_org_write', '1', true);
    UPDATE public.organizations
       SET billing_tier = _plan.slug,
           plan_id = _plan.id
     WHERE id = _org_id
       AND (billing_tier IS DISTINCT FROM _plan.slug OR plan_id IS DISTINCT FROM _plan.id);
    PERFORM set_config('app.allow_protected_org_write', COALESCE(_prev_hatch, ''), true);
  END IF;
  RETURN _plan.slug;
END;
$function$;

REVOKE ALL ON FUNCTION public.assign_billing_tier_for_org(uuid) FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS organizations_assign_tier ON public.organizations;
CREATE TRIGGER organizations_assign_tier
AFTER INSERT OR UPDATE OF active_client_count, active_seat_count ON public.organizations
FOR EACH ROW EXECUTE FUNCTION public.trg_reassign_billing_tier();

ALTER TABLE public.import_rows
  ADD COLUMN IF NOT EXISTS commit_failed_action public.import_row_action;

COMMENT ON COLUMN public.import_rows.commit_failed_action IS
  'What this row was going to do when its commit failed (create or update). NULL for a row that '
  'was an error at preview. retryImport puts it back so the batch can be committed again.';

-- Orgs already stuck: not paying, not comped, with more people than their
-- plan holds. Re-deciding them now means the billing page says the right
-- plan before the next client is added. On a fresh build there are none.
DO $reconcile$
DECLARE
  _id uuid;
  _n integer := 0;
BEGIN
  FOR _id IN
    SELECT o.id
      FROM public.organizations o
      JOIN public.platform_plans p ON p.id = o.plan_id
     WHERE COALESCE(o.billing_status::text, '') NOT IN ('active', 'grace', 'past_due')
       AND NOT COALESCE(o.is_comped, false)
       AND p.max_team_size IS NOT NULL
       AND o.active_seat_count > p.max_team_size
  LOOP
    PERFORM public.assign_billing_tier_for_org(_id);
    _n := _n + 1;
  END LOOP;
  RAISE NOTICE 'assign_billing_tier_for_org: re-decided % org(s) over their plan''s team size', _n;
END
$reconcile$;

-- What this file establishes, checked from any starting state.
DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.oid = 'public.organizations'::regclass
       AND t.tgname = 'organizations_assign_tier'
       AND NOT t.tgisinternal
       AND pg_get_triggerdef(t.oid) LIKE '%active_seat_count%'
  ) THEN
    RAISE EXCEPTION 'organizations_assign_tier does not fire on active_seat_count';
  END IF;
  IF (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid = 'public.assign_billing_tier_for_org(uuid)'::regprocedure)
     NOT LIKE '%allow_protected_org_write%' THEN
    RAISE EXCEPTION 'assign_billing_tier_for_org does not open the protected-write hatch';
  END IF;
  IF has_function_privilege('authenticated', 'public.assign_billing_tier_for_org(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'assign_billing_tier_for_org is callable by authenticated';
  END IF;
END
$check$;
