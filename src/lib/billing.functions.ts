import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getOrgBillingState, subscriptionPeriodEnd } from "./billing-state.server";
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
      includedSeats: s.includedSeats,
      pricePerSeatCents: s.pricePerSeatCents,
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
      .select("id, name, slug, description, price_cents, annual_price_cents, currency, interval, features, included_seats, price_per_seat_cents, is_free, stripe_price_id, stripe_annual_price_id, sort_order")
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
// (onboarding / Plan & billing) instead of auto-sizing by headcount, and a
// billing interval ("month" default, or "year" for annual = two months free).
export const createPlanSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        planId: z.string().uuid().optional(),
        interval: z.enum(["month", "year"]).optional(),
      })
      .parse(d),
  )
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
      .select("id, name, stripe_price_id, stripe_seat_price_id, stripe_annual_price_id, stripe_annual_seat_price_id, price_cents, annual_price_cents, included_seats")
      .eq("is_active", true)
      .eq("is_enterprise", false)
      .not("stripe_price_id", "is", null)
      .not("included_seats", "is", null)
      .order("included_seats", { ascending: true });
    const plans = (planRows ?? []) as Array<{
      id: string; name: string; stripe_price_id: string;
      stripe_seat_price_id: string | null;
      stripe_annual_price_id: string | null;
      stripe_annual_seat_price_id: string | null;
      price_cents: number | null; annual_price_cents: number | null;
      included_seats: number;
    }>;
    const targetPlan = data.planId
      ? plans.find((p) => p.id === data.planId)
      : plans.find((p) => p.included_seats >= seats) ?? plans[plans.length - 1];
    if (!targetPlan || !targetPlan.stripe_price_id) {
      throw new Error("That plan isn't available. Contact support.");
    }

    const targetInterval: "month" | "year" = data.interval ?? "month";
    const targetPlanPriceId =
      targetInterval === "year" ? targetPlan.stripe_annual_price_id : targetPlan.stripe_price_id;
    const targetSeatPriceId =
      targetInterval === "year" ? targetPlan.stripe_annual_seat_price_id : targetPlan.stripe_seat_price_id;
    if (!targetPlanPriceId) {
      throw new Error("Annual billing isn't available for that plan yet. Contact support.");
    }

    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(secret);

    // The plan bills a flat base that covers the tier's included employees,
    // plus a per-seat overage price for each active employee beyond that.
    // Ongoing seat changes are reconciled by syncOrgSeatQuantity (#6).
    const overage = Math.max(0, seats - targetPlan.included_seats);

    // ── In-place plan switch ────────────────────────────────────────────────
    // An org with a LIVE subscription must never get a second one stacked on
    // top. Swap the plan price on the existing subscription (prorated up or
    // down) and skip the payment form entirely — the subscription already has
    // a default payment method from the original subscribe.
    if (s.stripeSubscriptionId) {
      let existingSub: import("stripe").Stripe.Subscription | null = null;
      try {
        existingSub = await stripe.subscriptions.retrieve(s.stripeSubscriptionId, {
          expand: ["items.data.price"],
        });
      } catch {
        existingSub = null; // Gone on Stripe's side: fall through to a fresh subscribe.
      }
      if (existingSub && ["active", "trialing", "past_due"].includes(existingSub.status)) {
        // Classify existing items against the FULL plan catalog (including
        // retired plans and both intervals) so an old plan's price is still
        // recognized as "the plan item". Anything else is a bolt-on add-on.
        const { data: allPlanPrices } = await (supabaseAdmin as any)
          .from("platform_plans")
          .select("stripe_price_id, stripe_seat_price_id, stripe_annual_price_id, stripe_annual_seat_price_id");
        const planPriceIds = new Set(
          ((allPlanPrices ?? []) as any[])
            .flatMap((p) => [p.stripe_price_id, p.stripe_annual_price_id])
            .filter(Boolean),
        );
        const seatPriceIds = new Set(
          ((allPlanPrices ?? []) as any[])
            .flatMap((p) => [p.stripe_seat_price_id, p.stripe_annual_seat_price_id])
            .filter(Boolean),
        );

        // The add-on catalog, keyed by Stripe product, so a year → month
        // switch can put each add-on back on its stored monthly price.
        const { data: addonRows } = await (supabaseAdmin as any)
          .from("platform_addons")
          .select("stripe_product_id, stripe_price_id, billing_interval");
        const monthlyAddonPriceByProduct = new Map<string, string>();
        for (const a of (addonRows ?? []) as any[]) {
          if (a.stripe_product_id && a.stripe_price_id && a.billing_interval === "month") {
            monthlyAddonPriceByProduct.set(a.stripe_product_id, a.stripe_price_id);
          }
        }

        const existingItems = existingSub.items?.data ?? [];
        const currentPlanItem = existingItems.find(
          (it) => it.price?.id && planPriceIds.has(it.price.id),
        );
        const currentInterval: "month" | "year" =
          currentPlanItem?.price?.recurring?.interval === "year" ? "year" : "month";
        const intervalChanged = currentInterval !== targetInterval;

        const itemUpdates: import("stripe").Stripe.SubscriptionUpdateParams.Item[] = [];
        let keptTargetPlanItem = false;
        let keptSeatItem = false;
        // Add-on items whose subscription item is being replaced (interval
        // move): remembered by product so org_platform_addons can be re-pointed
        // at the replacement item after the update.
        const replacedAddonProducts: string[] = [];
        for (const it of existingItems) {
          const price = it.price;
          const priceId = price?.id;
          if (!priceId) continue;
          if (planPriceIds.has(priceId)) {
            if (priceId === targetPlanPriceId) keptTargetPlanItem = true;
            else itemUpdates.push({ id: it.id, deleted: true });
          } else if (seatPriceIds.has(priceId)) {
            if (priceId === targetSeatPriceId && overage > 0 && !keptSeatItem) {
              keptSeatItem = true;
              if ((it.quantity ?? 1) !== overage) itemUpdates.push({ id: it.id, quantity: overage });
            } else {
              itemUpdates.push({ id: it.id, deleted: true });
            }
          } else {
            // Bolt-on add-on item. Stripe forbids mixing month and year items
            // on one subscription, so when the plan changes interval EVERY
            // add-on item has to move to the target interval too. Same-interval
            // switches leave add-ons untouched.
            const itemInterval = price.recurring?.interval;
            if (!itemInterval || itemInterval === targetInterval) continue;
            const productId =
              typeof price.product === "string" ? price.product : price.product?.id;
            const unitAmount = price.unit_amount ?? 0;
            itemUpdates.push({ id: it.id, deleted: true });
            if (productId) replacedAddonProducts.push(productId);
            if (targetInterval === "year") {
              // Annual add-ons bill at exactly 12x the monthly amount: add-ons
              // carry NO annual discount (only plans get two months free).
              itemUpdates.push({
                price_data: {
                  currency: price.currency ?? "usd",
                  product: productId!,
                  recurring: { interval: "year" },
                  unit_amount: unitAmount * 12,
                },
                quantity: it.quantity ?? 1,
              });
            } else {
              // Back to monthly: prefer the add-on's stored monthly price so
              // future logic recognizes the item; else derive 1/12 of the
              // annual amount (which was minted as monthly x 12 above).
              const storedMonthly = productId
                ? monthlyAddonPriceByProduct.get(productId)
                : undefined;
              if (storedMonthly) {
                itemUpdates.push({ price: storedMonthly, quantity: it.quantity ?? 1 });
              } else {
                itemUpdates.push({
                  price_data: {
                    currency: price.currency ?? "usd",
                    product: productId!,
                    recurring: { interval: "month" },
                    unit_amount: Math.round(unitAmount / 12),
                  },
                  quantity: it.quantity ?? 1,
                });
              }
            }
          }
        }
        if (!keptTargetPlanItem) itemUpdates.push({ price: targetPlanPriceId, quantity: 1 });
        if (!keptSeatItem && targetSeatPriceId && overage > 0) {
          itemUpdates.push({ price: targetSeatPriceId, quantity: overage });
        }

        // Charge-now policy (UX round 7): upgrades and month → year switches
        // invoice + charge the prorated difference immediately
        // ("always_invoice"); downgrades and year → month switches keep
        // "create_prorations" so the unused time lands as a CREDIT on the next
        // invoice instead of an immediate refund.
        const currentUnit = currentPlanItem?.price?.unit_amount ?? 0;
        const currentMonthlyEq = currentInterval === "year" ? currentUnit / 12 : currentUnit;
        const targetMonthlyEq =
          targetInterval === "year"
            ? (targetPlan.annual_price_cents ?? 0) / 12
            : targetPlan.price_cents ?? 0;
        const chargeNow =
          (intervalChanged && targetInterval === "year") ||
          (!intervalChanged && targetMonthlyEq > currentMonthlyEq);

        const updated = await stripe.subscriptions.update(existingSub.id, {
          ...(itemUpdates.length > 0 ? { items: itemUpdates } : {}),
          proration_behavior: chargeNow ? "always_invoice" : "create_prorations",
          // Choosing a new plan is an explicit "keep billing me": a pending
          // cancel-at-period-end must not silently kill the plan they just
          // switched to (and paid prorations for).
          cancel_at_period_end: false,
          metadata: {
            ...existingSub.metadata,
            organization_id: orgId,
            plan_id: targetPlan.id,
            kind: "org_saas",
            interval: targetInterval,
          },
          ...(chargeNow ? { expand: ["latest_invoice"] } : {}),
        });

        // "always_invoice" creates + finalizes the proration invoice, but the
        // automatic charge can lag. Pay it explicitly so the money moves NOW;
        // if the card declines, Stripe keeps the invoice open (and will retry
        // per the account's dunning rules) — surface that honestly to the UI
        // instead of pretending the charge landed.
        let chargeFailed = false;
        if (chargeNow) {
          try {
            const li = updated.latest_invoice;
            const invoice = typeof li === "string" ? await stripe.invoices.retrieve(li) : li;
            if (invoice?.id && invoice.status === "open" && (invoice.amount_due ?? 0) > 0) {
              await stripe.invoices.pay(invoice.id);
            }
          } catch (e) {
            console.error("proration invoice charge failed", (e as Error).message);
            chargeFailed = true;
          }
        }

        // If any add-on items were replaced (interval move), re-point the
        // org_platform_addons rows at the new subscription items so a later
        // "Remove from plan" deletes the right item. Best-effort.
        if (replacedAddonProducts.length > 0) {
          try {
            const fresh = await stripe.subscriptions.retrieve(updated.id, {
              expand: ["items.data.price"],
            });
            for (const productId of replacedAddonProducts) {
              const newItem = (fresh.items?.data ?? []).find((it) => {
                const p = it.price?.product;
                return (typeof p === "string" ? p : p?.id) === productId;
              });
              const { data: addonRow } = await (supabaseAdmin as any)
                .from("platform_addons")
                .select("id")
                .eq("stripe_product_id", productId)
                .maybeSingle();
              if (newItem && addonRow?.id) {
                await (supabaseAdmin as any)
                  .from("org_platform_addons")
                  .update({ stripe_subscription_item_id: newItem.id })
                  .eq("organization_id", orgId)
                  .eq("addon_id", addonRow.id)
                  .eq("status", "active");
              }
            }
          } catch (e) {
            console.error("addon item re-mapping after interval switch failed", (e as Error).message);
          }
        }

        // Reflect the new plan identity immediately (don't wait for the
        // webhook); status stays whatever it was (active / past_due).
        const periodEnd = subscriptionPeriodEnd(updated);
        await supabaseAdmin
          .from("organizations")
          .update({
            plan_id: targetPlan.id,
            stripe_subscription_id: updated.id,
            ...(periodEnd
              ? { current_period_end: new Date(periodEnd * 1000).toISOString() }
              : {}),
          })
          .eq("id", orgId);

        return {
          switched: true as const,
          planName: targetPlan.name,
          interval: targetInterval,
          chargeFailed,
        };
      }
    }

    // ── First-time subscribe (no live subscription) ─────────────────────────
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

    const items: { price: string; quantity: number }[] = [
      { price: targetPlanPriceId, quantity: 1 },
    ];
    if (targetSeatPriceId && overage > 0) {
      items.push({ price: targetSeatPriceId, quantity: overage });
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
          switched: false as const,
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
      metadata: {
        organization_id: orgId,
        plan_id: targetPlan.id,
        kind: "org_saas",
        interval: targetInterval,
      },
      expand: ["latest_invoice.confirmation_secret"],
    });
    const clientSecret = clientSecretOf(sub);
    if (!clientSecret) throw new Error("Couldn't start the payment. Please try again.");

    // Deliberately NOT persisting stripe_subscription_id here: billing-state
    // treats a stored subscription id as "active", so an unpaid incomplete sub
    // would flip the org paid prematurely. The webhook (or refreshBillingStatus
    // after payment) records it once the subscription really activates.
    return {
      switched: false as const,
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
    const cancelEnd = subscriptionPeriodEnd(sub);
    const endsAt = cancelEnd ? new Date(cancelEnd * 1000).toISOString() : null;
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
    if (!s.stripeSubscriptionId) {
      return {
        items: [],
        subscriptionId: null,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: null,
        planInterval: null,
      };
    }
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) throw new Error("Billing is not configured.");
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(secret);
    const sub = await stripe.subscriptions.retrieve(s.stripeSubscriptionId, {
      expand: ["items.data.price.product"],
    });
    // Label rows against the FULL plan catalog: any plan's base price (monthly
    // or annual) is "the plan" line and any plan's seat price is the
    // seat-overage line, so the labels stay right even mid-switch or on a
    // retired plan. Anything else is a bolt-on add-on. The org's own plan row
    // supplies the display name.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: planRows } = await (supabaseAdmin as any)
      .from("platform_plans")
      .select("id, name, stripe_price_id, stripe_seat_price_id, stripe_annual_price_id, stripe_annual_seat_price_id");
    const planByPriceId = new Map<string, { name: string }>();
    const seatPriceIds = new Set<string>();
    for (const p of (planRows ?? []) as any[]) {
      if (p.stripe_price_id) planByPriceId.set(p.stripe_price_id, { name: p.name });
      if (p.stripe_annual_price_id) planByPriceId.set(p.stripe_annual_price_id, { name: p.name });
      if (p.stripe_seat_price_id) seatPriceIds.add(p.stripe_seat_price_id);
      if (p.stripe_annual_seat_price_id) seatPriceIds.add(p.stripe_annual_seat_price_id);
    }

    const items = (sub.items?.data ?? []).map((it: any) => {
      const price = it.price ?? {};
      const product = typeof price.product === "object" ? price.product : null;
      let kind: "base" | "seat" | "addon" = "addon";
      let name: string = product?.name ?? price.nickname ?? "Subscription item";
      const matchedPlan = price.id ? planByPriceId.get(price.id) : undefined;
      if (matchedPlan) {
        kind = "base";
        name = matchedPlan.name;
      } else if (price.id && seatPriceIds.has(price.id)) {
        kind = "seat";
      }
      return {
        id: it.id as string,
        kind,
        name,
        description: product?.description ?? null,
        quantity: it.quantity ?? 1,
        unitAmountCents: price.unit_amount ?? null,
        currency: price.currency ?? "usd",
        interval: price.recurring?.interval ?? null,
        intervalCount: price.recurring?.interval_count ?? 1,
      };
    });
    const periodEnd = subscriptionPeriodEnd(sub);
    // The org's billing interval, read from the plan item's price (all items
    // on a subscription share one interval — Stripe forbids mixing).
    const planItem = (sub.items?.data ?? []).find(
      (it: any) => it.price?.id && planByPriceId.has(it.price.id),
    ) as any;
    const planInterval: "month" | "year" | null =
      planItem?.price?.recurring?.interval ??
      (sub.items?.data?.[0] as any)?.price?.recurring?.interval ??
      null;
    return {
      items,
      subscriptionId: sub.id,
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
      planInterval,
    };
  });

