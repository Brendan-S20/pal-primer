/**
 * Who gets Done-for-you setup at no charge (owner, 2026-10-09; spec NP-4).
 *
 * The site says: "Done-for-you setup is $199 one time, and free with yearly
 * billing, on Scale, or for founding accounts." Until 2026-10-10 the app
 * charged $199 to everyone. This is the ONE place the rule is written: the
 * purchase path (`subscribePlatformAddon`) asks it before any charge, and the
 * billing page asks it to decide what the card says.
 *
 * Free when ANY of these holds:
 *   - the plan is Scale;
 *   - the org holds a founding place (a `founding_accounts` row with
 *     `place IS NOT NULL`; a row with a NULL place paid after the places were
 *     gone and is not founding);
 *   - the platform subscription bills yearly.
 *
 * It is no longer free just for switching from another tool.
 *
 * The order is the order of the reason recorded when more than one holds, and
 * it is also the order of cost to find out: the plan and the founding place are
 * rows in our database, the interval is read from the Stripe subscription. The
 * server asks with `planInterval: null` first and reads Stripe only when
 * neither of the first two holds, so a Scale or founding org's setup never
 * makes a Stripe client at all.
 */

/** The catalog slug of Done-for-you setup (`platform_addons.slug`). */
export const SETUP_ADDON_SLUG = "developer-setup";

export type SetupWaivedReason = "scale" | "founding" | "yearly";

export type SetupFacts = {
  /** `platform_plans.slug` of the org's plan, or null when none. */
  planSlug: string | null | undefined;
  /** True when the org holds a founding place (`place IS NOT NULL`). */
  founding: boolean;
  /** The platform subscription's billing interval, or null when unknown. */
  planInterval: "month" | "year" | string | null | undefined;
};

/** Null when setup is charged ($199); otherwise why it is free. */
export function setupIsFreeFor(org: SetupFacts): SetupWaivedReason | null {
  if (org.planSlug === "scale") return "scale";
  if (org.founding) return "founding";
  if (org.planInterval === "year") return "yearly";
  return null;
}

export function isSetupAddon(slug: string | null | undefined): boolean {
  return slug === SETUP_ADDON_SLUG;
}

/** Why it is free, in the site's own words; the billing page shows it under
 *  "Included" where the price would be. */
export const SETUP_FREE_BECAUSE: Readonly<Record<SetupWaivedReason, string>> = {
  scale: "Free on Scale",
  founding: "Free for founding accounts",
  yearly: "Free with yearly billing",
};

/**
 * The interval a Stripe subscription bills on, read from its items. Stripe does
 * not allow month and year items on one subscription, so the first recurring
 * item answers for all of them (the same reading `subscribePlatformAddon` and
 * `listSubscriptionItems` already make).
 */
export function subscriptionInterval(
  sub:
    | { items?: { data?: Array<{ price?: { recurring?: { interval?: string } | null } | null }> } }
    | null
    | undefined,
): "month" | "year" | null {
  const item = (sub?.items?.data ?? []).find((it) => it?.price?.recurring?.interval);
  const interval = item?.price?.recurring?.interval;
  return interval === "year" ? "year" : interval === "month" ? "month" : null;
}
