// BUILD-1 — plan entitlements: what a tier is allowed to USE, as distinct from
// what a role is allowed to DO.
//
// Q-6 settled the shape: gate the existing roles by plan rather than invent new
// roles. So this sits alongside permissions.ts, not inside it. A request has to
// clear both — the caller's role must permit the action AND the org's plan must
// include the feature. Two different questions with two different answers when
// they fail: "you don't have access" versus "your plan doesn't include this."
//
// The matrix is not invented here. houndstack.com/pricing already publishes it
// (TIER_FEATURE_GROUPS in the marketing repo), which means it is a commitment
// already made to customers. This file makes the app honor it. Before this,
// nothing did: a $79 Launch org could open Analytics and Franchise Management,
// both of which the site sells at $199 and Enterprise respectively.
//
// Mirrored in SQL by public.has_plan_entitlement() — tests/entitlement-parity
// replays every (tier, entitlement) pair against both, the same guard IMP-3 put
// on permissions.

/** Ordered cheapest to richest. The order is load-bearing: `requiresTier` copy
 *  and the upgrade prompt both read it. */
export const PLAN_TIERS = ["launch", "growth", "scale", "enterprise"] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

export type Entitlement =
  | "advanced_analytics" // cohort retention, client LTV, zone profitability, churn drivers
  | "regional_reporting" // cross-zone and regional performance reporting
  | "custom_permission_sets" // permission sets beyond the standard four roles
  | "expanded_automation" // automation rules beyond standard capacity
  | "franchise_structure" // parent/child orgs, rollup, royalty billing
  | "api_access";

export const ALL_ENTITLEMENTS: Entitlement[] = [
  "advanced_analytics",
  "regional_reporting",
  "custom_permission_sets",
  "expanded_automation",
  "franchise_structure",
  "api_access",
];

/** Straight from the published pricing matrix. Each tier lists everything it
 *  includes, not just its delta, so a reader never has to walk the ladder in
 *  their head to answer "does Scale get X". */
export const PLAN_ENTITLEMENTS: Record<PlanTier, readonly Entitlement[]> = {
  launch: [],
  growth: ["advanced_analytics", "expanded_automation"],
  scale: [
    "advanced_analytics",
    "expanded_automation",
    "regional_reporting",
    "custom_permission_sets",
    "api_access",
  ],
  enterprise: ALL_ENTITLEMENTS,
};

export function hasEntitlement(
  tier: PlanTier | null | undefined,
  entitlement: Entitlement,
): boolean {
  if (!tier) return false;
  return PLAN_ENTITLEMENTS[tier]?.includes(entitlement) ?? false;
}

/** The cheapest tier that includes an entitlement — what the upgrade prompt
 *  needs to name. Null would mean an entitlement no plan grants, which the
 *  parity test rules out. */
export function lowestTierWith(entitlement: Entitlement): PlanTier | null {
  return PLAN_TIERS.find((t) => hasEntitlement(t, entitlement)) ?? null;
}

/**
 * Entitlements that have a real enforcement point in the app today.
 *
 * The other three describe things the site sells but the product has not built
 * — there is no custom-permission-set editor, no separate regional report, and
 * no public API. They stay in the matrix because the matrix has to match what
 * is being sold, but claiming to "gate" a feature that does not exist would be
 * gating nothing while looking like coverage. When one of them ships, it gets
 * its check and moves into this list; the parity test does not let it be
 * forgotten.
 */
export const ENFORCED_ENTITLEMENTS: Entitlement[] = [
  "advanced_analytics",
  "franchise_structure",
];

/** Tier display names, matching the pricing page exactly — an upgrade prompt
 *  that names a tier the customer cannot find on the site is worse than none. */
export const TIER_NAMES: Record<PlanTier, string> = {
  launch: "Launch",
  growth: "Growth",
  scale: "Scale",
  enterprise: "Enterprise",
};

export const ENTITLEMENT_LABELS: Record<Entitlement, string> = {
  advanced_analytics: "Advanced analytics",
  regional_reporting: "Cross-zone and regional reporting",
  custom_permission_sets: "Custom permission sets",
  expanded_automation: "Expanded automation capacity",
  franchise_structure: "Franchise management",
  api_access: "API access",
};

/**
 * Map a platform_plans slug to a tier.
 *
 * The catalog holds seven retired slugs alongside the four live ones. They are
 * mapped explicitly rather than left to a default, and they all map to `launch`
 * — not as a guess but from what those plans themselves advertised: every one
 * of their `features` arrays reads "Unlimited staff, All core CRM features",
 * which is the Launch feature set. `pack` and `kennel` add per-client pricing,
 * a billing model rather than a capability.
 *
 * No organization is on any retired slug (verified live), so this branch has
 * never been exercised on real data. It exists so the function is total.
 *
 * An unrecognized slug, or an org with no plan at all, resolves to `launch`:
 * the floor, never the ceiling. Failing open here would mean a typo in the
 * catalog silently hands out Enterprise.
 */
const SLUG_TO_TIER: Record<string, PlanTier> = {
  launch: "launch",
  growth: "growth",
  scale: "scale",
  enterprise: "enterprise",
  // Retired, all Launch-equivalent per their own catalog copy.
  free: "launch",
  puppy: "launch",
  fetch: "launch",
  scoop: "launch",
  haul: "launch",
  pack: "launch",
  kennel: "launch",
};

export const DEFAULT_TIER: PlanTier = "launch";

export function planTierFromSlug(slug: string | null | undefined): PlanTier {
  if (!slug) return DEFAULT_TIER;
  return SLUG_TO_TIER[slug] ?? DEFAULT_TIER;
}

/** Slugs this module knows about, for the test that checks the live catalog is
 *  fully covered. */
export const KNOWN_PLAN_SLUGS = Object.keys(SLUG_TO_TIER);

/** Thrown when the org's plan does not include the feature. Distinct from an
 *  authorization failure on purpose — the caller is allowed to do this, they
 *  just haven't bought it, and the UI says something completely different. */
export const PLAN_UPGRADE_REQUIRED = "PLAN_UPGRADE_REQUIRED";

export function upgradeMessage(entitlement: Entitlement, currentTier: PlanTier): string {
  const needed = lowestTierWith(entitlement);
  const feature = ENTITLEMENT_LABELS[entitlement];
  if (!needed) return `${PLAN_UPGRADE_REQUIRED}: ${feature} is not available on any plan.`;
  return (
    `${PLAN_UPGRADE_REQUIRED}: ${feature} is included on ${TIER_NAMES[needed]} and above. ` +
    `This organization is on ${TIER_NAMES[currentTier]}.`
  );
}

/** True when an error crossing the server-fn boundary is the upgrade rejection.
 *  Server fns reduce errors to their message, so match on the code string —
 *  same approach as isImpersonationExpiredError. */
export function isPlanUpgradeRequiredError(e: unknown): boolean {
  if (typeof e === "string") return e.includes(PLAN_UPGRADE_REQUIRED);
  const message = (e as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && message.includes(PLAN_UPGRADE_REQUIRED);
}