// ── In-app payment methods (replaces the Stripe-hosted billing portal) ──────
// The org's SaaS cards live on the PLATFORM account customer. Same security
// posture as the client-side equivalents in payment-methods.functions.ts:
// SetupIntents carry organization_id in metadata and are verified on finalize,
// and a payment method is only ever touched when pm.customer matches the
// org's stored customer.

async function platformStripe() {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error("Billing is not configured.");
  const Stripe = (await import("stripe")).default;
  return new Stripe(secret);
}

function realCustomerId(customerId: string | null): string | null {
  const looksReal =
    customerId && /^cus_[A-Za-z0-9]{6,}$/.test(customerId) && !customerId.includes("demo");
  return looksReal ? customerId : null;
}

export type OrgPaymentMethod = {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
};

/** Effective default payment method for the org: the subscription's own
 * default wins (that's what invoices charge), else the customer default. */
async function orgDefaultPaymentMethodId(
  stripe: import("stripe").Stripe,
  customer: any,
  subscriptionId: string | null,
): Promise<string | null> {
  if (subscriptionId) {
    try {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      const subDefault =
        typeof sub.default_payment_method === "string"
          ? sub.default_payment_method
          : sub.default_payment_method?.id;
      if (subDefault) return subDefault;
    } catch {
      // Subscription gone: fall through to the customer default.
    }
  }
  const custDefault = customer?.invoice_settings?.default_payment_method;
  return (typeof custDefault === "string" ? custDefault : custDefault?.id) ?? null;
}

