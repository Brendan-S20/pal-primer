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

export type OrgForMrr = {
  id: string;
  name: string;
  billing_status: string | null; // active | grace | past_due | free | suspended | canceled
  active_seat_count: number | null;
  plan: PlanForMrr | null;
};

// A tenant contributes to MRR only while it is actually paying. `free` orgs (on
// the client-count freemium tier), `suspended`, and `canceled` orgs contribute
// nothing even if a plan is attached.
export const PAYING_STATUSES = ["active", "grace", "past_due"] as const;

export function isPayingStatus(status: string | null | undefined): boolean {
  return (PAYING_STATUSES as readonly string[]).includes(status ?? "");
}

/**
 * The monthly-equivalent SaaS price a single tenant pays HoundStack. Annual
 * plans are divided by 12. Seat overage (active seats beyond the plan's
 * included seats) is added at the per-seat rate. Returns 0 for non-paying orgs,
 * free plans, and custom/enterprise plans with no listed price (those are
 * negotiated off-catalog and cannot be derived from the plan row).
 */
export function monthlyEquivalentCents(org: OrgForMrr): number {
  const p = org.plan;
  if (!p) return 0;
  if (!isPayingStatus(org.billing_status)) return 0;
  if (p.is_free) return 0;
  if (p.price_cents == null && p.annual_price_cents == null) return 0; // custom/enterprise

  const base =
    p.interval === "year"
      ? Math.round((p.annual_price_cents ?? p.price_cents ?? 0) / 12)
      : (p.price_cents ?? 0);

  const seats = org.active_seat_count ?? 0;
  const included = p.included_seats ?? 0;
  const perSeat = p.price_per_seat_cents ?? 0;
  const overage = Math.max(0, seats - included) * perSeat;

  return base + overage;
}

export type PlatformSaasMetrics = {
  mrrCents: number;
  arrCents: number;
  payingTenants: number;
  perOrg: Array<{ id: string; name: string; mrr_cents: number }>;
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
  let payingTenants = 0;
  const perOrg: PlatformSaasMetrics["perOrg"] = [];
  const tiers = new Map<string, { tier: string; tier_name: string; mrr_cents: number; count: number }>();

  for (const o of orgs) {
    const m = monthlyEquivalentCents(o);
    if (m <= 0) continue;
    mrrCents += m;
    payingTenants += 1;
    perOrg.push({ id: o.id, name: o.name, mrr_cents: m });
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

  return { mrrCents, arrCents: mrrCents * 12, payingTenants, perOrg, byTier };
}
