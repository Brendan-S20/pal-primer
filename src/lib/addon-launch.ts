/**
 * Which add-ons may be bought, decided in code rather than in a database row.
 *
 * ── WHY A CODE FLAG AS WELL AS `platform_addons.status` ───────────────────
 *
 * Until 2026-10-09 the only thing between a tenant and a new AI Receptionist or
 * Managed texting charge was the catalog row's `status`, which a platform admin
 * flips with one click on /platform/addons. White label ($99) was `active` and
 * buyable while nothing it promises (a custom portal domain, client email from
 * the business's own domain) had been built. The owner's decision (spec
 * B-P0-2, B-P0-4, NP-5): refuse NEW purchases of these keys on the server,
 * behind a launch flag that defaults to off.
 *
 * A row can be flipped by accident, from a browser, by anyone with platform
 * access. A constant needs a commit, a review and a deploy, which is the right
 * amount of ceremony for "start charging people for something".
 *
 * ── WHAT IT DOES NOT DO ───────────────────────────────────────────────────
 *
 * It refuses new purchases only. It never touches an existing subscription
 * item: renewals are Stripe's alone, and "Remove from plan" stays reachable for
 * anything an org already has (grandfathered, spec B-P0-1).
 *
 * ── THE TWO $19 OPTIONS ───────────────────────────────────────────────────
 *
 * `white-label-portal` and `white-label-emails` are not "coming soon": they are
 * stopped for good (B-P0-4). The smaller of the two changes the spec offered
 * was to hide them rather than fold them into White label — they were already
 * `disabled` in the catalog — so they are listed here only so that a row flipped
 * back to `active` still cannot sell them. When White label launches it is the
 * one product; these two stay false.
 *
 * Turning one on is this map plus that row's `status`.
 */
export type HeldAddonSlug =
  | "ai-receptionist"
  | "managed-sms"
  | "white-label"
  | "white-label-portal"
  | "white-label-emails";

export const ADDON_LAUNCHED: Readonly<Record<HeldAddonSlug, boolean>> = {
  "ai-receptionist": false,
  "managed-sms": false,
  "white-label": false,
  "white-label-portal": false,
  "white-label-emails": false,
};

export const HELD_ADDON_SLUGS = Object.keys(ADDON_LAUNCHED) as HeldAddonSlug[];

/** The sentence a refused purchase returns. Same words as the catalog's own
 *  coming-soon refusal, so the two paths cannot be told apart from outside. */
export const ADDON_NOT_AVAILABLE = "This add-on isn't available yet.";

/**
 * May a NEW purchase of this add-on be made? False for any held slug whose flag
 * is off. A slug that is not on the list is not held by this file (the catalog
 * row's status still applies).
 */
export function addonPurchasable(slug: string | null | undefined): boolean {
  if (!slug) return true;
  if (!(slug in ADDON_LAUNCHED)) return true;
  return ADDON_LAUNCHED[slug as HeldAddonSlug] === true;
}

/**
 * Priority support is sold on Launch only (NP-3): Growth and Scale already
 * include priority email support, so selling it there charges $99 for nothing.
 * Enterprise is by contract. A plan with no slug (none chosen yet) cannot buy
 * an add-on at all, which `subscribePlatformAddon` already refuses.
 */
export const LAUNCH_ONLY_ADDONS: Record<string, readonly string[]> = {
  "priority-support": ["launch"],
};

export const PRIORITY_SUPPORT_INCLUDED =
  "Priority support is included on your plan. It's sold as an add-on on Launch only.";

/** Null when the plan may buy this add-on, otherwise the reason it may not. */
export function addonPlanRefusal(
  addonSlug: string | null | undefined,
  planSlug: string | null | undefined,
): string | null {
  if (!addonSlug) return null;
  const allowed = LAUNCH_ONLY_ADDONS[addonSlug];
  if (!allowed) return null;
  if (planSlug && allowed.includes(planSlug)) return null;
  return PRIORITY_SUPPORT_INCLUDED;
}
