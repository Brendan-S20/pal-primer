-- A plan could be created without saying what it unlocked.
--
-- ── THE FAULT ───────────────────────────────────────────────────────────────
--
-- `plan_tier_for_org` decided what an organization's plan includes by matching
-- the plan's SLUG against eleven literals written into the function body, with
-- `ELSE 'launch'`. `SLUG_TO_TIER` in src/lib/entitlements.ts held the same
-- eleven literals independently, with the same fallback. Nothing in either
-- place asked the PLAN what it unlocks, because the plan had no way to say.
--
-- That was survivable while the catalog could only be changed by a migration.
-- It stopped being survivable when plan creation shipped: `createPlatformPlan`
-- lets a platform admin mint a plan with any slug, and
-- `assign_billing_tier_for_org` will then MOVE tenants onto it on its own —
-- it picks the cheapest active, non-enterprise plan whose `included_seats`
-- covers the org. So a new "Pro" plan at $999/mo would be sold, subscribed to,
-- and billed, and every entitlement check for its customers would answer with
-- the Launch feature set: no error, no warning, no failing test. The customer
-- pays for Analytics and Franchise Management and is told to upgrade.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────
--
-- The plan declares its tier, in a column, and the function reads the column.
-- `entitlement_tier` is NOT NULL with NO DEFAULT on purpose: an INSERT that
-- does not say what the plan unlocks fails at the table rather than quietly
-- resolving to the floor. That is the "impossible to create" half of the fix —
-- the loud half, at the moment somebody is looking at a form, rather than months
-- later in a paying tenant's session.
--
-- This is NOT `is_enterprise`, which already exists and means something else:
-- "priced by contract, no Stripe prices". A plan can be priced by contract and
-- unlock only Growth features, and a self-serve $999 plan can unlock
-- Enterprise ones. Two questions, two columns.
--
-- The backfill enumerates the eleven slugs that exist and maps NOTHING by
-- default. An `ELSE 'launch'` here would have reproduced the exact bug this
-- file is about, one layer down, and made it permanent — a row saying "launch"
-- is indistinguishable from a considered decision. A slug this file does not
-- name is left NULL and the migration STOPS, naming it.
--
-- Verified against the live database on 2026-08-19 before writing: eleven plan
-- rows, slugs free / puppy / launch / fetch / growth / scoop / scale /
-- enterprise / haul / pack / kennel — exactly the set enumerated below — and
-- four organizations, all on launch or enterprise, none of them resolving to
-- the floor by accident. Nobody's entitlements change when this runs.
--
-- Idempotent. Replays into an empty database: every slug it names is seeded by
-- an earlier migration in the same sequence (20260704040832 seeds `free`,
-- 20260704164940 the six dog-themed ones, 20260710140100 the four live ones),
-- so the assertion below is about what THIS SEQUENCE establishes, not about
-- production history.

-- ── the column ──────────────────────────────────────────────────────────────

ALTER TABLE public.platform_plans
  ADD COLUMN IF NOT EXISTS entitlement_tier text;

COMMENT ON COLUMN public.platform_plans.entitlement_tier IS
  'What this plan UNLOCKS: launch | growth | scale | enterprise. The single source of truth for plan_tier_for_org() and has_plan_entitlement(); mirrored in TypeScript by SLUG_TO_TIER in src/lib/entitlements.ts, which tests/entitlement-parity.test.ts holds to this file. NOT NULL with no default: a plan that does not say what it unlocks cannot be created. Distinct from is_enterprise, which is a PRICING shape (by contract, no Stripe prices) and says nothing about features.';

