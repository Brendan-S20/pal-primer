// Authoritative platform (SaaS) revenue math — the ONE place MRR/ARR are
// derived from what TENANTS PAY HOUNDSTACK (their platform subscription plan),
// never from what tenants collect from their own clients (that is GMV, and it
// lives in the `payments` / tenant `invoices` tables). See QA round 3 H5 / I13
// #19: platform MRR must NOT equal summed tenant collections.
//
// Pure functions, no I/O — shared by the Overview + Revenue server functions
// AND the test suite so all three surfaces (Overview MRR, Revenue ARR, the tier
// breakdown) agree by construction (I3/I4).

export type PlanForMrr = {
  slug: string | null;
  name: string | null;
  price_cents: number | null; // monthly base for interval='month' plans
  annual_price_cents: number | null; // yearly base for annual billing
  interval: string | null; // 'month' | 'year'
  included_seats: number | null;
  price_per_seat_cents: number | null;
  is_free: boolean | null;
};

/** A platform add-on a tenant subscribes to. This is SaaS revenue — the tenant
 *  paying HoundStack — so it belongs in MRR, and it is NOT tenant GMV. */
export type AddonForMrr = {
  status: string | null; // active | canceled
  price_cents: number | null;
  billing_interval: string | null; // 'month' | 'year' | 'one_time'
};

export type OrgForMrr = {
  id: string;
  name: string;
  billing_status: string | null; // active | grace | past_due | free | suspended | canceled
  active_seat_count: number | null;
  plan: PlanForMrr | null;
  /** Optional so existing callers and fixtures stay valid; absent means none. */
  addons?: AddonForMrr[] | null;
  /** Platform-granted free use — the demo org, design partners, internal
   *  accounts. Optional for the same reason as `addons`; absent means false. */
  is_comped?: boolean | null;
};

// A tenant contributes to MRR only while it is actually paying. `free` orgs (on
// the client-count freemium tier), `suspended`, and `canceled` orgs contribute
// nothing even if a plan is attached.
export const PAYING_STATUSES = ["active", "grace", "past_due"] as const;

export function isPayingStatus(status: string | null | undefined): boolean {
  return (PAYING_STATUSES as readonly string[]).includes(status ?? "");
}

/**
 * Does this org contribute money at all?
 *
 * A comped org — the demo account, a design partner, an internal workspace —
 * has a real plan and real add-ons and pays for neither. It is billing_status
 * 'active' because it is not a lapsed customer and must never be dunned, which
 * means every status-based test says "paying". Only this flag distinguishes
 * "active and billed" from "active and free", and without it the demo org alone
 * put $126/month of add-on revenue into MRR that nobody pays.
 *
 * It is deliberately NOT the same as billing_status 'free': that is the
 * freemium client-count tier, which gates client creation and feeds the
 * conversion funnel. A comped org is not a prospect who hasn't paid yet.
 */
export function contributesRevenue(org: OrgForMrr): boolean {
  if (org.is_comped) return false;
  return isPayingStatus(org.billing_status);
}

/**
 * The monthly-equivalent SaaS price a single tenant pays HoundStack. Annual
 * plans are divided by 12. Seat overage (active seats beyond the plan's
 * included seats) is added at the per-seat rate. Returns 0 for non-paying orgs,
 * comped orgs, free plans, and custom/enterprise plans with no listed price
 * (those are negotiated off-catalog and cannot be derived from the plan row).
 */
export function monthlyEquivalentCents(org: OrgForMrr): number {
  const p = org.plan;
  if (!p) return 0;
  if (!contributesRevenue(org)) return 0;
  if (p.is_free) return 0;
  if (p.price_cents == null && p.annual_price_cents == null) return 0; // custom/enterprise

  const base =
    p.interval === "year"
      ? Math.round((p.annual_price_cents ?? p.price_cents ?? 0) / 12)
      : (p.price_cents ?? 0);

  const seats = org.active_seat_count ?? 0;
  const included = p.included_seats ?? 0;
  const perSeat = p.price_per_seat_cents ?? 0;
  // price_per_seat_cents is denominated in the plan's billing interval, so an
  // annual plan's seat overage is a YEARLY charge — divide by 12 for MRR just
  // like the base price.
  const overageRaw = Math.max(0, seats - included) * perSeat;
  const overage = p.interval === "year" ? Math.round(overageRaw / 12) : overageRaw;

  return base + overage;
}

