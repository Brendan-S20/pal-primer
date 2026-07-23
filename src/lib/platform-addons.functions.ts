import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";

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
  const Stripe = (await import("stripe")).default;
  return new Stripe(secret);
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
};

export const listPlatformAddons = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ addons: PlatformAddonRow[]; canSubscribe: boolean }> => {
    const orgId = await resolveOrgIdForCaller(context.supabase, context.userId);

    const [{ data: catalog, error }, { data: mine }, { data: org }] = await Promise.all([
      // Untyped: `status` postdates the generated Supabase types. Tenants see
      // active + coming-soon add-ons; disabled ones are hidden UNLESS the org
      // is actively subscribed — a subscribed add-on must stay visible so the
      // cancel action remains reachable (and billing explainable).
      (context.supabase as any)
        .from("platform_addons")
        .select("id, slug, name, description, price_cents, billing_interval, status, is_active, sort_order")
        .order("sort_order"),
      context.supabase
        .from("org_platform_addons")
        .select("addon_id, status")
        .eq("organization_id", orgId)
        .eq("status", "active"),
      context.supabase
        .from("organizations")
        .select("stripe_subscription_id, plan_status")
        .eq("id", orgId)
        .single(),
    ]);
    if (error) throw new Error(error.message);

    const subscribed = new Set((mine ?? []).map((m: any) => m.addon_id));
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
          status: (a.status === "coming_soon" ? "coming_soon" : "active") as "active" | "coming_soon",
          subscribed: subscribed.has(a.id),
        })),
      canSubscribe: !!org?.stripe_subscription_id && org.plan_status === "active",
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

const addonIdSchema = z.object({ addonId: z.string().uuid() });

export const subscribePlatformAddon = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => addonIdSchema.parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgIdForCaller(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [{ data: addon }, { data: org }] = await Promise.all([
      (supabaseAdmin as any).from("platform_addons").select("*").eq("id", data.addonId).maybeSingle(),
      (supabaseAdmin as any).from("organizations").select("stripe_subscription_id, plan_status").eq("id", orgId).single(),
    ]);
    if (!addon) throw new Error("Add-on not found.");
    // Only 'active' add-ons are purchasable — 'coming_soon' is display-only and
    // 'disabled' is hidden. Server-side gate so a crafted request can't buy them.
    const addonStatus = addon.status ?? (addon.is_active ? "active" : "disabled");
    if (addonStatus === "coming_soon") throw new Error("This add-on isn't available yet.");
    if (addonStatus !== "active") throw new Error("Add-on not found.");
    if (!org?.stripe_subscription_id || org.plan_status !== "active") {
      throw new Error("Add-ons attach to an active subscription. Pick a plan first.");
    }

    const { data: existing } = await (supabaseAdmin as any)
      .from("org_platform_addons")
      .select("status, canceled_at")
      .eq("organization_id", orgId)
      .eq("addon_id", addon.id)
      .maybeSingle();
    if (existing?.status === "active") return { ok: true, already: true };

    const stripe = await getStripe();
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
    const ensureStoredPrice = async (): Promise<string> => {
      if (priceId) return priceId;
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
    if (oneTime) {
      const { data: orgRow } = await (supabaseAdmin as any)
        .from("organizations").select("stripe_customer_id").eq("id", orgId).single();
      if (!orgRow?.stripe_customer_id) throw new Error("No billing customer on file yet.");
      await stripe.invoiceItems.create(
        {
          customer: orgRow.stripe_customer_id,
          pricing: { price: await ensureStoredPrice() },
          subscription: org.stripe_subscription_id,
        },
        { idempotencyKey: `addon-buy-${orgId}-${addon.id}-${idemGen}` },
      );
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
      if (itemId) {
        try {
          await stripe.subscriptionItems.del(itemId, { proration_behavior: "create_prorations" });
        } catch (e) {
          console.error("addon record failed AND stripe rollback failed", recordErr.message, e);
        }
      }
      throw new Error("Couldn't record the add-on. You have not been charged; try again.");
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
