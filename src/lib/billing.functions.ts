import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getOrgBillingState } from "./billing-state.server";
import { requirePermission, resolveCaller } from "@/lib/authz.server";

// Kept for back-compat with anything still importing this.
export const PRO_PRICE_CENTS = 5900;

// The org's own SaaS subscription is owner-only (manage_org_billing),
// matching the /billing route boundary — this previously also allowed
// office_manager, contradicting the route map.
async function resolveOrgIdForCaller(supabase: any, userId: string): Promise<string> {
  return (await requirePermission(supabase, userId, "manage_org_billing")).orgId;
}

// Lightweight read of billing health for the sitewide banner. Any org member
// (owner, office_manager, dispatcher, tech) can see whether the org's plan is
// past_due / canceled — they just can't act on it. The CTA in the UI is
// role-gated separately.
export const getBillingBannerStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const caller = await resolveCaller(context.supabase, context.userId);
    const s = await getOrgBillingState(context.supabase, caller.orgId);
    return { planStatus: s.billingStatus, role: caller.role };
  });


export const getBillingStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // Read-only status: any org member may see it. The sitewide banner needs
    // this so an office manager learns the subscription lapsed BEFORE hitting
    // the client-creation block (P1.5) — mutations below stay owner-gated.
    const { resolveCaller } = await import("@/lib/authz.server");
    const { orgId } = await resolveCaller(context.supabase, context.userId);
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

// Plan catalog for the in-app plan picker (embedded billing + onboarding).
export const listPlatformPlans = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await resolveOrgIdForCaller(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await (supabaseAdmin as any)
      .from("platform_plans")
      .select("id, name, slug, description, price_cents, currency, interval, features, included_seats, price_per_seat_cents, is_free, stripe_price_id, sort_order")
      .eq("is_active", true)
      .eq("is_enterprise", false)
      .order("sort_order", { ascending: true });
    if (error) throw new Error(error.message);
    return { plans: data ?? [] };
  });

