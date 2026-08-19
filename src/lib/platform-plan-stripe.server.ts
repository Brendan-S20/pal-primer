import type Stripe from "stripe";
import {
  planPriceSpecs,
  type PlanPriceSpec,
  type PlanPricingRow,
} from "@/lib/platform-plan-catalog";

// Mirror one `platform_plans` row into the Stripe account the key in hand
// belongs to: one product, up to four prices, each carrying the `lookup_key`
// the rest of the app resolves it by.
//
// ── WHY THE KEY IS THE POINT, NOT A DECORATION ────────────────────────────
//
// `platform-addons.functions.ts` mints add-on prices with no `lookup_key` at
// all, and stores the id it gets back. That is the situation
// `stripe-price-catalog.server.ts` and `stripe-lookup-keys.ts` were written to
// dig the repo out of: a stored id is a LIVE id, ids are minted per account, and
// a test key asking for a live id finds nothing — which is why signup and
// subscription could not be exercised outside the real account at all. Following
// the add-on precedent VERBATIM here would create a new plan that only works in
// one account and re-open that hole for every plan created from now on.
//
// So plan prices are created WITH their key, and this module resolves by key
// before it creates anything. The key is also what makes a retry safe: if the
// Stripe half succeeded and the database write-back did not, running this again
// finds the prices by name and adopts them instead of minting a second set.
//
// ── WHAT IT REFUSES TO DO ─────────────────────────────────────────────────
//
// It never overwrites a stored id, and it never mints a parallel object beside
// one the row already names. If a plan carries ids this account has never heard
// of, the plan belongs to the OTHER account and the right answer is to say so —
// not to quietly build a second catalog and leave two rows' worth of ids where
// one belongs.

export class PlanMirrorRefusal extends Error {}

export type PlanMirrorOutcome = {
  /** The product every price hangs off, or null when there was nothing to do. */
  productId: string | null;
  /** `platform_plans` column → price id, for every kind this run resolved. */
  priceIdByColumn: Record<string, string>;
  /** Lookup keys minted in this account by this run. */
  created: string[];
  /** Lookup keys this account already had, adopted rather than duplicated. */
  reused: string[];
  /** Kinds not mirrored, each with the reason — never a silent omission. */
  skipped: Array<{ kind: string; reason: string }>;
};

export type MirrorablePlan = PlanPricingRow & {
  id: string;
  description: string | null;
  currency: string;
  included_seats: number | null;
  stripe_product_id: string | null;
  stripe_price_id: string | null;
  stripe_annual_price_id: string | null;
  stripe_seat_price_id: string | null;
  stripe_annual_seat_price_id: string | null;
};

function storedId(plan: MirrorablePlan, column: string): string | null {
  return (plan as unknown as Record<string, string | null>)[column] ?? null;
}

/** Find the plan's product by the identity the live catalog already uses:
 *  `metadata.plan_slug`. Search is eventually consistent (a product created
 *  seconds ago may not be indexed yet), which is why the create below ALSO
 *  carries an idempotency key — each covers the other's blind spot. */
async function findProductBySlug(stripe: Stripe, slug: string): Promise<string | null> {
  try {
    const found = await stripe.products.search({
      query: `metadata['plan_slug']:'${slug}'`,
      limit: 2,
    });
    const active = found.data.find((p) => p.active) ?? found.data[0];
    return active?.id ?? null;
  } catch {
    // Search being unavailable is not a reason to refuse to mirror; the
    // idempotency key still stops a double-click minting two products.
    return null;
  }
}

async function resolveProduct(stripe: Stripe, plan: MirrorablePlan): Promise<string> {
  if (plan.stripe_product_id) {
    try {
      const existing = await stripe.products.retrieve(plan.stripe_product_id);
      if (!existing.deleted) return existing.id;
    } catch (e: unknown) {
      if ((e as { code?: string })?.code !== "resource_missing") throw e;
    }
    // The row names a product this account does not have. That is not a
    // missing product, it is the wrong account — minting a replacement here
    // would leave the row pointing at one account's product while the prices
    // below point at another's.
    throw new PlanMirrorRefusal(
      `${plan.slug} already names the Stripe product ${plan.stripe_product_id}, which does not ` +
        `exist in the account this key belongs to. Point the key at the account that holds it, or ` +
        `clear the stored ids first — this will not create a second product beside it.`,
    );
  }

  const found = await findProductBySlug(stripe, plan.slug);
  if (found) return found;

  const product = await stripe.products.create(
    {
      name: plan.name,
      ...(plan.description ? { description: plan.description } : {}),
      metadata: {
        plan_slug: plan.slug,
        ...(plan.included_seats !== null ? { included_seats: String(plan.included_seats) } : {}),
      },
    },
    { idempotencyKey: `plan-product-${plan.id}` },
  );
  return product.id;
}

/**
 * Adopt the price this account already has under `spec.lookupKey`, but only if
 * it charges what the catalog says it charges.
 *
 * A key that resolves to a price with a different amount is the worst of the
 * available outcomes: resolution succeeds, so nothing errors, and the customer
 * is charged a number the Plans page never showed. `check-stripe-catalog.mjs`
 * calls that same case out as the one where "every assertion above was made
 * about an id the app does not actually charge".
 */