-- ── the backfill ────────────────────────────────────────────────────────────
--
-- The four live plans map to themselves. The seven retired ones map to launch —
-- not a guess and not a default, but what their own catalog copy advertised:
-- every one of their `features` arrays reads "Unlimited staff, All core CRM
-- features", which is the Launch feature set. `pack` and `kennel` add
-- per-active-client pricing, which is a billing model rather than a capability.
--
-- No ELSE. See the header.
UPDATE public.platform_plans
   SET entitlement_tier = CASE slug
         WHEN 'launch'     THEN 'launch'
         WHEN 'growth'     THEN 'growth'
         WHEN 'scale'      THEN 'scale'
         WHEN 'enterprise' THEN 'enterprise'
         -- Retired, all Launch-equivalent per their own catalog copy.
         WHEN 'free'   THEN 'launch'
         WHEN 'puppy'  THEN 'launch'
         WHEN 'fetch'  THEN 'launch'
         WHEN 'scoop'  THEN 'launch'
         WHEN 'haul'   THEN 'launch'
         WHEN 'pack'   THEN 'launch'
         WHEN 'kennel' THEN 'launch'
       END,
       updated_at = now()
 WHERE entitlement_tier IS NULL;

-- Every row carries a tier. An assertion about what THIS migration establishes,
-- provable from any starting state, so it is an EXCEPTION rather than a
-- warning: if a plan exists that this file does not name, the correct outcome
-- is that the deploy stops and a human decides what that plan unlocks. Filling
-- it in with the floor is the bug.
DO $$
DECLARE
  _unmapped text;
BEGIN
  SELECT string_agg(slug, ', ' ORDER BY slug) INTO _unmapped
    FROM public.platform_plans
   WHERE entitlement_tier IS NULL;

  IF _unmapped IS NOT NULL THEN
    RAISE EXCEPTION
      'platform_plans rows with no entitlement_tier: %. Add each slug to the backfill in this migration with the tier it unlocks — do NOT default it to launch, which is the silent under-entitlement this migration exists to remove.',
      _unmapped;
  END IF;
END $$;

-- What the backfill actually did, on whatever database this is. These are
-- numbers MEASURED from the rows in front of us, not properties this migration
-- establishes, so they are warnings that print rather than assertions that
-- stop — and the empty case says out loud that nothing was measured.
DO $$
DECLARE
  _plans integer;
  _breakdown text;
BEGIN
  SELECT count(*) INTO _plans FROM public.platform_plans;
  IF _plans = 0 THEN
    RAISE WARNING 'entitlement_tier backfill: NOT MEASURED — platform_plans is empty on this database, so no plan was classified. This is expected on a fresh build only if the catalog seeds have not run.';
  ELSE
    SELECT string_agg(entitlement_tier || '=' || n, ', ' ORDER BY entitlement_tier)
      INTO _breakdown
      FROM (
        SELECT entitlement_tier, count(*) AS n
          FROM public.platform_plans
         GROUP BY entitlement_tier
      ) s;
    RAISE WARNING 'entitlement_tier backfill: % plan row(s) classified — %', _plans, _breakdown;
  END IF;
END $$;

-- Does anybody's entitlement actually change? The old rule was a slug CASE with
-- ELSE 'launch'; the new one is the column. Comparing them per organization is
-- the only way to know this migration is not a silent re-pricing of live
-- tenants — and on a fresh build there are no organizations to compare, which
-- is a skip, not a pass, and says so.
DO $$
DECLARE
  _orgs integer;
  _changed text;
BEGIN
  SELECT count(*) INTO _orgs FROM public.organizations;
  IF _orgs = 0 THEN
    RAISE WARNING 'entitlement change probe: NOT RUN — no organizations on this database. Nothing was compared; this says nothing about whether live tenants keep their tier.';
    RETURN;
  END IF;

  SELECT string_agg(x.id::text || ': ' || x.was || ' -> ' || x.now_, '; ' ORDER BY x.id)
    INTO _changed
    FROM (
      SELECT o.id,
             CASE p.slug
               WHEN 'launch' THEN 'launch' WHEN 'growth' THEN 'growth'
               WHEN 'scale'  THEN 'scale'  WHEN 'enterprise' THEN 'enterprise'
               ELSE 'launch'
             END AS was,
             coalesce(p.entitlement_tier, 'launch') AS now_
        FROM public.organizations o
        LEFT JOIN public.platform_plans p ON p.id = o.plan_id
    ) x
   WHERE x.was IS DISTINCT FROM x.now_;

  IF _changed IS NULL THEN
    RAISE WARNING 'entitlement change probe: % organization(s) compared, none changes tier.', _orgs;
  ELSE
    RAISE WARNING 'entitlement change probe: % organization(s) compared, these CHANGE tier — %', _orgs, _changed;
  END IF;