// In-app plan subscribe via the Payment Element: create the subscription
// directly (payment_behavior default_incomplete) and hand the invoice's
// client secret to a Payment Element — no Checkout session at all, hosted or
// embedded. Optionally takes an explicit planId from the plan picker
// (onboarding / Plan & billing) instead of auto-sizing by headcount.
export const createPlanSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ planId: z.string().uuid().optional() }).parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgIdForCaller(context.supabase, context.userId);
    const s = await getOrgBillingState(context.supabase, orgId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const publishableKey =
      process.env.STRIPE_PUBLISHABLE_KEY ?? process.env.PLATFORM_STRIPE_PUBLISHABLE_KEY;
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) throw new Error("Billing is not configured. Contact support.");
    if (!publishableKey) {
      throw new Error("Embedded billing needs STRIPE_PUBLISHABLE_KEY set. Contact support.");
    }

    const { count: activeStaff } = await supabaseAdmin
      .from("staff")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("active", true);
    const seats = activeStaff ?? 0;

    const { data: planRows } = await (supabaseAdmin as any)
      .from("platform_plans")
      .select("id, name, stripe_price_id, stripe_seat_price_id, included_seats")
      .eq("is_active", true)
      .eq("is_enterprise", false)
      .not("stripe_price_id", "is", null)
      .not("included_seats", "is", null)
      .order("included_seats", { ascending: true });
    const plans = (planRows ?? []) as Array<{
      id: string; name: string; stripe_price_id: string;
      stripe_seat_price_id: string | null; included_seats: number;
    }>;
    const targetPlan = data.planId
      ? plans.find((p) => p.id === data.planId)
      : plans.find((p) => p.included_seats >= seats) ?? plans[plans.length - 1];
    if (!targetPlan || !targetPlan.stripe_price_id) {
      throw new Error("That plan isn't available. Contact support.");
    }

    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(secret);
    const { data: userData } = await context.supabase.auth.getUser();
    const email = userData.user?.email ?? undefined;

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

    // The plan bills a flat base that covers the tier's included employees,
    // plus a per-seat overage price for each active employee beyond that.
    // Ongoing seat changes are reconciled by syncOrgSeatQuantity (#6).
    const overage = Math.max(0, seats - targetPlan.included_seats);
    const items: { price: string; quantity: number }[] = [
      { price: targetPlan.stripe_price_id, quantity: 1 },
    ];
    if (targetPlan.stripe_seat_price_id && overage > 0) {
      items.push({ price: targetPlan.stripe_seat_price_id, quantity: overage });
    }

    // Stripe v22 / 2025+ API: the invoice's client secret lives in
    // latest_invoice.confirmation_secret (invoice.payment_intent is gone).
    const clientSecretOf = (sub: import("stripe").Stripe.Subscription): string | null => {
      const inv = sub.latest_invoice;
      if (!inv || typeof inv === "string") return null;
      return inv.confirmation_secret?.client_secret ?? null;
    };

    // Retry churn: a "default_incomplete" subscription is created before the
    // owner pays, so an abandoned form leaves an incomplete sub behind. If one
    // already exists for this org and it matches the exact items we'd create
    // (same prices, same quantities), reuse its invoice's client secret instead
    // of stacking another; otherwise cancel the stale one and start fresh.
    const incomplete = await stripe.subscriptions.list({
      customer: customerId!,
      status: "incomplete",
      limit: 10,
      expand: ["data.latest_invoice.confirmation_secret"],
    });
    for (const sub of incomplete.data) {
      if (sub.metadata?.kind !== "org_saas" || sub.metadata?.organization_id !== orgId) continue;
      const subItems = sub.items?.data ?? [];
      const sameItems =
        sub.metadata?.plan_id === targetPlan.id &&
        subItems.length === items.length &&
        items.every((d) =>
          subItems.some((it) => it.price?.id === d.price && (it.quantity ?? 1) === d.quantity),
        );
      const reusableSecret = sameItems ? clientSecretOf(sub) : null;
      if (reusableSecret) {
        return {
          clientSecret: reusableSecret,
          publishableKey,
          planName: targetPlan.name,
          subscriptionId: sub.id,
        };
      }
      // Stale (different plan/seat mix, or no usable secret) — cancel so the
      // customer never ends up with two competing subscriptions.
      await stripe.subscriptions.cancel(sub.id).catch((e) => {
        console.error("stale incomplete subscription cancel failed", (e as Error).message);
      });
    }

    const sub = await stripe.subscriptions.create({
      customer: customerId!,
      items,
      payment_behavior: "default_incomplete",
      payment_settings: {
        save_default_payment_method: "on_subscription",
        payment_method_types: ["card"],
      },
      metadata: { organization_id: orgId, plan_id: targetPlan.id, kind: "org_saas" },
      expand: ["latest_invoice.confirmation_secret"],
    });
    const clientSecret = clientSecretOf(sub);
    if (!clientSecret) throw new Error("Couldn't start the payment. Please try again.");

    // Deliberately NOT persisting stripe_subscription_id here: billing-state
    // treats a stored subscription id as "active", so an unpaid incomplete sub
    // would flip the org paid prematurely. The webhook (or refreshBillingStatus
    // after payment) records it once the subscription really activates.
    return {
      clientSecret,
      publishableKey,
      planName: targetPlan.name,
      subscriptionId: sub.id,
    };
  });

// In-app cancel/resume (no portal round-trip). Cancels at period end so the
// org keeps what it paid for; resume undoes it before the period lapses.
export const cancelBillingSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgIdForCaller(context.supabase, context.userId);
    const s = await getOrgBillingState(context.supabase, orgId);
    if (!s.stripeSubscriptionId) throw new Error("No active subscription to cancel.");
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) throw new Error("Billing is not configured.");
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(secret);
    const sub = await stripe.subscriptions.update(s.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });
    const endsAt = (sub as any).current_period_end
      ? new Date((sub as any).current_period_end * 1000).toISOString()
      : null;
    return { ok: true, endsAt };
  });

export const resumeBillingSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgIdForCaller(context.supabase, context.userId);
    const s = await getOrgBillingState(context.supabase, orgId);
    if (!s.stripeSubscriptionId) throw new Error("No subscription found.");
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) throw new Error("Billing is not configured.");
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(secret);
    await stripe.subscriptions.update(s.stripeSubscriptionId, {
      cancel_at_period_end: false,
    });
    return { ok: true };
  });

