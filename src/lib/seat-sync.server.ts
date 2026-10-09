import { makeStripe } from "@/lib/stripe-client.server";
import { planLookupKey } from "@/lib/stripe-lookup-keys";
import { loadPriceCatalog, resolvePriceIdSet } from "@/lib/stripe-price-catalog.server";
import { isDemoOrganization } from "@/lib/demo-org";
import {
  arrearsFrom,
  changeoverMarker,
  periodBoundaryIso,
  seatPeriodAt,
  subscriptionPeriod,
  type SeatPeriod,
} from "@/lib/seat-rule";
import type Stripe from "stripe";

// What a subscription needs before its seats can be charged by period, and the
// plan facts the charge is made from.
//
// HOW SEATS ARE CHARGED is written down in `seat-rule.ts` and nowhere else;
// read that first. In one line: a seat is anybody who used their login in a
// one-month seat period, and each period is charged once, after it closes, as
// its own dated invoice line (seat-charges.server.ts).
//
// So the licensed seat subscription item is retired. It used to hold a
// headcount (`staff.active = true`) that Stripe charged IN ADVANCE at every
// renewal and prorated in between. `syncOrgSeatQuantity` keeps its name, for
// its callers, but what it does now is the CHANGEOVER: it marks the
// subscription with the moment its prepaid seats run out
// (`seat_arrears_from`, see seat-rule.ts), deletes the seat item with no
// proration -- the period it paid for stays paid, no credit -- and records the
// seat period the org is in. Run on every subscription by the first nightly
// sweep after this ships, and again whenever a staff toggle, an accepted
// invite, a billing-page refresh, a plan switch or a renewal invoice comes by.
// Once done it is a no-op apart from the period it records.
//
// Truth about the PLAN and the PERIOD is read from Stripe (the subscription's
// own line items and dates) so we never depend on organizations.plan_id being
// maintained. Runs with the service role and is best-effort at every call site.

export type SeatSyncResult =
  | { synced: true; quantity: number; changed: boolean }
  | { skipped: string };

const SUB_RE = /^sub_[A-Za-z0-9]{6,}/;

/** The plan facts a seat charge is made from. */
export type SeatPlan = {
  slug: string | null;
  includedSeats: number;
  /** The plan's per-seat price for ONE MONTH. Yearly plans are charged month
   *  by month at this price too. */
  unitAmountCents: number;
  /** Every price that is, or was, a licensed seat line for this plan: the
   *  items the changeover deletes. */
  seatPriceIds: Set<string>;
};

function priceIdOf(item: { price?: string | { id: string } | null }): string | null {
  if (!item.price) return null;
  return typeof item.price === "string" ? item.price : item.price.id;
}

type PlanRow = {
  slug: string | null;
  included_seats: number | null;
  price_per_seat_cents: number | null;
  stripe_price_id: string | null;
  stripe_annual_price_id: string | null;
  stripe_seat_price_id: string | null;
  stripe_annual_seat_price_id: string | null;
};

/**
 * Which per-employee plan this subscription is on, found by its base price.
 * Null for a legacy per-client plan (no seat price at all), which is never
 * charged for seats.
 *
 * Matching goes through the price CATALOG rather than asking the database for
 * a row whose stored id equals one on the subscription: every stored id is a
 * live id, so under a test key that matched nothing and looked exactly like a
 * legacy plan. Resolving by lookup key finds the plan in whichever account the
 * subscription lives in; the stored ids stay in each set so a subscription
 * created before the keys existed still matches.
 */