export const listOrgPaymentMethods = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ methods: OrgPaymentMethod[]; hasCustomer: boolean }> => {
    const orgId = await resolveOrgIdForCaller(context.supabase, context.userId);
    const s = await getOrgBillingState(context.supabase, orgId);
    const customerId = realCustomerId(s.stripeCustomerId);
    if (!customerId) return { methods: [], hasCustomer: false };
    const stripe = await platformStripe();

    let customer: any;
    try {
      customer = await stripe.customers.retrieve(customerId);
    } catch (e: any) {
      // Deleted/missing customer means "no cards"; anything else must surface.
      if (e?.code === "resource_missing") return { methods: [], hasCustomer: false };
      throw e;
    }
    if (customer.deleted) return { methods: [], hasCustomer: false };

    const defaultId = await orgDefaultPaymentMethodId(stripe, customer, s.stripeSubscriptionId);
    const pms = await stripe.customers.listPaymentMethods(customerId, { type: "card", limit: 20 });
    const methods: OrgPaymentMethod[] = (pms.data ?? [])
      .filter((pm: any) => pm.card)
      .map((pm: any) => ({
        id: pm.id,
        brand: pm.card.brand ?? "card",
        last4: pm.card.last4 ?? "????",
        expMonth: pm.card.exp_month ?? 0,
        expYear: pm.card.exp_year ?? 0,
        isDefault: pm.id === defaultId,
      }));
    return { methods, hasCustomer: true };
  });