// In-app invoice history (punch list #10): the platform-stripe webhook mirrors
// Stripe invoices into platform_invoices; show them here instead of forcing a
// portal round-trip just to see billing history.
export const listPlatformInvoices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgIdForCaller(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await (supabaseAdmin as any)
      .from("platform_invoices")
      .select("stripe_invoice_id, number, amount_due_cents, amount_paid_cents, currency, status, hosted_invoice_url, invoice_pdf, period_start, period_end, issued_at, paid_at")
      .eq("organization_id", orgId)
      .order("issued_at", { ascending: false })
      .limit(24);
    if (error) throw new Error(error.message);
    return { invoices: data ?? [] };
  });

// Subscription line items ("what you're paying for") — base plan + seat overage
// + any extra add-on items an admin attached in Stripe. Rendered inline on the
// Billing settings page so owners see their full bill without a portal trip.
export const listSubscriptionItems = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgIdForCaller(context.supabase, context.userId);
    const s = await getOrgBillingState(context.supabase, orgId);
    if (!s.stripeSubscriptionId) return { items: [], subscriptionId: null };
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) throw new Error("Billing is not configured.");
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(secret);
    const sub = await stripe.subscriptions.retrieve(s.stripeSubscriptionId, {
      expand: ["items.data.price.product"],
    });
    // Pull the org's platform plan price ids so we can label the "base" vs
    // "seat overage" rows correctly (anything else is a bolt-on add-on).
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: planRow } = await (supabaseAdmin as any)
      .from("platform_plans")
      .select("stripe_price_id, stripe_seat_price_id")
      .eq("id", (await (supabaseAdmin as any)
        .from("organizations").select("plan_id").eq("id", orgId).single()).data?.plan_id ?? "00000000-0000-0000-0000-000000000000")
      .maybeSingle();
    const basePriceId: string | null = planRow?.stripe_price_id ?? null;
    const seatPriceId: string | null = planRow?.stripe_seat_price_id ?? null;

    const items = (sub.items?.data ?? []).map((it: any) => {
      const price = it.price ?? {};
      const product = typeof price.product === "object" ? price.product : null;
      let kind: "base" | "seat" | "addon" = "addon";
      if (basePriceId && price.id === basePriceId) kind = "base";
      else if (seatPriceId && price.id === seatPriceId) kind = "seat";
      return {
        id: it.id as string,
        kind,
        name: product?.name ?? price.nickname ?? "Subscription item",
        description: product?.description ?? null,
        quantity: it.quantity ?? 1,
        unitAmountCents: price.unit_amount ?? null,
        currency: price.currency ?? "usd",
        interval: price.recurring?.interval ?? null,
        intervalCount: price.recurring?.interval_count ?? 1,
      };
    });
    return { items, subscriptionId: sub.id };
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
      throw new Error("No active subscription yet. Start a subscription first.");
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
      // Self-heal the seat-overage quantity while we're here, so a seat count
      // that drifted (e.g. an invite accepted since checkout) reconciles the
      // next time billing is viewed. Best-effort.
      try {
        const { syncOrgSeatQuantity } = await import("@/lib/seat-sync.server");
        await syncOrgSeatQuantity(orgId);
      } catch (e) {
        console.error("seat sync during refreshBillingStatus failed", (e as Error).message);
      }
      return { billingStatus: status };
    }
    await supabaseAdmin.from("organizations").update({
      billing_status: "canceled",
      plan_status: "canceled",
      stripe_subscription_id: null,
    }).eq("id", orgId);
    // Bolt-on add-ons die with the subscription (see platform-addons.server).
    try {
      const { deactivateOrgPlatformAddons } = await import("@/lib/platform-addons.server");
      await deactivateOrgPlatformAddons(orgId);
    } catch (e) {
      console.error("addon deactivation during refreshBillingStatus failed", (e as Error).message);
    }
    return { billingStatus: "canceled" as const };
  });
