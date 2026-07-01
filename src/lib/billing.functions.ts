import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Pro plan price — created via Stripe MCP.
export const PRO_PRICE_ID = "price_1ToRCUHJRMTjWv4jF7zBWszG";
export const PRO_PRODUCT_ID = "prod_Uo3JI79ExIL9Ff";
export const PRO_PRICE_CENTS = 4900;

async function getOrgForCaller(supabase: NonNullable<Parameters<typeof requireSupabaseAuth>[0]> extends never ? never : any, userId: string) {
  const { data: role, error } = await supabase
    .from("user_roles")
    .select("organization_id, role")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!role) throw new Error("No organization");
  if (!["owner", "office_manager"].includes(role.role)) {
    throw new Error("Only owners or office managers can manage billing");
  }
  const { data: org, error: oErr } = await supabase
    .from("organizations")
    .select("id, name, stripe_customer_id, stripe_subscription_id, plan_status, current_period_end, active_client_count")
    .eq("id", role.organization_id)
    .single();
  if (oErr) throw new Error(oErr.message);
  return org;
}

export const getBillingStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const org = await getOrgForCaller(context.supabase, context.userId);
    return {
      orgId: org.id,
      planStatus: org.plan_status as "free" | "active" | "past_due" | "canceled",
      currentPeriodEnd: org.current_period_end,
      activeClientCount: org.active_client_count ?? 0,
      freeLimit: 3,
      priceCents: PRO_PRICE_CENTS,
      needsUpgrade: (org.active_client_count ?? 0) >= 3 && org.plan_status === "free",
    };
  });

export const createBillingCheckout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ returnUrl: z.string().url() }).parse(d))
  .handler(async ({ data, context }) => {
    const org = await getOrgForCaller(context.supabase, context.userId);
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) throw new Error("STRIPE_SECRET_KEY not configured");
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(secret);

    // Reuse existing customer if we have one, else let Stripe create one keyed to email.
    const { data: userData } = await context.supabase.auth.getUser();
    const email = userData.user?.email ?? undefined;

    let customerId = org.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        name: org.name,
        metadata: { organization_id: org.id },
      });
      customerId = customer.id;
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin.from("organizations")
        .update({ stripe_customer_id: customerId })
        .eq("id", org.id);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: PRO_PRICE_ID, quantity: 1 }],
      success_url: `${data.returnUrl}?upgraded=1`,
      cancel_url: data.returnUrl,
      client_reference_id: org.id,
      subscription_data: {
        metadata: { organization_id: org.id },
      },
      metadata: { organization_id: org.id, kind: "org_saas" },
    });
    return { url: session.url as string };
  });

export const createBillingPortal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ returnUrl: z.string().url() }).parse(d))
  .handler(async ({ data, context }) => {
    const org = await getOrgForCaller(context.supabase, context.userId);
    if (!org.stripe_customer_id) throw new Error("No Stripe customer yet — subscribe first");
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) throw new Error("STRIPE_SECRET_KEY not configured");
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(secret);
    const portal = await stripe.billingPortal.sessions.create({
      customer: org.stripe_customer_id,
      return_url: data.returnUrl,
    });
    return { url: portal.url };
  });

export const refreshBillingStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const org = await getOrgForCaller(context.supabase, context.userId);
    if (!org.stripe_customer_id) return { planStatus: "free" as const };
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) throw new Error("STRIPE_SECRET_KEY not configured");
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(secret);
    const subs = await stripe.subscriptions.list({ customer: org.stripe_customer_id, status: "all", limit: 5 });
    const active = subs.data.find((s) => ["active", "trialing", "past_due"].includes(s.status));
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (active) {
      const status = active.status === "past_due" ? "past_due" : "active";
      const periodEnd = (active as unknown as { current_period_end?: number }).current_period_end;
      await supabaseAdmin.from("organizations").update({
        stripe_subscription_id: active.id,
        plan_status: status,
        current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
      }).eq("id", org.id);
      return { planStatus: status as "active" | "past_due" };
    }
    await supabaseAdmin.from("organizations").update({
      plan_status: "canceled",
      stripe_subscription_id: null,
    }).eq("id", org.id);
    return { planStatus: "canceled" as const };
  });