/**
 * BUG-11: recurring add-on revenue a tenant pays HoundStack, as a monthly
 * equivalent. The console reported MRR of $449 for a tenant whose subscription
 * actually bills $527, because add-ons were simply not counted.
 *
 * Two rules do the real work here:
 *  - ONE-TIME add-ons are excluded. "Done-for-you setup" at $499 is a single
 *    charge; folding it into a *recurring* revenue metric would overstate MRR
 *    by more than a year of the plan itself.
 *  - Only ACTIVE subscriptions count. A canceled add-on stops contributing,
 *    the same rule isPayingStatus applies to the plan.
 *
 * Gated on the org being in a paying status at all, so a suspended tenant does
 * not contribute add-on revenue while contributing no plan revenue.
 */
export function addonMonthlyEquivalentCents(org: OrgForMrr): number {
  if (!contributesRevenue(org)) return 0;
  let total = 0;
  for (const a of org.addons ?? []) {
    if (a.status !== "active") continue;
    const price = a.price_cents ?? 0;
    if (price <= 0) continue;
    if (a.billing_interval === "year") total += Math.round(price / 12);
    else if (a.billing_interval === "month") total += price;
    // one_time (and anything unrecognized) contributes nothing to a RECURRING
    // metric. Unrecognized intervals are excluded on purpose: silently
    // treating an unknown cadence as monthly is how a metric starts lying.
  }
  return total;
}

/** What a tenant pays HoundStack per month, all in: plan + recurring add-ons. */
export function totalMonthlyEquivalentCents(org: OrgForMrr): number {
  return monthlyEquivalentCents(org) + addonMonthlyEquivalentCents(org);
}

export type PlatformSaasMetrics = {
  /** Plan + recurring add-ons. The headline number. */
  mrrCents: number;
  /** The split, so the console can show where the money comes from and a
   *  plan-only figure stays available rather than being lost (BUG-11). */
  planMrrCents: number;
  addonMrrCents: number;
  arrCents: number;
  payingTenants: number;
  perOrg: Array<{
    id: string;
    name: string;
    mrr_cents: number;
    plan_mrr_cents: number;
    addon_mrr_cents: number;
  }>;
  byTier: Array<{ tier: string; tier_name: string; mrr_cents: number; count: number }>;
};

/**
 * Roll up MRR, ARR, per-org contribution, and a plan-tier breakdown from the
 * tenant subscriptions. Tier is keyed off the org's actual plan (plan_id →
 * platform_plans), NOT the stale denormalized `billing_tier` text column that
 * made the console show "Growth" for a Scale tenant.
 */
export function computePlatformSaasMetrics(orgs: OrgForMrr[]): PlatformSaasMetrics {
  let mrrCents = 0;
  let planMrrCents = 0;
  let addonMrrCents = 0;
  let payingTenants = 0;
  const perOrg: PlatformSaasMetrics["perOrg"] = [];
  const tiers = new Map<string, { tier: string; tier_name: string; mrr_cents: number; count: number }>();

  for (const o of orgs) {
    const planM = monthlyEquivalentCents(o);
    const addonM = addonMonthlyEquivalentCents(o);
    const m = planM + addonM;
    // Still keyed on the PLAN being paid: a tenant with add-ons but no priced
    // plan isn't a paying subscriber, and counting it would inflate the tenant
    // count against a tier that doesn't exist.
    if (planM <= 0) continue;
    mrrCents += m;
    planMrrCents += planM;
    addonMrrCents += addonM;
    payingTenants += 1;
    perOrg.push({
      id: o.id,
      name: o.name,
      mrr_cents: m,
      plan_mrr_cents: planM,
      addon_mrr_cents: addonM,
    });
    const tier = o.plan?.slug ?? "unassigned";
    const existing = tiers.get(tier) ?? {
      tier,
      tier_name: o.plan?.name ?? "Unassigned",
      mrr_cents: 0,
      count: 0,
    };
    existing.mrr_cents += m;
    existing.count += 1;
    tiers.set(tier, existing);
  }

  perOrg.sort((a, b) => b.mrr_cents - a.mrr_cents);
  const byTier = Array.from(tiers.values()).sort((a, b) => b.mrr_cents - a.mrr_cents);

  return {
    mrrCents,
    planMrrCents,
    addonMrrCents,
    arrCents: mrrCents * 12,
    payingTenants,
    perOrg,
    byTier,
  };
}
