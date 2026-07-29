// BUILD-1 (server half) — resolve an org's plan tier and enforce entitlements.
//
// Guardrail 10.4: hidden UI and client-side redirects are not authorization.
// The same holds for entitlements — a locked panel a customer can bypass by
// calling the server function directly is a paywall in name only. So the check
// lives here, in the same funnel each feature file already uses for its
// permission check, and the UI's locked state is a courtesy on top of it.
//
// Reads platform_plans.slug through organizations.plan_id. Deliberately NOT
// through billing-state.server.ts: that module answers a richer question
// (required plan vs assigned plan, grace windows, seat math) and pulls Stripe
// shapes with it. What a customer is ENTITLED to is the plan they are assigned,
// full stop — mixing in payment health here would mean a card that fails on
// Tuesday silently deletes features on Wednesday, which is a billing decision,
// not an entitlement one.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  DEFAULT_TIER,
  PLAN_UPGRADE_REQUIRED,
  hasEntitlement,
  planTierFromSlug,
  upgradeMessage,
  type Entitlement,
  type PlanTier,
} from "@/lib/entitlements";

export class PlanUpgradeRequiredError extends Error {
  readonly code = PLAN_UPGRADE_REQUIRED;
  constructor(
    readonly entitlement: Entitlement,
    readonly currentTier: PlanTier,
  ) {
    super(upgradeMessage(entitlement, currentTier));
    this.name = "PlanUpgradeRequiredError";
  }
}

/** The slice of the client this module uses, so the cast around the lagging
 *  generated types stays narrow instead of `any`. */
type PlanLookupClient = {
  from: (table: "organizations") => {
    select: (cols: string) => {
      eq: (
        col: string,
        val: string,
      ) => {
        maybeSingle: () => PromiseLike<{ data: unknown; error: { message: string } | null }>;
      };
    };
  };
};

// One lookup per org per minute rather than per gated call. An org's plan
// changes on a checkout or an admin edit, not on a page view. Mirrors the
// caches in activity.server.ts and impersonation-session.server.ts.
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; tier: PlanTier }>();

/** Test seam, and the hook a plan change can call to stop serving a stale tier
 *  for up to a minute. */
export function __clearPlanTierCache(orgId?: string) {
  if (orgId) cache.delete(orgId);
  else cache.clear();
}

export async function planTierForOrg(orgId: string): Promise<PlanTier> {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.tier;

  let tier: PlanTier = DEFAULT_TIER;
  try {
    const { data, error } = await (supabaseAdmin as unknown as PlanLookupClient)
      .from("organizations")
      .select("plan_id, platform_plans(slug)")
      .eq("id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const slug = (data as { platform_plans?: { slug?: unknown } | null } | null)?.platform_plans
      ?.slug;
    tier = planTierFromSlug(typeof slug === "string" ? slug : null);
  } catch {
    // A lookup failure resolves to the floor, not the ceiling. The failure mode
    // that matters is handing out Enterprise features because a query hiccuped;
    // the opposite is a visible, reportable "upgrade required" on a plan the
    // customer knows they have.
    tier = DEFAULT_TIER;
  }

  if (cache.size >= CACHE_MAX) {
    for (const [k, v] of cache) {
      if (Date.now() - v.at >= CACHE_TTL_MS) cache.delete(k);
    }
    for (const k of cache.keys()) {
      if (cache.size < CACHE_MAX) break;
      cache.delete(k);
    }
  }
  cache.set(orgId, { at: Date.now(), tier });
  return tier;
}

/**
 * Throw unless the org's plan includes the feature.
 *
 * Separate from requirePermission on purpose: "your role can't do this" and
 * "your plan doesn't include this" are different facts with different fixes,
 * and collapsing them into one "Not authorized" would tell a paying owner to go
 * ask their admin for access they already have.
 */
export async function requireEntitlement(
  orgId: string,
  entitlement: Entitlement,
): Promise<PlanTier> {
  const tier = await planTierForOrg(orgId);
  if (!hasEntitlement(tier, entitlement)) {
    throw new PlanUpgradeRequiredError(entitlement, tier);
  }
  return tier;
}
