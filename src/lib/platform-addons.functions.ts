import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { makeStripe } from "@/lib/stripe-client.server";
import { addonLookupKey } from "@/lib/stripe-lookup-keys";
import {
  ADDON_NOT_AVAILABLE,
  addonPlanRefusal,
  addonPurchasable,
} from "@/lib/addon-launch";
import {
  isSetupAddon,
  setupIsFreeFor,
  subscriptionInterval,
  type SetupWaivedReason,
} from "@/lib/done-for-you-setup";
import { loadPriceCatalog, resolvePriceId } from "@/lib/stripe-price-catalog.server";

// Platform -> tenant software add-ons (e.g. AI Receptionist): the upsell
// catalog shown on Settings -> Billing. Subscribing attaches a Stripe
// subscription item to the org's existing plan subscription and flips the
// add-on's org feature flag (when it has one); canceling removes both.

async function resolveOrgIdForCaller(supabase: any, userId: string): Promise<string> {
  return (await requirePermission(supabase, userId, "manage_org_billing")).orgId;
}

async function getStripe() {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error("Billing is not configured.");
  return await makeStripe(secret);
}

export type PlatformAddonRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  price_cents: number;
  billing_interval: string;
  /** 'active' = buyable; 'coming_soon' = shown with a badge, not buyable.
   *  ('disabled' add-ons never reach the tenant catalog.) */
  status: "active" | "coming_soon";
  subscribed: boolean;
  /** Set when this plan already includes the add-on, so it is not sold to it
   *  (Priority support on Growth and Scale, NP-3). The sentence to show. */
  includedReason?: string | null;
  /** Set on an owned Done-for-you setup that was free (NP-4): why. */
  waivedReason?: SetupWaivedReason | null;
};

/** What the billing page needs to ask `setupIsFreeFor` itself. The interval is
 *  not here: the page already reads it from the subscription. */
export type SetupFactsForPage = { planSlug: string | null; founding: boolean };

export const listPlatformAddons = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{
    addons: PlatformAddonRow[];
    canSubscribe: boolean;
    setup: SetupFactsForPage;
  }> => {
    const orgId = await resolveOrgIdForCaller(context.supabase, context.userId);

    const [{ data: catalog, error }, { data: mine }, { data: org }] = await Promise.all([
      // Tenants see active + coming-soon add-ons; disabled ones are hidden
      // UNLESS the org is actively subscribed — a subscribed add-on must stay
      // visible so the cancel action remains reachable (and billing
      // explainable).
      context.supabase
        .from("platform_addons")
        .select("id, slug, name, description, price_cents, billing_interval, status, is_active, sort_order")
        .order("sort_order"),
      context.supabase
        .from("org_platform_addons")
        // `*` rather than a column list, so the page still lists before the
        // waived_reason column (20261010154500) has reached a database.
        .select("*")
        .eq("organization_id", orgId)
        .eq("status", "active"),
      context.supabase
        .from("organizations")
        .select("stripe_subscription_id, plan_status, plan_id")
        .eq("id", orgId)
        .single(),
    ]);
    if (error) throw new Error(error.message);
    const planSlug = await planSlugOf(org?.plan_id);
    // For display only: a failed read shows $199, and the purchase itself asks
    // again (and refuses on an error) before anything is charged.
    const founding = await holdsFoundingPlace(orgId).catch(() => false);

    const subscribed = new Set((mine ?? []).map((m: any) => m.addon_id));
    const waivedBy = new Map<string, SetupWaivedReason | null>(
      (mine ?? []).map((m: any) => [m.addon_id, (m.waived_reason ?? null) as SetupWaivedReason | null]),
    );
    return {
      addons: (catalog ?? [])
        // Disabled add-ons are hidden from the catalog EXCEPT when the org is
        // subscribed — those rows stay so the tenant can still cancel.
        .filter((a: any) => a.status !== "disabled" || subscribed.has(a.id))
        .map((a: any) => ({
          id: a.id,
          slug: a.slug,
          name: a.name,
          description: a.description,
          price_cents: a.price_cents,
          billing_interval: a.billing_interval,
          // A held add-on reads as coming soon whatever its row says, so the
          // card shows the disabled button rather than one the server refuses.
          status: (a.status === "coming_soon" || !addonPurchasable(a.slug)
            ? "coming_soon"
            : "active") as "active" | "coming_soon",
          subscribed: subscribed.has(a.id),
          includedReason: planSlug ? addonPlanRefusal(a.slug, planSlug) : null,
          waivedReason: waivedBy.get(a.id) ?? null,
        })),
      canSubscribe: !!org?.stripe_subscription_id && org.plan_status === "active",
      setup: { planSlug, founding },
    };
  });

