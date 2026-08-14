import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getOrgBillingState, subscriptionPeriodEnd } from "./billing-state.server";
import { requirePermission, resolveCaller } from "@/lib/authz.server";
import { makeStripe } from "@/lib/stripe-client.server";
import { addonLookupKey, planLookupKey } from "@/lib/stripe-lookup-keys";
import {
  loadPriceCatalog,
  resolvePriceId,
  resolvePriceIdSet,
} from "@/lib/stripe-price-catalog.server";

// Nothing imports this. $59 is not a price in the current per-employee
// catalog either — plans come from `platform_plans`, which is the only place
// a price should be read from. Kept only because deleting an export is a
// separate change from correcting a comment that claimed a caller existed.
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
      .select("id, name, slug, stripe_price_id, stripe_seat_price_id, stripe_annual_price_id, stripe_annual_seat_price_id, price_cents, annual_price_cents, included_seats")
      .eq("is_active", true)
      .eq("is_enterprise", false)
      .not("stripe_price_id", "is", null)
      .not("included_seats", "is", null)
      .order("included_seats", { ascending: true });
    const plans = (planRows ?? []) as Array<{
      id: string; name: string; slug: string; stripe_price_id: string;
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

    const stripe = await makeStripe(secret);

    // Ask Stripe for the account's own prices by NAME, not by the id the
    // database happens to hold. Every id in `platform_plans` is a live id, and
    // ids are minted per account — so under a test key those ids resolve to
    // nothing and the whole signup → subscribe → invoice path has never been
    // runnable outside the real account. Both accounts now carry the same
    // eighteen lookup keys, so this one list call answers in either mode.
    // The stored id remains the fallback (see stripe-price-catalog.server.ts),
    // which keeps today's behaviour as the floor.
    const catalog = await loadPriceCatalog(stripe);
    const planKind = targetInterval === "year" ? "base_annual" : "base_monthly";
    const seatKind = targetInterval === "year" ? "seat_annual" : "seat_monthly";
    const targetPlanPriceId = resolvePriceId(
      catalog,
      planLookupKey(targetPlan.slug, planKind),
      targetInterval === "year" ? targetPlan.stripe_annual_price_id : targetPlan.stripe_price_id,
    );
    const targetSeatPriceId = resolvePriceId(
      catalog,
      planLookupKey(targetPlan.slug, seatKind),
      targetInterval === "year"
        ? targetPlan.stripe_annual_seat_price_id
        : targetPlan.stripe_seat_price_id,
    );
    if (!targetPlanPriceId) {
      // Two different faults land here and they are not the same conversation.
      // A missing annual column is a product decision — that plan is simply not
      // sold yearly. Everything else means the account in use has neither the
      // lookup key nor the stored id, which is a configuration fault worth
      // saying out loud rather than blaming on the customer's choice of term.
      const storedForTerm =
        targetInterval === "year" ? targetPlan.stripe_annual_price_id : targetPlan.stripe_price_id;
      if (targetInterval === "year" && !storedForTerm) {
        throw new Error("Annual billing isn't available for that plan yet. Contact support.");
      }
      console.error(
        `plan price unresolvable: no price named ${planLookupKey(targetPlan.slug, planKind)} ` +
          `in this Stripe account, and the stored id ${storedForTerm ?? "(none)"} is not on it either`,
      );
      throw new Error("That plan isn't available. Contact support.");
    }

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
          .select("slug, stripe_price_id, stripe_seat_price_id, stripe_annual_price_id, stripe_annual_seat_price_id");
        const allPlanRows = (allPlanPrices ?? []) as any[];
        // Both halves: the ids this account answers to by name, AND the ids the
        // database stored. The stored ones stay in even when this account does
        // not have them — this is a membership test, so a live id present while
        // running in test mode matches nothing and costs nothing, whereas
        // dropping it would misclassify a subscription created before the
        // lookup keys existed as a bolt-on add-on and delete the plan item.
        const planPriceIds = resolvePriceIdSet(
          catalog,
          allPlanRows.flatMap((p) =>
            p.slug ? [planLookupKey(p.slug, "base_monthly"), planLookupKey(p.slug, "base_annual")] : [],
          ),
          allPlanRows.flatMap((p) => [p.stripe_price_id, p.stripe_annual_price_id]),
        );
        const seatPriceIds = resolvePriceIdSet(
          catalog,
          allPlanRows.flatMap((p) =>
            p.slug ? [planLookupKey(p.slug, "seat_monthly"), planLookupKey(p.slug, "seat_annual")] : [],
          ),
          allPlanRows.flatMap((p) => [p.stripe_seat_price_id, p.stripe_annual_seat_price_id]),
        );

        // The add-on catalog, keyed by Stripe product, so a year → month
        // switch can put each add-on back on its monthly price.
        //
        // Resolved through the catalog like every other price sent to Stripe.
        // This was the FIFTH send-site and it was missed when the other four
        // were converted: the value here goes straight into
        // `itemUpdates.push({ price: storedMonthly })` below, so under a test
        // key it handed Stripe a live add-on price id and the whole plan switch
        // failed — the exact fault the lookup keys exist to remove, surviving
        // in the one path that only fires when a subscription carries a bolt-on
        // add-on AND changes interval.
        //
        // A null here is safe rather than fatal: the caller already falls
        // through to minting an inline monthly `price_data` from the annual
        // amount, which is what happens today for any add-on with no stored
        // monthly price at all.
        const { data: addonRows } = await (supabaseAdmin as any)
          .from("platform_addons")
          .select("slug, stripe_product_id, stripe_price_id, billing_interval");
        const monthlyAddonPriceByProduct = new Map<string, string>();
        for (const a of (addonRows ?? []) as any[]) {
          if (!a.stripe_product_id || a.billing_interval !== "month") continue;
          const resolved = a.slug
            ? resolvePriceId(catalog, addonLookupKey(a.slug), a.stripe_price_id)
            : a.stripe_price_id && catalog.ids.has(a.stripe_price_id)
              ? a.stripe_price_id
              : null;
          if (resolved) monthlyAddonPriceByProduct.set(a.stripe_product_id, resolved);
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
          // Only a failed PAY flags chargeFailed: a transient retrieve error
          // says nothing about the charge (auto-collection may land fine).
          let invoice: import("stripe").Stripe.Invoice | null = null;
          try {
            const li = updated.latest_invoice;
            invoice = typeof li === "string" ? await stripe.invoices.retrieve(li) : (li ?? null);
          } catch (e) {
            console.error("proration invoice retrieve failed (auto-collection will handle it)", (e as Error).message);
          }
          if (invoice?.id && invoice.status === "open" && (invoice.amount_due ?? 0) > 0) {
            try {
              await stripe.invoices.pay(invoice.id);
            } catch (e) {
              console.error("proration invoice charge failed", (e as Error).message);
              chargeFailed = true;
            }
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

    // Signup promo: a coupon code captured on Get-started (stored on the org)
    // is applied to the FIRST subscription as the mirrored Stripe coupon —
    // Stripe then enforces once/repeating/forever on its own. Re-validated
    // here: a code deactivated/expired/maxed since signup, or one restricted
    // to other plans, silently applies nothing rather than blocking checkout.
    let promoCoupon: { id: string; code: string; stripe_coupon_id: string } | null = null;
    try {
      const { data: orgPromoRow } = await (supabaseAdmin as any)
        .from("organizations")
        .select("signup_promo_code")
        .eq("id", orgId)
        .maybeSingle();
      const storedCode = orgPromoRow?.signup_promo_code as string | null | undefined;
      if (storedCode) {
        const { lookupSignupCode } = await import("@/lib/signup-codes.server");
        const hit = await lookupSignupCode(supabaseAdmin, storedCode);
        if (hit.kind === "coupon" && hit.coupon.stripe_coupon_id) {
          const planOk =
            !hit.coupon.applies_to_plan_ids?.length ||
            hit.coupon.applies_to_plan_ids.includes(targetPlan.id);
          if (planOk) {
            promoCoupon = {
              id: hit.coupon.id,
              code: hit.coupon.code,
              stripe_coupon_id: hit.coupon.stripe_coupon_id,
            };
          }
        }
      }
    } catch (e) {
      console.error("signup promo lookup failed (subscribing without it)", (e as Error).message);
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

    const createParams: import("stripe").Stripe.SubscriptionCreateParams = {
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
        ...(promoCoupon ? { promo_code: promoCoupon.code } : {}),
      },
      expand: ["latest_invoice.confirmation_secret"],
    };
    let sub: import("stripe").Stripe.Subscription;
    try {
      sub = await stripe.subscriptions.create({
        ...createParams,
        ...(promoCoupon ? { discounts: [{ coupon: promoCoupon.stripe_coupon_id }] } : {}),
      });
    } catch (e) {
      // A coupon Stripe rejects (e.g. its own max_redemptions hit) must not
      // block the subscribe — retry once without the discount.
      if (!promoCoupon) throw e;
      console.error("signup promo coupon rejected by Stripe; subscribing without it", (e as Error).message);
      promoCoupon = null;
      sub = await stripe.subscriptions.create(createParams);
    }

    // Redemption bookkeeping + attribution audit, best-effort. Counted at
    // subscription creation; the incomplete-sub REUSE path above returns
    // before re-creating, so a retried checkout isn't double-counted.
    if (promoCoupon) {
      try {
        const { data: c } = await supabaseAdmin
          .from("platform_coupons")
          .select("times_redeemed")
          .eq("id", promoCoupon.id)
          .maybeSingle();
        await supabaseAdmin
          .from("platform_coupons")
          .update({ times_redeemed: (c?.times_redeemed ?? 0) + 1 })
          .eq("id", promoCoupon.id);
        await supabaseAdmin.from("platform_admin_audit").insert({
          actor_user_id: context.userId,
          organization_id: orgId,
          action: "signup_promo_applied",
          after_json: {
            code: promoCoupon.code,
            subscription_id: sub.id,
            plan_id: targetPlan.id,
          },
        });
      } catch (e) {
        console.error("signup promo bookkeeping failed", (e as Error).message);
      }
    }

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
    const stripe = await makeStripe(secret);
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
    const stripe = await makeStripe(secret);
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
    const stripe = await makeStripe(secret);
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
      .select("id, name, slug, stripe_price_id, stripe_seat_price_id, stripe_annual_price_id, stripe_annual_seat_price_id");
    // Resolved by name as well as by stored id: a subscription in the account
    // the stored ids do NOT belong to would otherwise label every line
    // "Subscription item", which is what a customer would then see on the
    // billing screen instead of their plan name.
    const catalog = await loadPriceCatalog(stripe);
    const planByPriceId = new Map<string, { name: string }>();
    const seatPriceIds = new Set<string>();
    for (const p of (planRows ?? []) as any[]) {
      const baseIds = resolvePriceIdSet(
        catalog,
        p.slug ? [planLookupKey(p.slug, "base_monthly"), planLookupKey(p.slug, "base_annual")] : [],
        [p.stripe_price_id, p.stripe_annual_price_id],
      );
      for (const id of baseIds) planByPriceId.set(id, { name: p.name });
      const seatIds = resolvePriceIdSet(
        catalog,
        p.slug ? [planLookupKey(p.slug, "seat_monthly"), planLookupKey(p.slug, "seat_annual")] : [],
        [p.stripe_seat_price_id, p.stripe_annual_seat_price_id],
      );
      for (const id of seatIds) seatPriceIds.add(id);
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
  return await makeStripe(secret);
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
    const stripe = await makeStripe(secret);
    const subs = await stripe.subscriptions.list({ customer: customerId!, status: "all", limit: 5 });
    const active = subs.data.find((s) => ["active", "trialing", "past_due"].includes(s.status));
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (active) {
      const status = active.status === "past_due" ? "past_due" : "active";
      const periodEnd = subscriptionPeriodEnd(active);
      const update: Record<string, unknown> = {
        stripe_subscription_id: active.id,
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
      // billing_status moved out of the patch above and through the shared
      // writer, so this path and the platform webhook agree on one rule —
      // including refusing to lift an admin suspension — and both file the
      // audit row "Converted this month" reads.
      const { applyPlatformBillingStatus } = await import("@/lib/platform-billing-status.server");
      await applyPlatformBillingStatus(supabaseAdmin, orgId, status, {
        source: "billing_refresh",
        actorUserId: context.userId,
        detail: { subscription: active.id, stripe_status: active.status },
      });
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
      plan_status: "canceled",
      stripe_subscription_id: null,
    }).eq("id", orgId);
    const { applyPlatformBillingStatus } = await import("@/lib/platform-billing-status.server");
    await applyPlatformBillingStatus(supabaseAdmin, orgId, "canceled", {
      source: "billing_refresh",
      actorUserId: context.userId,
      detail: { reason: "no live subscription on the customer" },
    });
    // Bolt-on add-ons die with the subscription (see platform-addons.server).
    try {
      const { deactivateOrgPlatformAddons } = await import("@/lib/platform-addons.server");
      await deactivateOrgPlatformAddons(orgId);
    } catch (e) {
      console.error("addon deactivation during refreshBillingStatus failed", (e as Error).message);
    }
    return { billingStatus: "canceled" as const };
  });