async function adoptIfItAgrees(
  stripe: Stripe,
  priceId: string,
  spec: PlanPriceSpec,
  currency: string,
): Promise<string> {
  const price = await stripe.prices.retrieve(priceId);
  const problems: string[] = [];
  if (price.unit_amount !== spec.unitAmountCents) {
    problems.push(
      `charges ${price.unit_amount} and the catalog says ${spec.unitAmountCents}`,
    );
  }
  if (price.recurring?.interval !== spec.interval) {
    problems.push(
      `recurs ${price.recurring ? price.recurring.interval + "ly" : "not at all"} and the catalog ` +
        `says ${spec.interval}ly`,
    );
  }
  if (price.currency !== currency) {
    problems.push(`is in ${price.currency} and the catalog says ${currency}`);
  }
  if (problems.length) {
    throw new PlanMirrorRefusal(
      `The price named ${spec.lookupKey} already exists in this Stripe account and ${problems.join("; ")}. ` +
        `Adopting it would charge a number this page never showed. Fix the price in Stripe, or give the ` +
        `plan a different slug.`,
    );
  }
  return price.id;
}

/**
 * Create (or adopt) the Stripe product and prices for one plan.
 *
 * Talks only to Stripe. The caller owns the database and decides what to write
 * back, so a failure here can never be half a database write.
 */
export async function mirrorPlanToStripe(
  stripe: Stripe,
  plan: MirrorablePlan,
): Promise<PlanMirrorOutcome> {
  const out: PlanMirrorOutcome = {
    productId: null,
    priceIdByColumn: {},
    created: [],
    reused: [],
    skipped: [],
  };

  if (plan.is_enterprise) {
    out.skipped.push({
      kind: "all",
      reason: "Enterprise plans are billed by contract and carry no Stripe product or price.",
    });
    return out;
  }

  const specs = planPriceSpecs(plan);
  if (specs.length === 0) {
    out.skipped.push({
      kind: "all",
      reason: "This plan has no chargeable amount, so there is no price to create.",
    });
    return out;
  }

  const { loadPriceCatalog, resolvePriceId } = await import("@/lib/stripe-price-catalog.server");
  const catalog = await loadPriceCatalog(stripe);

  // Refuse BEFORE creating anything if any stored id belongs elsewhere, so a
  // wrong-account run cannot leave half a catalog behind it.
  for (const spec of specs) {
    const stored = storedId(plan, spec.column);
    if (stored && !catalog.ids.has(stored)) {
      throw new PlanMirrorRefusal(
        `${plan.slug} already names the price ${stored} for its ${spec.kind}, and that price is not ` +
          `in the account this key belongs to. This is the live/test split, not a missing price — ` +
          `nothing was created.`,
      );
    }
  }

  out.productId = await resolveProduct(stripe, plan);

  for (const spec of specs) {
    const stored = storedId(plan, spec.column);
    // The stored id was proved to be in this account above, so it stands.
    const resolved = resolvePriceId(catalog, spec.lookupKey, stored);
    if (resolved) {
      out.priceIdByColumn[spec.column] = await adoptIfItAgrees(
        stripe,
        resolved,
        spec,
        plan.currency,
      );
      out.reused.push(spec.lookupKey);
      continue;
    }

    try {
      const price = await stripe.prices.create(
        {
          product: out.productId,
          unit_amount: spec.unitAmountCents,
          currency: plan.currency,
          recurring: { interval: spec.interval },
          // The whole reason this module exists. Without the key the price is
          // reachable only by the id one account minted for it.
          lookup_key: spec.lookupKey,
          nickname: spec.nickname,
          metadata: { plan_slug: plan.slug, kind: spec.kind },
        },
        // The amount is in the key on purpose: an idempotency key replayed with
        // DIFFERENT parameters is an error from Stripe, and "mirror failed, fix
        // the price, mirror again" is exactly that sequence.
        { idempotencyKey: `plan-price-${plan.id}-${spec.kind}-${spec.unitAmountCents}` },
      );
      out.priceIdByColumn[spec.column] = price.id;
      out.created.push(spec.lookupKey);
    } catch (e: unknown) {
      const message = (e as { message?: string })?.message ?? String(e);
      // `loadPriceCatalog` indexes ACTIVE prices only, so a key held by an
      // ARCHIVED price is invisible to the resolution above and shows up here.
      // Taking it with `transfer_lookup_key` is a decision about a price that
      // may still be on live subscriptions, and it is not one to make silently.
      if (/lookup.?key/i.test(message)) {
        throw new PlanMirrorRefusal(
          `Stripe already has a price named ${spec.lookupKey}, most likely an archived one — ` +
            `active prices were checked first. Reusing that name means moving it off the old price, ` +
            `which may still be billing someone, so it needs a person: ${message}`,
        );
      }
      throw e;
    }
  }

  return out;
}