export const createOrgSetupIntent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgIdForCaller(context.supabase, context.userId);
    const s = await getOrgBillingState(context.supabase, orgId);
    const publishableKey =
      process.env.STRIPE_PUBLISHABLE_KEY ?? process.env.PLATFORM_STRIPE_PUBLISHABLE_KEY;
    if (!publishableKey) throw new Error("Billing is not configured. Contact support.");
    const stripe = await platformStripe();

    let customerId = realCustomerId(s.stripeCustomerId);
    if (!customerId) {
      const { data: userData } = await context.supabase.auth.getUser();
      const customer = await stripe.customers.create({
        email: userData.user?.email ?? undefined,
        name: s.orgName,
        metadata: { organization_id: orgId },
      });
      customerId = customer.id;
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin
        .from("organizations")
        .update({ stripe_customer_id: customerId })
        .eq("id", orgId);
    }

    const si = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
      usage: "off_session",
      metadata: { source: "org_billing_setup", organization_id: orgId },
    });
    return { clientSecret: si.client_secret as string, publishableKey };
  });

export const finalizeOrgPaymentMethod = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ setupIntentId: z.string().min(3) }).parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgIdForCaller(context.supabase, context.userId);
    const s = await getOrgBillingState(context.supabase, orgId);
    const stripe = await platformStripe();

    const si = await stripe.setupIntents.retrieve(data.setupIntentId);
    // Security: the SetupIntent must be the one we minted for THIS org, so a
    // pasted/guessed seti_… id can't bind someone else's card here.
    if (si.metadata?.organization_id !== orgId) {
      throw new Error("Card setup could not be verified.");
    }
    const pmId = typeof si.payment_method === "string" ? si.payment_method : si.payment_method?.id;
    const customerId = typeof si.customer === "string" ? si.customer : si.customer?.id;
    if (!pmId || !customerId) throw new Error("Card wasn't saved. Please try again.");

    const pm = await stripe.paymentMethods.retrieve(pmId);
    const pmCustomer = typeof pm.customer === "string" ? pm.customer : pm.customer?.id;
    if (pmCustomer !== customerId) throw new Error("Card setup could not be verified.");

    // New card becomes the default everywhere: customer (future invoices,
    // one-time add-on charges) AND the live subscription (renewals).
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: pmId },
    });
    if (s.stripeSubscriptionId) {
      try {
        await stripe.subscriptions.update(s.stripeSubscriptionId, {
          default_payment_method: pmId,
        });
      } catch (e: any) {
        if (e?.code !== "resource_missing") throw e;
      }
    }
    return { ok: true, brand: pm.card?.brand ?? null, last4: pm.card?.last4 ?? null };
  });