END $$;

-- ── the constraint that makes the declaration mandatory ─────────────────────
--
-- NOT NULL and no DEFAULT. `createPlatformPlan` sends the column explicitly; a
-- future INSERT that forgets it fails here, loudly, instead of creating a plan
-- that silently unlocks nothing.
ALTER TABLE public.platform_plans
  ALTER COLUMN entitlement_tier SET NOT NULL;

ALTER TABLE public.platform_plans
  DROP CONSTRAINT IF EXISTS platform_plans_entitlement_tier_valid;
ALTER TABLE public.platform_plans
  ADD CONSTRAINT platform_plans_entitlement_tier_valid
  CHECK (entitlement_tier IN ('launch', 'growth', 'scale', 'enterprise'));

-- ── the function reads the column ───────────────────────────────────────────
--
-- No slug literals left. The only remaining fallback is for an organization
-- with no plan at all (or an org id that does not exist), which is still the
-- floor rather than the ceiling: a missing plan is not a reason to hand out
-- Enterprise. The unknown-slug arm is gone because there is no longer any such
-- thing — a plan row cannot exist without a tier.
CREATE OR REPLACE FUNCTION public.plan_tier_for_org(_org_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(
    (
      SELECT p.entitlement_tier
        FROM public.organizations o
        JOIN public.platform_plans p ON p.id = o.plan_id
       WHERE o.id = _org_id
    ),
    'launch'
  );
$$;

COMMENT ON FUNCTION public.plan_tier_for_org(uuid) IS
  'The plan tier an organization is on: launch | growth | scale | enterprise. Reads platform_plans.entitlement_tier — the plan says what it unlocks; this function does not decide it from the slug. Resolves to launch (the floor) for an organization with no plan or an id that does not exist, never to a richer tier. Mirrored in TypeScript by planTierFromSlug() in src/lib/entitlements.ts.';

-- A fresh CREATE takes a default EXECUTE grant to PUBLIC, and anon is a member
-- of PUBLIC — see 20260809180000, and the two migrations that nearly shipped
-- the royalty engine to anyone holding the publishable key. This restores
-- exactly the grants the live database carries: service_role only. Tenant
-- sessions reach it through SECURITY DEFINER callers
-- (has_plan_entitlement and the franchise RPCs), never directly, which is what
-- 20260731240000 decided when it revoked `authenticated`.
REVOKE ALL ON FUNCTION public.plan_tier_for_org(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plan_tier_for_org(uuid) TO service_role;

-- The function is the thing this migration replaces, so prove the replacement
-- took: no slug literal survived anywhere in its body. Read from `prosrc` and
-- for one NAMED function — `pg_get_functiondef` over a set raises on any
-- pg_proc row that is not a plain function, and a `prokind` filter is not a fix
-- because Postgres does not promise to evaluate AND terms left to right.
DO $$
DECLARE
  _src text;
BEGIN
  SELECT p.prosrc INTO _src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'plan_tier_for_org';

  IF _src IS NULL THEN
    RAISE EXCEPTION 'public.plan_tier_for_org does not exist after this migration replaced it.';
  END IF;

  IF _src !~ 'entitlement_tier' THEN
    RAISE EXCEPTION 'public.plan_tier_for_org does not read platform_plans.entitlement_tier — the plan still is not being asked what it unlocks.';
  END IF;

  IF _src ~* 'p\.slug' OR _src ~* 'WHEN\s+''(launch|growth|scale|enterprise)''' THEN
    RAISE EXCEPTION 'public.plan_tier_for_org still decides the tier from the plan slug. The slug map has moved onto the row; the function must read entitlement_tier and nothing else.';
  END IF;
END $$;
