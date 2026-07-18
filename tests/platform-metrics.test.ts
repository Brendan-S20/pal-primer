import { describe, expect, it } from "vitest";
import {
  computePlatformSaasMetrics,
  monthlyEquivalentCents,
  type OrgForMrr,
  type PlanForMrr,
} from "@/lib/platform-metrics";
import { isValidOrgName } from "@/lib/dna-linkage";

// Catalog rows mirror the live platform_plans (H5 fixture).
const SCALE: PlanForMrr = {
  slug: "scale", name: "Scale", price_cents: 44900, annual_price_cents: 449000,
  interval: "month", included_seats: 30, price_per_seat_cents: 1000, is_free: false,
};
const GROWTH: PlanForMrr = {
  slug: "growth", name: "Growth", price_cents: 19900, annual_price_cents: 199000,
  interval: "month", included_seats: 10, price_per_seat_cents: 1000, is_free: false,
};
const LAUNCH: PlanForMrr = {
  slug: "launch", name: "Launch", price_cents: 7900, annual_price_cents: 79000,
  interval: "month", included_seats: 3, price_per_seat_cents: 1000, is_free: false,
};

// The live demo tenant: on Scale ($449/mo), 4 seats (within 30 included), active.
const DEMO: OrgForMrr = {
  id: "demo", name: "Demo Pet Waste Co", billing_status: "active",
  active_seat_count: 4, plan: SCALE,
};
// Free tenants on the client-count freemium tier — pay HoundStack nothing.
const FREE_ORGS: OrgForMrr[] = Array.from({ length: 6 }, (_, i) => ({
  id: `free${i}`, name: `Free Co ${i}`, billing_status: "free",
  active_seat_count: 1, plan: LAUNCH,
}));

// What the demo tenant collected from ITS OWN clients this period (the `payments`
// table): 17500 + 14000 + 17500 + 30000 + 17500 = 96500 = $965.00. This is GMV.
const TENANT_CLIENT_COLLECTIONS_CENTS = 17500 + 14000 + 17500 + 30000 + 17500;

describe("platform SaaS MRR is derived from subscriptions, not tenant collections (H5 / I13 #19)", () => {
  it("MRR = the demo tenant's monthly Scale price, NOT its client collections (GMV)", () => {
    const m = computePlatformSaasMetrics([DEMO, ...FREE_ORGS]);
    // $449/mo from the Scale subscription; 4 seats < 30 included → no overage.
    expect(m.mrrCents).toBe(44900);
    // The load-bearing assertion: platform MRR must never equal summed GMV.
    expect(TENANT_CLIENT_COLLECTIONS_CENTS).toBe(96500); // $965 — the old wrong number
    expect(m.mrrCents).not.toBe(TENANT_CLIENT_COLLECTIONS_CENTS);
  });

  it("ARR is exactly MRR × 12 (one shared computation, no 3-month averaging drift)", () => {
    const m = computePlatformSaasMetrics([DEMO, ...FREE_ORGS]);
    expect(m.arrCents).toBe(m.mrrCents * 12);
    expect(m.arrCents).toBe(538800);
  });

  it("free tenants contribute nothing regardless of an attached plan", () => {
    expect(monthlyEquivalentCents(FREE_ORGS[0])).toBe(0);
    const m = computePlatformSaasMetrics(FREE_ORGS);
    expect(m.mrrCents).toBe(0);
    expect(m.payingTenants).toBe(0);
  });

  it("suspended / canceled tenants do not count toward MRR", () => {
    expect(monthlyEquivalentCents({ ...DEMO, billing_status: "suspended" })).toBe(0);
    expect(monthlyEquivalentCents({ ...DEMO, billing_status: "canceled" })).toBe(0);
  });

  it("seat overage is billed beyond the plan's included seats", () => {
    // 34 seats on Scale (30 included) → 4 extra × $10 = $40 on top of $449.
    expect(monthlyEquivalentCents({ ...DEMO, active_seat_count: 34 })).toBe(44900 + 4 * 1000);
  });

  it("annual plans are divided by 12", () => {
    const annualScale: PlanForMrr = { ...SCALE, interval: "year" };
    const org: OrgForMrr = { ...DEMO, plan: annualScale };
    // $4,490/yr → $374.17/mo (rounded), no seat overage.
    expect(monthlyEquivalentCents(org)).toBe(Math.round(449000 / 12));
  });
});

describe("tier is keyed off the subscribed plan, not the stale billing_tier text (H5 #2)", () => {
  it("the demo tenant's tier reads Scale, and the breakdown shows one Scale org", () => {
    const m = computePlatformSaasMetrics([DEMO, ...FREE_ORGS]);
    expect(m.byTier).toHaveLength(1);
    expect(m.byTier[0].tier).toBe("scale");
    expect(m.byTier[0].tier_name).toBe("Scale");
    expect(m.byTier[0].mrr_cents).toBe(44900);
    expect(m.byTier[0].count).toBe(1);
    // It must NOT be labeled Growth (the stale-column bug).
    expect(m.byTier[0].tier).not.toBe("growth");
  });

  it("per-tier MRR splits across mixed paying tiers", () => {
    const growthOrg: OrgForMrr = {
      id: "g", name: "Growth Co", billing_status: "active", active_seat_count: 5, plan: GROWTH,
    };
    const m = computePlatformSaasMetrics([DEMO, growthOrg, ...FREE_ORGS]);
    expect(m.mrrCents).toBe(44900 + 19900);
    const scale = m.byTier.find((t) => t.tier === "scale");
    const growth = m.byTier.find((t) => t.tier === "growth");
    expect(scale?.mrr_cents).toBe(44900);
    expect(growth?.mrr_cents).toBe(19900);
  });
});

describe("signup org-name validation rejects junk tenants (H5 #4 / I11)", () => {
  it('rejects "Test Test", blanks, and all-junk names', () => {
    expect(isValidOrgName("Test Test")).toBe(false);
    expect(isValidOrgName("Test Test Test")).toBe(false);
    expect(isValidOrgName("test")).toBe(false);
    expect(isValidOrgName("  ")).toBe(false);
    expect(isValidOrgName("")).toBe(false);
    expect(isValidOrgName("1")).toBe(false);
  });

  it("accepts real business names", () => {
    expect(isValidOrgName("Demo Pet Waste Co")).toBe(true);
    expect(isValidOrgName("Mike's Scoop Squad")).toBe(true);
    expect(isValidOrgName("Test Client Services")).toBe(true); // has a real word
  });
});
