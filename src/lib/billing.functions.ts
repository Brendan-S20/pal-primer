import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getOrgBillingState } from "./billing-state.server";
import { requirePermission } from "@/lib/authz.server";

// Kept for back-compat with anything still importing this.
export const PRO_PRICE_CENTS = 5900;

// The org's own SaaS subscription is owner-only (manage_org_billing),
// matching the /billing route boundary — this previously also allowed
// office_manager, contradicting the route map.
async function resolveOrgIdForCaller(supabase: any, userId: string): Promise<string> {
  return (await requirePermission(supabase, userId, "manage_org_billing")).orgId;
}

export const getBillingStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgIdForCaller(context.supabase, context.userId);
    const s = await getOrgBillingState(context.supabase, orgId);
    return {
      orgId: s.orgId,
      orgName: s.orgName,
      planName: s.planName,
      planSlug: s.planSlug,
      billingStatus: s.billingStatus,
      isPaidTier: s.isPaidTier,
      // Kept for back-compat with the old UI shape.
      planStatus: s.billingStatus,
      currentPeriodEnd: s.currentPeriodEnd,
      activeClientCount: s.activeClientCount,
      freeLimit: s.freeLimit,
      priceCents: s.priceCents,
      pricePerClientCents: s.pricePerClientCents,
      monthlyEstimateCents: s.monthlyEstimateCents,
      needsUpgrade: s.needsUpgrade,
      overBandLimit: s.overBandLimit,
      requiredPlanName: s.requiredPlan?.name ?? null,
      requiredPlanBandMin: s.requiredPlan?.client_limit_min ?? null,
      requiredPlanBandMax: s.requiredPlan?.client_limit_max ?? null,
      nextPlanName: s.nextPlan?.name ?? null,
      stripePriceId: s.stripePriceId,
    };
  });

export const createBillingCheckout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ returnUrl: z.string().url() }).parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgIdForCaller(context.supabase, context.userId);
    const s = await getOrgBillingState(context.supabase, orgId);

    // If the org is already at free size with no paid tier needed, block early
    // with a friendly message rather than a Stripe error.
    const targetPlan = s.requiredPlan && !s.requiredPlan.is_free
      ? s.requiredPlan
      : s.nextPlan;
    if (!targetPlan || !targetPlan.stripe_price_id) {
      throw new Error("No paid plan available for your current client count.");
    }

    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) throw new Error("Billing is not configured. Contact support.");
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(secret);

    const { data: userData } = await context.supabase.auth.getUser();
    const email = userData.user?.email ?? undefined;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Reuse existing Stripe customer if we have a real one; ignore obvious
    // seed placeholders like "cus_demo_seed".
    let customerId = s.stripeCustomerId;
    const looksReal = customerId && /^cus_[A-Za-z0-9]{6,}$/.test(customerId) && !customerId.includes("demo");
    if (!looksReal) {
      const customer = await stripe.customers.create({
        email,
        name: s.orgName,
        metadata: { organization_id: orgId },
      });
      customerId = customer.id;
      await supabaseAdmin.from("organizations")
        .update({ stripe_customer_id: customerId })
        .eq("id", orgId);
    }

    // Per-employee model (finding #6): the plan bills a flat base that covers a
    // set number of employees, plus a per-seat overage price for each active
    // employee beyond that. Attach the seat-overage line item with a quantity
    // equal to the current overage so the subscription starts out billing the
    // right amount. (Ongoing seat changes are reconciled through the Stripe
    // billing portal / a future sync job, not this checkout.)
    const { data: planExtra } = await supabaseAdmin
      .from("platform_plans")
      .select("included_seats, stripe_seat_price_id")
      .eq("id", targetPlan.id)
      .single();
    const includedSeats = (planExtra as any)?.included_seats ?? null;
    const seatPriceId = (planExtra as any)?.stripe_seat_price_id ?? null;

    const line_items: { price: string; quantity: number }[] = [
      { price: targetPlan.stripe_price_id, quantity: 1 },
    ];
    if (seatPriceId && includedSeats != null) {
      const { count: activeStaff } = await supabaseAdmin
        .from("staff")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("active", true);
      const overage = Math.max(0, (activeStaff ?? 0) - includedSeats);
      if (overage > 0) line_items.push({ price: seatPriceId, quantity: overage });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId!,
      line_items,
      success_url: `${data.returnUrl}?upgraded=1`,
      cancel_url: data.returnUrl,
      client_reference_id: orgId,
      subscription_data: {
        metadata: { organization_id: orgId, plan_id: targetPlan.id },
      },
      metadata: { organization_id: orgId, plan_id: targetPlan.id, kind: "org_saas" },
    });
    return { url: session.url as string, planName: targetPlan.name };
  });

export const createBillingPortal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ returnUrl: z.string().url() }).parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgIdForCaller(context.supabase, context.userId);
    const s = await getOrgBillingState(context.supabase, orgId);
    const customerId = s.stripeCustomerId;
    const looksReal = customerId && /^cus_[A-Za-z0-9]{6,}$/.test(customerId) && !customerId.includes("demo");
    if (!looksReal) {
      throw new Error("No active subscription yet — start a subscription first.");
    }
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) throw new Error("Billing is not configured.");
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(secret);
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId!,
      return_url: data.returnUrl,
    });
    return { url: portal.url };
  });

export const refreshBillingStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgIdForCaller(context.supabase, context.userId);
    const s = await getOrgBillingState(context.supabase, orgId);
    const customerId = s.stripeCustomerId;
    const looksReal = customerId && /^cus_[A-Za-z0-9]{6,}$/.test(customerId) && !customerId.includes("demo");
    if (!looksReal) return { billingStatus: s.billingStatus };
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) throw new Error("Billing is not configured.");
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(secret);
    const subs = await stripe.subscriptions.list({ customer: customerId!, status: "all", limit: 5 });
    const active = subs.data.find((s) => ["active", "trialing", "past_due"].includes(s.status));
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (active) {
      const status = active.status === "past_due" ? "past_due" : "active";
      const periodEnd = (active as unknown as { current_period_end?: number }).current_period_end;
      await supabaseAdmin.from("organizations").update({
        stripe_subscription_id: active.id,
        billing_status: status,
        plan_status: status,
        current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
      }).eq("id", orgId);
      return { billingStatus: status };
    }
    await supabaseAdmin.from("organizations").update({
      billing_status: "canceled",
      plan_status: "canceled",
      stripe_subscription_id: null,
    }).eq("id", orgId);
    return { billingStatus: "canceled" as const };
  });
