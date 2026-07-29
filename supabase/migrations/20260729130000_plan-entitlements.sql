-- BUILD-1: plan entitlements in SQL, mirroring src/lib/entitlements.ts.
--
-- What a ROLE may do is has_permission(). What a PLAN includes is this. A
-- request has to clear both, and the two failures mean different things: "you
-- don't have access" versus "your plan doesn't include this."
--
-- The matrix is not invented here. houndstack.com/pricing already publishes it,
-- so it is a commitment already made to customers; these functions make the
-- database able to honor it. Before this nothing did — a $79 Launch org could
-- open Analytics and Franchise Management, sold at $199 and Enterprise.
--
-- The SQL exists for the same reason has_permission() does: server-fn checks
-- guard the app's own paths, and a policy or RPC that needs the same answer
-- must not have to re-derive it. tests/entitlement-parity.test.ts replays every
-- (tier, entitlement) pair against both implementations, so the two cannot
-- drift — the guard IMP-3 put on permissions, applied here from day one rather
-- than after the fact.
--
-- Idempotent.

-- ── Which tier is an organization on ────────────────────────────────────────
--
-- Mirrors SLUG_TO_TIER. The catalog holds seven retired slugs alongside the
-- four live ones; they are enumerated rather than defaulted, and all map to
-- 'launch' — not a guess, but what those plans' own catalog copy advertised
-- ("Unlimited staff, All core CRM features", which is the Launch feature set).
-- No organization is on a retired slug, verified live, so that branch has never
-- run on real data. It is here so the function is total.
--
-- An unknown slug, a null plan_id, or a missing org resolves to 'launch': the
-- floor, never the ceiling. Failing open would let a typo in the catalog hand
-- out Enterprise.
CREATE OR REPLACE FUNCTION public.plan_tier_for_org(_org_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(
    (
      SELECT CASE p.slug
               WHEN 'launch'     THEN 'launch'
               WHEN 'growth'     THEN 'growth'
               WHEN 'scale'      THEN 'scale'
               WHEN 'enterprise' THEN 'enterprise'
               -- Retired, all Launch-equivalent.
               WHEN 'free'   THEN 'launch'
               WHEN 'puppy'  THEN 'launch'
               WHEN 'fetch'  THEN 'launch'
               WHEN 'scoop'  THEN 'launch'
               WHEN 'haul'   THEN 'launch'
               WHEN 'pack'   THEN 'launch'
               WHEN 'kennel' THEN 'launch'
               ELSE 'launch'
             END
      FROM public.organizations o
      JOIN public.platform_plans p ON p.id = o.plan_id
      WHERE o.id = _org_id
    ),
    'launch'
  );
$$;

COMMENT ON FUNCTION public.plan_tier_for_org(uuid) IS
  'The plan tier an organization is on: launch | growth | scale | enterprise. Mirrors planTierFromSlug() in src/lib/entitlements.ts. Resolves to launch (the floor) for an unknown slug, a null plan, or a missing org — never to a richer tier.';

-- ── What that tier includes ─────────────────────────────────────────────────
--
-- One flat (tier, entitlement) pair per included feature, each tier listing
-- everything it gets rather than just its delta over the tier below. Verbose on
-- purpose: a reader answering "does Scale get regional reporting" finds the row
-- instead of walking the ladder, and the parity test parses pairs rather than
-- inheritance rules.
CREATE OR REPLACE FUNCTION public.has_plan_entitlement(_org_id uuid, _entitlement text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM (VALUES
      -- launch includes nothing beyond the core platform.
      ('growth',     'advanced_analytics'),
      ('growth',     'expanded_automation'),
      ('scale',      'advanced_analytics'),
      ('scale',      'expanded_automation'),
      ('scale',      'regional_reporting'),
      ('scale',      'custom_permission_sets'),
      ('scale',      'api_access'),
      ('enterprise', 'advanced_analytics'),
      ('enterprise', 'expanded_automation'),
      ('enterprise', 'regional_reporting'),
      ('enterprise', 'custom_permission_sets'),
      ('enterprise', 'api_access'),
      ('enterprise', 'franchise_structure')
    ) AS m(tier, entitlement)
    WHERE m.tier = public.plan_tier_for_org(_org_id)
      AND m.entitlement = _entitlement
  );
$$;

COMMENT ON FUNCTION public.has_plan_entitlement(uuid, text) IS
  'True when the organization''s plan includes the named entitlement. Mirrors PLAN_ENTITLEMENTS in src/lib/entitlements.ts; tests/entitlement-parity.test.ts replays every pair against both and fails on drift. Update the two together.';

-- Readable by the app's own sessions: a tenant asking "does my plan include X"
-- is asking about themselves, and the answer is already on their pricing page.
-- Both functions are STABLE and read-only.
GRANT EXECUTE ON FUNCTION public.plan_tier_for_org(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_plan_entitlement(uuid, text) TO authenticated, service_role;