async function setFeatureFlag(orgId: string, flag: string | null, enabled: boolean) {
  if (!flag) return;
  // Flags are literal column names on organizations (e.g.
  // ai_receptionist_enabled); allowlist them so a bad catalog row can't
  // write arbitrary columns.
  const COLUMN_BY_FLAG: Record<string, string> = {
    ai_receptionist: "ai_receptionist_enabled",
  };
  const column = COLUMN_BY_FLAG[flag];
  if (!column) return;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await (supabaseAdmin as any)
    .from("organizations")
    .update({ [column]: enabled, updated_at: new Date().toISOString() })
    .eq("id", orgId);
}

/** The slug of a plan by id, through the service role; null when none. */
async function planSlugOf(planId: string | null | undefined): Promise<string | null> {
  if (!planId) return null;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await (supabaseAdmin as any)
    .from("platform_plans")
    .select("slug")
    .eq("id", planId)
    .maybeSingle();
  return (data?.slug as string | undefined) ?? null;
}

/** Does the org hold a founding place? A `founding_accounts` row with a NULL
 *  place paid after the places were gone, and is not a founding account.
 *  Read through the service role: the table is readable by platform admins
 *  only. Throws on a failed read, so a purchase never guesses "not founding". */
async function holdsFoundingPlace(orgId: string): Promise<boolean> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await (supabaseAdmin as any)
    .from("founding_accounts")
    .select("place")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) throw new Error(`founding_accounts: ${error.message}`);
  return data?.place != null;
}

const addonIdSchema = z.object({ addonId: z.string().uuid() });

