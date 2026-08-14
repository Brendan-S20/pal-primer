import type Stripe from "stripe";

// Resolve a price by the name it answers to, in whichever account the key in
// use belongs to.
//
// ── THE PROBLEM ───────────────────────────────────────────────────────────
//
// Every price id in `platform_plans` and `platform_addons` is a LIVE id.
// Stripe mints ids per account, so pointing a test key at those ids finds
// nothing, and there has never been a way to run signup → subscription →
// invoice → webhook without touching the real account. `check-stripe-catalog`
// already refuses that mismatch loudly, which is correct and also why test mode
// simply did not work.
//
// Both accounts now carry the same eighteen `lookup_key`s. Asking by key gets
// the right price in either.
//
// ── ONE LIST CALL, NOT ONE PER PRICE ──────────────────────────────────────
//
// `prices.list({ lookup_keys: [...] })` caps at ten keys, and a plan switch
// needs to classify against the whole catalog — twelve plan prices plus six
// add-ons. So this pulls the account's active prices once and indexes them.
// One request answers every question the checkout path asks, in either mode.
//
// ── WHY THE STORED ID IS STILL A FALLBACK ─────────────────────────────────
//
// A price created after this code shipped, by someone who did not set a lookup
// key, would otherwise become unsellable the moment it was added — a new SKU
// failing checkout with "price not found" rather than simply not being
// resolvable by name. Falling back to the id the database already holds keeps
// today's behaviour as the floor: this can improve resolution, never break it.
//
// The fallback is NOT silent about being wrong. If neither the key nor the
// stored id yields anything, callers throw rather than sending `undefined` to
// Stripe, which would create a subscription missing a line item.

export type PriceCatalog = {
  /** lookup_key → price id, for this account. */
  byLookupKey: Map<string, string>;
  /** Every active price id on the account, for membership tests. */
  ids: Set<string>;
  /** True when the account reported more pages than were read. */
  truncated: boolean;
};

/**
 * Read the account's active prices and index them by lookup key.
 *
 * Paginates rather than trusting one page: the catalog is eighteen prices
 * today, but a checker that silently stops at the first hundred is the kind of
 * cap that reads as "all of them" right up until it isn't. `truncated` records
 * the fact rather than hiding it.
 */
export async function loadPriceCatalog(stripe: Stripe): Promise<PriceCatalog> {
  const byLookupKey = new Map<string, string>();
  const ids = new Set<string>();
  let startingAfter: string | undefined;
  let pages = 0;
  let truncated = false;

  // Ten pages of a hundred is a thousand prices — far past anything this
  // catalog will hold, and a bound so a pagination bug cannot spin forever.
  while (pages < 10) {
    const page: Stripe.ApiList<Stripe.Price> = await stripe.prices.list({
      active: true,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    pages += 1;
    for (const p of page.data) {
      ids.add(p.id);
      if (p.lookup_key) byLookupKey.set(p.lookup_key, p.id);
    }
    if (!page.has_more) break;
    startingAfter = page.data[page.data.length - 1]?.id;
    if (!startingAfter) break;
    if (pages >= 10) truncated = true;
  }

  return { byLookupKey, ids, truncated };
}

/**
 * The price id to send to Stripe: the account's own price for `lookupKey`, or
 * the id the database stored if the account has no such key.
 *
 * Returns null when neither resolves, so the caller can raise an error naming
 * what it wanted. Returning the stored id regardless would hand Stripe an id
 * from the other account, and the failure surfaces at checkout rather than here.
 */
export function resolvePriceId(
  catalog: PriceCatalog,
  lookupKey: string,
  storedId: string | null | undefined,
): string | null {
  const byKey = catalog.byLookupKey.get(lookupKey);
  if (byKey) return byKey;
  // Only trust the stored id if this account actually has it. An id from the
  // other account is worse than nothing: it looks like an answer.
  if (storedId && catalog.ids.has(storedId)) return storedId;
  return null;
}

/**
 * Every id this account knows for a set of lookup keys, plus any stored ids it
 * recognises. Used to classify the line items on an existing subscription —
 * "is this the plan, the seat overage, or a bolt-on add-on" — which has to work
 * in whichever account created that subscription.
 */
export function resolvePriceIdSet(
  catalog: PriceCatalog,
  lookupKeys: readonly string[],
  storedIds: readonly (string | null | undefined)[] = [],
): Set<string> {
  const out = new Set<string>();
  for (const k of lookupKeys) {
    const id = catalog.byLookupKey.get(k);
    if (id) out.add(id);
  }
  // The stored ids stay in the set even when this account does not have them.
  // This is a membership test, not a thing being sent to Stripe: a live id in
  // the set while running against test mode matches nothing and costs nothing,
  // whereas dropping it would misclassify a live subscription created before
  // lookup keys existed.
  for (const id of storedIds) if (id) out.add(id);
  return out;
}
