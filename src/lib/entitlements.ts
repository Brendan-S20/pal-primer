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

/** Ordered cheapest to richest. The order is load-bearing: `lowestTierWith`
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
 * ── WHAT IS AUTHORITATIVE, AND WHAT THIS IS ────────────────────────────────
 *
 * The plan row is authoritative. `platform_plans.entitlement_tier` (added by
 * 20260819160000, NOT NULL, no default) is where a plan SAYS what it unlocks,
 * and `plan_tier_for_org()` in SQL reads that column and nothing else. This map
 * is the TypeScript MIRROR of that column, kept because the server half
 * resolves a tenant's tier from the plan slug rather than from the row:
 * `planTierForOrg` in entitlements.server.ts selects `platform_plans(slug)` and
 * hands the slug here.
 *
 * So the two are only ever in agreement while every plan's slug is in this map
 * with the tier its row declares — which is exactly what
 * `planTierDeclarationProblem` refuses to let a new plan break, and what
 * tests/entitlement-parity.test.ts holds against the migration's backfill.
 *
 * ── WHY THE RETIRED SLUGS ARE HERE ─────────────────────────────────────────
 *
 * The catalog holds seven retired slugs alongside the four live ones. They are
 * mapped explicitly rather than left to a default, and they all map to `launch`
 * — not as a guess but from what those plans themselves advertised: every one
 * of their `features` arrays reads "Unlimited staff, All core CRM features",
 * which is the Launch feature set. `pack` and `kennel` add per-client pricing,
 * a billing model rather than a capability.
 *
 * No organization is on any retired slug (verified live 2026-08-19), so this
 * branch has never been exercised on real data. It exists so the map is total
 * over the catalog.
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

/** The column a plan declares its tier in. Named once so the server function
 *  that writes it, the test that reads the migration, and the prose above
 *  cannot drift into calling it three different things. */
export const PLAN_TIER_COLUMN = "entitlement_tier";

/** The marker every unmapped-slug log line starts with. Exported so a log
 *  search, an alert rule, and the test that pins this behaviour all use the
 *  same string instead of three copies of a sentence. */
export const UNMAPPED_PLAN_SLUG = "[entitlements] UNMAPPED PLAN SLUG";

/** Slugs already complained about, so a busy tenant does not write the same
 *  line a thousand times a minute. Per process, which is the right lifetime:
 *  a deploy that fixes the map clears it. */
const warnedSlugs = new Set<string>();

/** Test seam. Nothing in the app calls it. */
export function __resetUnmappedSlugLog() {
  warnedSlugs.clear();
}

export function isPlanTier(value: unknown): value is PlanTier {
  return typeof value === "string" && (PLAN_TIERS as readonly string[]).includes(value);
}

export function isKnownPlanSlug(slug: string | null | undefined): boolean {
  return !!slug && slug in SLUG_TO_TIER;
}

/**
 * The tier a slug resolves to, for the server's own lookup.
 *
 * ── WHY THIS DOES NOT THROW ────────────────────────────────────────────────
 *
 * An unrecognized slug is a real defect and it is reported as one — loudly, to
 * the logs, once per slug — but it resolves to the floor rather than raising.
 * Three reasons, in order of how much they cost:
 *
 *  1. Throwing here locks a PAYING TENANT OUT OF THE PRODUCT. This is called
 *     from `planTierForOrg`, which sits in `requireEntitlement`, which sits in
 *     the same server-fn funnel as ordinary feature calls. Under-granting means
 *     a customer sees an upgrade prompt for features they bought — visible,
 *     reportable, fixable in an afternoon, and their invoices, routes and
 *     customers are all still there. Raising means their session fails. The
 *     second failure is strictly worse than the first.
 *  2. It would not even work. `planTierForOrg` wraps this call in a try/catch
 *     that falls back to DEFAULT_TIER, so a throw from here is SWALLOWED and
 *     the tenant lands on the floor anyway — with the log line lost. A fix that
 *     changes nothing but the noise is not a fix.
 *  3. The loud place is CREATION, not resolution. `planTierDeclarationProblem`
 *     below refuses to create a plan the app cannot resolve, at the moment a
 *     platform admin is looking at the form. Nothing reaches this fallback
 *     through the product any more; anything that does arrived by a route
 *     nobody designed — a direct INSERT, a restored backup — and that is
 *     precisely the case worth a log line rather than an outage.
 */
export function planTierFromSlug(slug: string | null | undefined): PlanTier {
  if (!slug) return DEFAULT_TIER;
  const tier = SLUG_TO_TIER[slug];
  if (tier) return tier;
  if (!warnedSlugs.has(slug)) {
    warnedSlugs.add(slug);
    console.error(
      `${UNMAPPED_PLAN_SLUG}: "${slug}" has no tier in src/lib/entitlements.ts, so every ` +
        `organization on it is being served the ${TIER_NAMES[DEFAULT_TIER]} feature set ` +
        `regardless of what the plan row declares in platform_plans.${PLAN_TIER_COLUMN}. ` +
        `Someone may be paying for features they are not getting. Add the slug to SLUG_TO_TIER ` +
        `and deploy.`,
    );
  }
  return DEFAULT_TIER;
}

/**
 * Why this plan may not be created with this tier, or null if it may.
 *
 * ONE rule, stated once, called by both the create dialog and
 * `createPlatformPlan`: the tier a plan declares in its row has to be the tier
 * the shipped app resolves for its slug. It fails two ways, and they get
 * different sentences because they have different fixes.
 *
 * The slug half is the awkward one and it is deliberate. The server resolves a
 * tenant's entitlements from the plan SLUG (see the note on SLUG_TO_TIER), so a
 * plan whose slug this build has never heard of would be served the floor no
 * matter what its row says — the exact defect this whole change is about. A
 * platform admin cannot fix that from a form, so the form refuses rather than
 * creating something that silently under-serves whoever buys it.
 */
export function planTierDeclarationProblem(
  slug: string | null | undefined,
  tier: unknown,
): string | null {
  if (!isPlanTier(tier)) {
    return (
      `A plan has to declare what it unlocks. Choose one of: ` +
      `${PLAN_TIERS.map((t) => TIER_NAMES[t]).join(", ")}.`
    );
  }
  if (!slug) {
    return "A plan needs a slug before its tier can be checked against it.";
  }
  const mapped = SLUG_TO_TIER[slug];
  if (!mapped) {
    return (
      `The slug “${slug}” has no entry in SLUG_TO_TIER in src/lib/entitlements.ts. ` +
      `Entitlements are resolved from the plan slug, so every organization on this plan would be ` +
      `served the ${TIER_NAMES[DEFAULT_TIER]} feature set however this plan is priced. Add ` +
      `“${slug}”: "${tier}" there, deploy, then create the plan.`
    );
  }
  if (mapped !== tier) {
    return (
      `“${slug}” is mapped to ${TIER_NAMES[mapped]} in src/lib/entitlements.ts, but this plan ` +
      `declares ${TIER_NAMES[tier]}. The app would serve ${TIER_NAMES[mapped]} and the database ` +
      `would say ${TIER_NAMES[tier]}. Change one of them so they agree.`
    );
  }
  return null;
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