export const subscribePlatformAddon = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => addonIdSchema.parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgIdForCaller(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [{ data: addon }, { data: org }] = await Promise.all([
      (supabaseAdmin as any).from("platform_addons").select("*").eq("id", data.addonId).maybeSingle(),
      (supabaseAdmin as any).from("organizations").select("stripe_subscription_id, plan_status, plan_id").eq("id", orgId).single(),
    ]);
    if (!addon) throw new Error("Add-on not found.");
    // The launch flag comes FIRST, ahead of the catalog row, because the row is
    // one admin click from `active` and the flag is a deploy away (B-P0-2,
    // B-P0-4, NP-5). Nothing below this line may run for a held add-on: no
    // Stripe client is made, no product or price minted, nothing written.
    if (!addonPurchasable(addon.slug)) throw new Error(ADDON_NOT_AVAILABLE);
    // Only 'active' add-ons are purchasable — 'coming_soon' is display-only and
    // 'disabled' is hidden. Server-side gate so a crafted request can't buy them.
    const addonStatus = addon.status ?? (addon.is_active ? "active" : "disabled");
    if (addonStatus === "coming_soon") throw new Error(ADDON_NOT_AVAILABLE);
    if (addonStatus !== "active") throw new Error("Add-on not found.");
    if (!org?.stripe_subscription_id || org.plan_status !== "active") {
      throw new Error("Add-ons attach to an active subscription. Pick a plan first.");
    }
    // Priority support is Launch-only (NP-3): Growth and Scale include it.
    const planSlug = await planSlugOf(org.plan_id);
    const planRefusal = addonPlanRefusal(addon.slug, planSlug);
    if (planRefusal) throw new Error(planRefusal);

    const { data: existing } = await (supabaseAdmin as any)
      .from("org_platform_addons")
      .select("status, canceled_at")
      .eq("organization_id", orgId)
      .eq("addon_id", addon.id)
      .maybeSingle();
    if (existing?.status === "active") return { ok: true, already: true };

    // Done-for-you setup is free on Scale, for founding accounts and on yearly
    // billing (NP-4; the rule is setupIsFreeFor in done-for-you-setup.ts).
    // Decided BEFORE any charge. The two database facts are asked first, so a
    // Scale or founding org never makes a Stripe client; only when neither
    // holds is the subscription read (a read, not a charge) for its interval,
    // and that same client then makes the $199 charge if it is still owed.
    let stripeClient: Awaited<ReturnType<typeof getStripe>> | null = null;
    if (isSetupAddon(addon.slug)) {
      const facts = { planSlug, founding: await holdsFoundingPlace(orgId), planInterval: null };
      let waived = setupIsFreeFor(facts);
      if (!waived) {
        stripeClient = await getStripe();
        const sub = await stripeClient.subscriptions.retrieve(org.stripe_subscription_id, {
          expand: ["items.data.price"],
        });
        waived = setupIsFreeFor({ ...facts, planInterval: subscriptionInterval(sub as any) });
      }
      if (waived) {
        // Recorded exactly as a paid one-time purchase is (an active row with
        // no Stripe item), plus why it was free. Nothing is sent to Stripe.
        const { error: waiveErr } = await (supabaseAdmin as any).from("org_platform_addons").upsert(
          {
            organization_id: orgId,
            addon_id: addon.id,
            stripe_subscription_item_id: null,
            status: "active",
            canceled_at: null,
            waived_reason: waived,
          },
          { onConflict: "organization_id,addon_id" },
        );
        if (waiveErr) throw new Error("Couldn't record the add-on. You have not been charged; try again.");
        console.info(`done-for-you setup added at no charge for org ${orgId} (${waived})`);
        await setFeatureFlag(orgId, addon.feature_flag, true);
        return { ok: true, waived };
      }
    }

    const stripe = stripeClient ?? (await getStripe());
    const oneTime = addon.billing_interval === "one_time";
    // Idempotency generation: retries of THIS attempt dedupe, but a re-add
    // after a removal must NOT replay the original create (Stripe would
    // return the deleted item's id and the org would get the add-on unbilled).
    // The prior row's canceled_at is stable per re-add generation.
    const idemGen = existing?.canceled_at
      ? new Date(existing.canceled_at).getTime()
      : "first";

    // Mint the Stripe product (and, when needed, the stored price) on first
    // ever subscribe of this add-on. Idempotency keys make a two-tab race
    // resolve to the SAME product/price instead of two parallel ones (QA
    // finding: double-billing risk). The product is needed even when a stored
    // price exists — the annual price_data path below attaches to it.
    let priceId: string | null = addon.stripe_price_id;
    let productId: string | null = addon.stripe_product_id;
    if (!productId) {
      const product = await stripe.products.create(
        { name: `${addon.name} (add-on)`, description: addon.description ?? undefined },
        { idempotencyKey: `addon-product-${addon.id}` },
      );
      productId = product.id;
      await (supabaseAdmin as any)
        .from("platform_addons")
        .update({ stripe_product_id: productId, updated_at: new Date().toISOString() })
        .eq("id", addon.id);
    }
    // Ask this account for the add-on's price by name before falling back to
    // the id the database holds, which is always a LIVE id: under a test key
    // `subscriptionItems.create({ price: <live id> })` fails outright with "No
    // such price", so buying an add-on has never been runnable outside the real
    // account. Both accounts carry `addon_<slug>` (see stripe-lookup-keys.ts).
    const catalog = await loadPriceCatalog(stripe);
    const ensureStoredPrice = async (): Promise<string> => {
      const resolved = addon.slug
        ? resolvePriceId(catalog, addonLookupKey(addon.slug), priceId)
        : priceId && catalog.ids.has(priceId)
          ? priceId
          : null;
      if (resolved) return resolved;
      // Nothing in this account answers to the name and the stored id is not
      // here either, so mint one. Note the write-back below only ever fills an
      // EMPTY column — it must not overwrite a live id with a test one. If the
      // row already carries a live product id and this is a test key, the
      // create fails loudly rather than billing anything wrong.
      if (priceId) {
        throw new Error(
          `Add-on ${addon.slug ?? addon.id} has no price in this Stripe account. ` +
            `Add the lookup key ${addon.slug ? addonLookupKey(addon.slug) : "addon_<slug>"} to it.`,
        );
      }
      const price = await stripe.prices.create(
        {
          product: productId!,
          unit_amount: addon.price_cents,
          currency: "usd",
          ...(oneTime
            ? {}
            : { recurring: { interval: addon.billing_interval === "year" ? "year" : "month" } as const }),
        },
        { idempotencyKey: `addon-price-${addon.id}` },
      );
      priceId = price.id;
      await (supabaseAdmin as any)
        .from("platform_addons")
        .update({ stripe_price_id: priceId, updated_at: new Date().toISOString() })
        .eq("id", addon.id);
      return priceId;
    };

    // One-time services (e.g. done-for-you setup) go on the next invoice as
    // an invoice item; recurring ones become a subscription item. Both use an
    // idempotency key so a double-click can't double-charge.
    let itemId: string | null = null;
    // The one-time charge is an INVOICE ITEM, not a subscription item, so it
    // needs its own handle to undo. Without this the id was discarded and
    // `itemId` stayed null, which meant the rollback below was skipped for the
    // single most expensive thing in the catalog — and the customer was told
    // "You have not been charged" while a $499 line sat on their next invoice.
    let invoiceItemId: string | null = null;
    if (oneTime) {
      const { data: orgRow } = await (supabaseAdmin as any)
        .from("organizations").select("stripe_customer_id").eq("id", orgId).single();
      if (!orgRow?.stripe_customer_id) throw new Error("No billing customer on file yet.");
      const invoiceItem = await stripe.invoiceItems.create(
        {
          customer: orgRow.stripe_customer_id,
          pricing: { price: await ensureStoredPrice() },
          subscription: org.stripe_subscription_id,
        },
        { idempotencyKey: `addon-buy-${orgId}-${addon.id}-${idemGen}` },
      );
      invoiceItemId = invoiceItem.id;
    } else {
      // The new item must match the subscription's billing interval — Stripe
      // forbids mixing month and year items on one subscription.
      const sub = await stripe.subscriptions.retrieve(org.stripe_subscription_id, {
        expand: ["items.data.price"],
      });
      const subInterval =
        (sub.items?.data?.[0] as any)?.price?.recurring?.interval === "year" ? "year" : "month";
      const addonInterval = addon.billing_interval === "year" ? "year" : "month";

      let item: import("stripe").Stripe.SubscriptionItem;
      if (subInterval === "year" && addonInterval === "month") {
        // Annual subscription, monthly-priced add-on: bill it annually at
        // exactly 12x the monthly amount via an on-the-fly price. Add-ons
        // carry NO annual discount (only plans get two months free).
        item = await stripe.subscriptionItems.create(
          {
            subscription: org.stripe_subscription_id,
            price_data: {
              currency: "usd",
              product: productId!,
              recurring: { interval: "year" },
              unit_amount: addon.price_cents * 12,
            },
            quantity: 1,
            // Adding to an active sub charges the prorated difference NOW
            // (UX round 7): the invoice is created and auto-charged today.
            proration_behavior: "always_invoice",
          },
          { idempotencyKey: `addon-item-${orgId}-${addon.id}-year-${idemGen}` },
        );
      } else {
        item = await stripe.subscriptionItems.create(
          {
            subscription: org.stripe_subscription_id,
            price: await ensureStoredPrice(),
            quantity: 1,
            // Adding to an active sub charges the prorated difference NOW
            // (UX round 7): the invoice is created and auto-charged today.
            proration_behavior: "always_invoice",
          },
          { idempotencyKey: `addon-item-${orgId}-${addon.id}-${idemGen}` },
        );
      }
      itemId = item.id;
    }

    const { error: recordErr } = await (supabaseAdmin as any).from("org_platform_addons").upsert(
      {
        organization_id: orgId,
        addon_id: addon.id,
        stripe_subscription_item_id: itemId,
        status: "active",
        canceled_at: null,
      },
      { onConflict: "organization_id,addon_id" },
    );
    if (recordErr) {
      // Never bill without a record: undo the Stripe side, then surface it.
      //
      // BOTH shapes have to be undone. This used to handle only `itemId`, the
      // subscription item, so a one-time purchase fell through it entirely —
      // and then told the customer they had not been charged, which was the
      // opposite of true.
      let undone = true;
      if (itemId) {
        try {
          await stripe.subscriptionItems.del(itemId, { proration_behavior: "create_prorations" });
        } catch (e) {
          undone = false;
          console.error("addon record failed AND stripe rollback failed", recordErr.message, e);
        }
      }
      if (invoiceItemId) {
        try {
          // A pending invoice item is deletable right up until the invoice
          // that would carry it is finalized.
          await stripe.invoiceItems.del(invoiceItemId);
        } catch (e) {
          undone = false;
          console.error(
            `addon record failed AND the one-time invoice item ${invoiceItemId} could not be removed — ` +
              `org ${orgId} will be billed for ${addon.slug ?? addon.id} with no record of owning it`,
            recordErr.message,
            e,
          );
        }
      }
      // Only promise what happened. If the undo failed, the charge is real and
      // saying otherwise sends the customer away from a bill they will get.
      throw new Error(
        undone
          ? "Couldn't record the add-on. You have not been charged; try again."
          : "Couldn't record the add-on, and the pending charge could not be cancelled automatically. Contact support before retrying.",
      );
    }
    await setFeatureFlag(orgId, addon.feature_flag, true);
    return { ok: true };
  });