export const setDefaultOrgPaymentMethod = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ paymentMethodId: z.string().min(3) }).parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgIdForCaller(context.supabase, context.userId);
    const s = await getOrgBillingState(context.supabase, orgId);
    const customerId = realCustomerId(s.stripeCustomerId);
    if (!customerId) throw new Error("No saved payment methods yet.");
    const stripe = await platformStripe();

    // The method must belong to THIS org's customer; a pasted pm_… id from
    // another customer must not become the default here.
    const pm = await stripe.paymentMethods.retrieve(data.paymentMethodId);
    const pmCustomer = typeof pm.customer === "string" ? pm.customer : pm.customer?.id;
    if (pmCustomer !== customerId) throw new Error("That card doesn't belong to your account.");

    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: data.paymentMethodId },
    });
    if (s.stripeSubscriptionId) {
      try {
        await stripe.subscriptions.update(s.stripeSubscriptionId, {
          default_payment_method: data.paymentMethodId,
        });
      } catch (e: any) {
        if (e?.code !== "resource_missing") throw e;
      }
    }
    return { ok: true };
  });

export const removeOrgPaymentMethod = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ paymentMethodId: z.string().min(3) }).parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgIdForCaller(context.supabase, context.userId);
    const s = await getOrgBillingState(context.supabase, orgId);
    const customerId = realCustomerId(s.stripeCustomerId);
    if (!customerId) throw new Error("No saved payment methods yet.");
    const stripe = await platformStripe();

    const pm = await stripe.paymentMethods.retrieve(data.paymentMethodId);
    const pmCustomer = typeof pm.customer === "string" ? pm.customer : pm.customer?.id;
    if (pmCustomer !== customerId) throw new Error("That card doesn't belong to your account.");

    const customer: any = await stripe.customers.retrieve(customerId);
    const defaultId = await orgDefaultPaymentMethodId(stripe, customer, s.stripeSubscriptionId);
    const pms = await stripe.customers.listPaymentMethods(customerId, { type: "card", limit: 20 });
    const others = (pms.data ?? []).filter((m: any) => m.card && m.id !== data.paymentMethodId);
    const wasDefault = data.paymentMethodId === defaultId || others.length === 0;
    const subActive =
      !!s.stripeSubscriptionId &&
      (s.billingStatus === "active" || s.billingStatus === "past_due" || s.billingStatus === "grace");

    // Guard: never leave a live subscription with no card on file. If another
    // card remains it gets promoted below instead.
    if (wasDefault && subActive && others.length === 0) {
      throw new Error("Add another card first. An active subscription needs a card on file.");
    }

    await stripe.paymentMethods.detach(data.paymentMethodId);

    if (wasDefault && others.length > 0) {
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: others[0].id },
      });
      if (s.stripeSubscriptionId) {
        try {
          await stripe.subscriptions.update(s.stripeSubscriptionId, {
            default_payment_method: others[0].id,
          });
        } catch (e: any) {
          if (e?.code !== "resource_missing") throw e;
        }
      }
    }
    return { ok: true };
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
      const periodEnd = subscriptionPeriodEnd(active);
      const update: Record<string, unknown> = {
        stripe_subscription_id: active.id,
        billing_status: status,
        plan_status: status,
        // Never null a stored renewal date just because this read couldn't
        // resolve one — omit the column instead.
        ...(periodEnd
          ? { current_period_end: new Date(periodEnd * 1000).toISOString() }
          : {}),
      };
      // Propagate plan identity: the subscription carries plan_id in its
      // metadata (set at create/switch). Only overwrite when it's present AND
      // resolves to a real catalog row, so a hand-made Stripe sub can't null
      // out or corrupt the org's plan.
      const metaPlanId = active.metadata?.plan_id;
      if (metaPlanId) {
        const { data: planRow } = await (supabaseAdmin as any)
          .from("platform_plans")
          .select("id")
          .eq("id", metaPlanId)
          .maybeSingle();
        if (planRow?.id) update.plan_id = metaPlanId;
      }
      await supabaseAdmin.from("organizations").update(update as any).eq("id", orgId);
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
    // A just-paid default_incomplete subscription can still read "incomplete"
    // for a few seconds while Stripe finalizes it. Demoting the org to
    // canceled in that window would kill add-ons for a PAYING customer (and
    // stick if the webhook is misconfigured) — report current state and let
    // the next refresh or webhook settle it.
    const settling = subs.data.find(
      (sub) =>
        sub.status === "incomplete" &&
        Date.now() / 1000 - sub.created < 15 * 60,
    );
    if (settling) return { billingStatus: s.billingStatus };
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