export async function resolveSeatPlan(
  stripe: Stripe,
  sub: Stripe.Subscription,
  admin: unknown,
): Promise<SeatPlan | null> {
  const priceIds = (sub.items?.data ?? [])
    .map((i) => priceIdOf(i as never))
    .filter((id): id is string => !!id);
  if (!priceIds.length) return null;

  const catalog = await loadPriceCatalog(stripe);
  const { data: planRows } = await (admin as PlansDb)
    .from("platform_plans")
    .select(
      "slug, included_seats, price_per_seat_cents, stripe_seat_price_id, stripe_price_id, stripe_annual_price_id, stripe_annual_seat_price_id",
    );

  for (const p of (planRows ?? []) as PlanRow[]) {
    // A legacy per-client plan has no seat price at all and must never be
    // charged for seats.
    if (!p.stripe_seat_price_id || p.included_seats == null) continue;
    const slug = p.slug;
    const ids = (kind: Parameters<typeof planLookupKey>[1], stored: string | null) =>
      resolvePriceIdSet(catalog, slug ? [planLookupKey(slug, kind)] : [], [stored]);
    const onPlan =
      priceIds.some((id) => ids("base_monthly", p.stripe_price_id).has(id)) ||
      priceIds.some((id) => ids("base_annual", p.stripe_annual_price_id).has(id));
    if (!onPlan) continue;
    // Membership tests, so a seat price archived in Stripe while a
    // subscription still carries it is still recognised and removed.
    const seatPriceIds = new Set([
      ...ids("seat_monthly", p.stripe_seat_price_id),
      ...ids("seat_annual", p.stripe_annual_seat_price_id),
    ]);
    return {
      slug,
      includedSeats: p.included_seats,
      unitAmountCents: p.price_per_seat_cents ?? 0,
      seatPriceIds,
    };
  }
  return null;
}

type PlansDb = {
  from: (t: "platform_plans") => {
    select: (c: string) => PromiseLike<{ data: unknown[] | null }>;
  };
};

/** The licensed seat items still on a subscription. */
export function seatItemsOn(sub: Stripe.Subscription, plan: SeatPlan): Stripe.SubscriptionItem[] {
  return (sub.items?.data ?? []).filter((i) => {
    const id = priceIdOf(i as never);
    return !!id && plan.seatPriceIds.has(id);
  });
}

/**
 * The changeover, idempotent. A subscription with no marker, or one still
 * carrying a licensed seat line, has had (or is about to have) the seats of
 * the period it is in charged IN ADVANCE; per-period charging starts when that
 * period ends. `prepaidThrough` lets a caller that knows better -- the renewal
 * webhook, looking at a draft invoice that already holds an in-advance seat
 * line -- push that moment later. Never earlier: a period is never charged
 * twice.
 *
 * Writes the marker BEFORE deleting the item: if the delete then fails, the
 * next run sees the item and pushes the marker to the end of the period the
 * item was charged for, so the worst case is a period left uncharged, never
 * one charged twice.
 */
export async function prepareSeatBilling(
  stripe: Stripe,
  sub: Stripe.Subscription,
  plan: SeatPlan,
  opts: { prepaidThrough?: number | null } = {},
): Promise<{ markedFrom: number | null; removed: number; changed: boolean }> {
  const period = subscriptionPeriod(sub);
  const items = seatItemsOn(sub, plan);
  const current = arrearsFrom((sub.metadata ?? {}) as Record<string, string>);
  const chargedInAdvance = items.some((i) => (i.quantity ?? 0) > 0);

  let target = current;
  if (current === null || chargedInAdvance) {
    if (period) target = Math.max(current ?? 0, period.end);
  }
  if (opts.prepaidThrough != null) target = Math.max(target ?? 0, opts.prepaidThrough);

  let changed = false;
  if (target !== null && target !== current) {
    await stripe.subscriptions.update(sub.id, { metadata: changeoverMarker(target) });
    changed = true;
  }
  for (const item of items) {
    // No proration: the period this item paid for stays paid, no credit
    // (owner, 2026-10-09). And none charged: it is being removed, not resized.
    await stripe.subscriptionItems.del(item.id, { proration_behavior: "none" });
    changed = true;
  }
  return { markedFrom: target, removed: items.length, changed };
}