export const cancelPlatformAddon = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => addonIdSchema.parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgIdForCaller(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [{ data: addon }, { data: row }] = await Promise.all([
      (supabaseAdmin as any).from("platform_addons").select("id, feature_flag, billing_interval").eq("id", data.addonId).maybeSingle(),
      (supabaseAdmin as any)
        .from("org_platform_addons")
        .select("stripe_subscription_item_id, status")
        .eq("organization_id", orgId)
        .eq("addon_id", data.addonId)
        .maybeSingle(),
    ]);
    if (!addon || !row || row.status !== "active") throw new Error("Add-on is not active.");
    if (addon.billing_interval === "one_time") {
      throw new Error("One-time services can't be removed once purchased.");
    }

    if (row.stripe_subscription_item_id) {
      const stripe = await getStripe();
      try {
        // Removals keep "create_prorations" deliberately: the unused time is
        // credited on the NEXT invoice rather than refunded immediately
        // (upgrades charge now, downgrades/removals credit later).
        await stripe.subscriptionItems.del(row.stripe_subscription_item_id, {
          proration_behavior: "create_prorations",
        });
      } catch (e: any) {
        if (e?.code !== "resource_missing") throw e;
        // The stored item id is stale (e.g. an interval switch replaced the
        // item and the re-point write failed). The REPLACEMENT item may still
        // be billing: find it on the live subscription by product and delete
        // it, or the org pays forever for an add-on that reads as removed.
        try {
          const { data: addonRow } = await (supabaseAdmin as any)
            .from("platform_addons")
            .select("stripe_product_id")
            .eq("id", data.addonId)
            .maybeSingle();
          const { data: org } = await (supabaseAdmin as any)
            .from("organizations")
            .select("stripe_subscription_id")
            .eq("id", orgId)
            .maybeSingle();
          if (addonRow?.stripe_product_id && org?.stripe_subscription_id) {
            const sub = await stripe.subscriptions.retrieve(org.stripe_subscription_id);
            const live = (sub.items?.data ?? []).find((it: any) => {
              const prod =
                typeof it.price?.product === "string" ? it.price.product : it.price?.product?.id;
              return prod === addonRow.stripe_product_id;
            });
            if (live) {
              await stripe.subscriptionItems.del(live.id, {
                proration_behavior: "create_prorations",
              });
            }
          }
        } catch (healErr) {
          // The subscription itself may be gone (fully canceled org) — then
          // there is nothing billing and cleanup below is correct.
          console.error("stale add-on item self-heal failed", (healErr as Error).message);
        }
      }
    }

    await (supabaseAdmin as any)
      .from("org_platform_addons")
      .update({ status: "canceled", canceled_at: new Date().toISOString() })
      .eq("organization_id", orgId)
      .eq("addon_id", data.addonId);
    await setFeatureFlag(orgId, addon.feature_flag, false);
    return { ok: true };
  });
