-- QA round 3 phase 9 adversarial-review fixes.
--
-- F1 (billing_tier drift, durable fix): assign_billing_tier_for_org early-
-- returned for paying tenants WITHOUT writing billing_tier, and the only trigger
-- calling it fires on seat-count changes, not plan_id. So a paying tenant that
-- switches plans (plan_id changes via billing.functions.ts) left billing_tier
-- stale vs plan_id — the exact class this phase fixed, reappearing on the next
-- plan switch. Make the RPC WRITE the subscribed tier for paying tenants (only
-- billing_tier, never plan_id, so no recursion), and fire it whenever plan_id
-- changes, so billing_tier tracks plan_id no matter which code path moves it.
--
-- F2 (client/server junk-word divergence + i18n): the all-junk-words check used
-- an 11-token subset (omitting 'n/a'), so 'n/a n/a' was accepted server-side but
-- rejected client-side. Use one token list for both the whole-name and per-word
-- checks. Also switch the letter requirement from ASCII [A-Za-z] to the Unicode
-- [[:alpha:]] so a legitimate non-Latin business/dog name (e.g. CJK/Cyrillic)
-- signs up, while '1'/'01'/'12' (no letters) are still rejected. bootstrap_
-- organization now enforces this at signup, so the i18n gap became reachable.

-- ── F2: is_valid_entity_name (Unicode letters + unified junk list) ────────────
CREATE OR REPLACE FUNCTION public.is_valid_entity_name(_name text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $function$
  -- The junk token list is inlined in both the whole-name and per-word checks;
  -- keep the two ARRAYs identical and in sync with NAME_PLACEHOLDERS in
  -- src/lib/dna-linkage.ts.
  SELECT CASE
    WHEN _name IS NULL THEN false
    WHEN char_length(btrim(_name)) < 2 THEN false
    -- At least one letter in ANY script (rejects '1'/'01'/'12', allows CJK,
    -- Cyrillic, accented Latin, etc.).
    WHEN btrim(_name) !~ '[[:alpha:]]' THEN false
    WHEN lower(btrim(_name)) = ANY (ARRAY[
      'ew','n/a','tbd','test','asdf','qwerty','none','null','xxx','xx',
      'unknown','placeholder','.','-','--','...'
    ]) THEN false
    -- Every alphabetic word is a placeholder junk token (e.g. "Test Test",
    -- "n/a n/a").
    WHEN NOT EXISTS (
      SELECT 1
      FROM regexp_split_to_table(lower(btrim(_name)), '\s+') AS w
      WHERE w ~ '[[:alpha:]]'
        AND w <> ALL (ARRAY[
          'ew','n/a','tbd','test','asdf','qwerty','none','null','xxx','xx',
          'unknown','placeholder','.','-','--','...'
        ])
    ) THEN false
    ELSE true
  END
$function$;

-- ── F1: keep billing_tier synced to the subscribed plan for paying tenants ────
CREATE OR REPLACE FUNCTION public.assign_billing_tier_for_org(_org_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _seats integer;
  _status text;
  _plan public.platform_plans;
  _sub_slug text;
BEGIN
  SELECT active_seat_count, billing_status::text
    INTO _seats, _status
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

  SELECT * INTO _plan
  FROM public.platform_plans
  WHERE is_active = true AND is_enterprise = false AND included_seats IS NOT NULL
    AND included_seats >= GREATEST(_seats, 1)
  ORDER BY included_seats ASC, sort_order ASC
  LIMIT 1;

  IF _plan.id IS NULL THEN
    SELECT * INTO _plan
    FROM public.platform_plans
    WHERE is_active = true AND is_enterprise = false AND included_seats IS NOT NULL
    ORDER BY included_seats DESC, sort_order DESC
    LIMIT 1;
  END IF;

  IF _plan.id IS NOT NULL THEN
    UPDATE public.organizations
       SET billing_tier = _plan.slug,
           plan_id = _plan.id
     WHERE id = _org_id
       AND (billing_tier IS DISTINCT FROM _plan.slug OR plan_id IS DISTINCT FROM _plan.id);
  END IF;
  RETURN _plan.slug;
END;
$function$;

-- Fire the tier sync whenever plan_id moves (the plan-switch paths in
-- billing.functions.ts update plan_id but not billing_tier). The RPC only writes
-- billing_tier for paying tenants, so this cannot recurse on plan_id.
CREATE OR REPLACE FUNCTION public.tg_orgs_sync_tier_on_plan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  PERFORM public.assign_billing_tier_for_org(NEW.id);
  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS orgs_sync_tier_on_plan ON public.organizations;
CREATE TRIGGER orgs_sync_tier_on_plan
  AFTER UPDATE OF plan_id ON public.organizations
  FOR EACH ROW
  WHEN (NEW.plan_id IS DISTINCT FROM OLD.plan_id)
  EXECUTE FUNCTION public.tg_orgs_sync_tier_on_plan();

-- Reconcile once more (idempotent) now that the paying branch writes.
SELECT set_config('app.allow_protected_org_write', '1', true);
UPDATE public.organizations o
   SET billing_tier = p.slug
  FROM public.platform_plans p
 WHERE o.plan_id = p.id
   AND o.plan_id IS NOT NULL
   AND o.billing_status IN ('active','grace','past_due')
   AND o.billing_tier IS DISTINCT FROM p.slug;