/**
 * Make sure one org's subscription is ready to be charged by seat period, and
 * record the seat period it is in. Safe no-op when the org has no live
 * subscription, isn't on a per-employee plan, or is the demo org (or any comped
 * org). Never throws for "nothing to do" — only a real Stripe/DB failure
 * propagates (callers wrap in try/catch). `quantity` is always 0 now: no seat
 * quantity is held on the subscription any more.
 */
export async function syncOrgSeatQuantity(orgId: string): Promise<SeatSyncResult> {
  const secret = process.env.PLATFORM_STRIPE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
  if (!secret) return { skipped: "stripe_not_configured" };

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: org } = await supabaseAdmin
    .from("organizations")
    .select("stripe_subscription_id, slug, is_comped")
    .eq("id", orgId)
    .maybeSingle();
  // The demo org (and any comped org -- one definition, demo-org.ts) is never
  // charged for seats, whatever its subscription id looks like.
  if (isDemoOrganization(org as { slug?: string | null; is_comped?: boolean | null } | null)) {
    return { skipped: "demo_org" };
  }
  const subId = (org as { stripe_subscription_id?: string | null } | null)?.stripe_subscription_id;
  if (!subId || !SUB_RE.test(subId) || subId.includes("demo")) return { skipped: "no_subscription" };

  const stripe = await makeStripe(secret);
  const sub = await stripe.subscriptions.retrieve(subId, { expand: ["items.data.price"] });
  if (sub.status === "canceled" || sub.status === "incomplete_expired") {
    return { skipped: `status_${sub.status}` };
  }

  const plan = await resolveSeatPlan(stripe, sub, supabaseAdmin);
  if (!plan) return { skipped: "not_per_employee_plan" };

  const r = await prepareSeatBilling(stripe, sub, plan);
  if (typeof sub.billing_cycle_anchor === "number") {
    await recordSeatPeriod(
      supabaseAdmin,
      orgId,
      seatPeriodAt(sub.billing_cycle_anchor, Math.floor(Date.now() / 1000)),
    );
  }
  return { synced: true, quantity: 0, changed: r.changed };
}

/** The calls this file makes that the generated types do not know yet. */
type SeatDb = {
  rpc: (
    fn: "billable_seat_count",
    args: { _org_id: string; _from: string; _to?: string },
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  from: (table: "org_seat_periods") => {
    upsert: (
      row: Record<string, unknown>,
      opts: { onConflict: string },
    ) => PromiseLike<{ error: { message: string } | null }>;
  };
};

/**
 * People seen in the org in [from, to) (epoch seconds), from staff_seen_days.
 * Throws when the count cannot be read: a failed count read as zero would
 * charge nobody, silently.
 */
export async function billableSeatsBetween(
  admin: unknown,
  orgId: string,
  from: number,
  to?: number,
): Promise<number> {
  const { data, error } = await (admin as SeatDb).rpc("billable_seat_count", {
    _org_id: orgId,
    _from: periodBoundaryIso(from),
    ...(to != null ? { _to: periodBoundaryIso(to) } : {}),
  });
  if (error) throw new Error(`billable_seat_count: ${error.message}`);
  const n = Number(data);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Remember the seat period an org is in, so a sighting after a period boundary
 * is recorded for the new period, and the nightly sweep can skip an org whose
 * period has not closed. Best-effort.
 */
export async function recordSeatPeriod(
  admin: unknown,
  orgId: string,
  period: SeatPeriod,
): Promise<void> {
  try {
    const { error } = await (admin as SeatDb).from("org_seat_periods").upsert(
      {
        organization_id: orgId,
        period_start: periodBoundaryIso(period.start),
        period_end: periodBoundaryIso(period.end),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id" },
    );
    if (error) console.error("org_seat_periods write failed", orgId, error.message);
  } catch (e) {
    console.error("org_seat_periods write failed", orgId, (e as Error).message);
  }
}
