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
  subscribed: boolean;
};

export const listPlatformAddons = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ addons: PlatformAddonRow[]; canSubscribe: boolean }> => {
    const orgId = await resolveOrgIdForCaller(context.supabase, context.userId);

    const [{ data: catalog, error }, { data: mine }, { data: org }] = await Promise.all([
      context.supabase
        .from("platform_addons")
        .select("id, slug, name, description, price_cents, billing_interval, is_active, sort_order")
        .eq("is_active", true)
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
      addons: (catalog ?? []).map((a: any) => ({
        id: a.id,
        slug: a.slug,
        name: a.name,
        description: a.description,
        price_cents: a.price_cents,
        billing_interval: a.billing_interval,
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
      (supabaseAdmin as any).from("platform_addons").select("*").eq("id", data.addonId).eq("is_active", true).maybeSingle(),
      (supabaseAdmin as any).from("organizations").select("stripe_subscription_id, plan_status").eq("id", orgId).single(),
    ]);
    if (!addon) throw new Error("Add-on not found.");
    if (!org?.stripe_subscription_id || org.plan_status !== "active") {
      throw new Error("Add-ons attach to an active subscription. Pick a plan first.");
    }

    const { data: existing } = await (supabaseAdmin as any)
      .from("org_platform_addons")
      .select("status")
      .eq("organization_id", orgId)
      .eq("addon_id", addon.id)
      .maybeSingle();
    if (existing?.status === "active") return { ok: true, already: true };

    const stripe = await getStripe();

    // Mint the Stripe product/price on first ever subscribe of this add-on.
    let priceId: string | null = addon.stripe_price_id;
    if (!priceId) {
      const product = addon.stripe_product_id
        ? { id: addon.stripe_product_id }
        : await stripe.products.create({
            name: `${addon.name} (add-on)`,
            description: addon.description ?? undefined,
          });
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: addon.price_cents,
        currency: "usd",
        recurring: { interval: addon.billing_interval === "year" ? "year" : "month" },
      });
      priceId = price.id;
      await (supabaseAdmin as any)
        .from("platform_addons")
        .update({ stripe_product_id: product.id, stripe_price_id: priceId, updated_at: new Date().toISOString() })
        .eq("id", addon.id);
    }

    const item = await stripe.subscriptionItems.create({
      subscription: org.stripe_subscription_id,
      price: priceId!,
      quantity: 1,
      // Charge the prorated amount on the next invoice rather than issuing a
      // standalone invoice the moment they click.
      proration_behavior: "create_prorations",
    });

    await (supabaseAdmin as any).from("org_platform_addons").upsert(
      {
        organization_id: orgId,
        addon_id: addon.id,
        stripe_subscription_item_id: item.id,
        status: "active",
        canceled_at: null,
      },
      { onConflict: "organization_id,addon_id" },
    );
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
      (supabaseAdmin as any).from("platform_addons").select("id, feature_flag").eq("id", data.addonId).maybeSingle(),
      (supabaseAdmin as any)
        .from("org_platform_addons")
        .select("stripe_subscription_item_id, status")
        .eq("organization_id", orgId)
        .eq("addon_id", data.addonId)
        .maybeSingle(),
    ]);
    if (!addon || !row || row.status !== "active") throw new Error("Add-on is not active.");

    if (row.stripe_subscription_item_id) {
      const stripe = await getStripe();
      try {
        await stripe.subscriptionItems.del(row.stripe_subscription_item_id, {
          proration_behavior: "create_prorations",
        });
      } catch (e: any) {
        // Already gone on Stripe's side (e.g. the whole subscription was
        // canceled): still clean up our record.
        if (e?.code !== "resource_missing") throw e;
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
