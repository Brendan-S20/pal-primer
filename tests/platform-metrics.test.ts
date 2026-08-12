import { describe, expect, it } from "vitest";
import {
  computePlatformSaasMetrics,
  monthlyEquivalentCents,
  addonMonthlyEquivalentCents,
  totalMonthlyEquivalentCents,
  type OrgForMrr,
  type PlanForMrr,
} from "@/lib/platform-metrics";
import { isValidOrgName } from "@/lib/dna-linkage";

// Catalog rows mirror the live platform_plans (H5 fixture).
const SCALE: PlanForMrr = {
  slug: "scale",
  name: "Scale",
  price_cents: 44900,
  annual_price_cents: 449000,
  interval: "month",
  included_seats: 30,
  price_per_seat_cents: 1000,
  is_free: false,
};
const GROWTH: PlanForMrr = {
  slug: "growth",
  name: "Growth",
  price_cents: 19900,
  annual_price_cents: 199000,
  interval: "month",
  included_seats: 10,
  price_per_seat_cents: 1000,
  is_free: false,
};
const LAUNCH: PlanForMrr = {
  slug: "launch",
  name: "Launch",
  price_cents: 7900,
  annual_price_cents: 79000,
  interval: "month",
  included_seats: 3,
  price_per_seat_cents: 1000,
  is_free: false,
};

// The live demo tenant: on Scale ($449/mo), 4 seats (within 30 included), active.
const DEMO: OrgForMrr = {
  id: "demo",
  name: "Demo Pet Waste Co",
  billing_status: "active",
  active_seat_count: 4,
  plan: SCALE,
};
// Free tenants on the client-count freemium tier — pay HoundStack nothing.
const FREE_ORGS: OrgForMrr[] = Array.from({ length: 6 }, (_, i) => ({
  id: `free${i}`,
  name: `Free Co ${i}`,
  billing_status: "free",
  active_seat_count: 1,
  plan: LAUNCH,
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

  it("annual→monthly conversion feeds MRR/ARR and still adds seat overage", () => {
    const annualScale: PlanForMrr = { ...SCALE, interval: "year" };
    // Seat overage stays on top of the monthly-equivalent base, and — like the
    // base — the annual plan's per-seat rate is a YEARLY charge, so it is also
    // divided by 12: 34 seats on Scale (30 included) → 4 × $10/yr → /12.
    expect(monthlyEquivalentCents({ ...DEMO, plan: annualScale, active_seat_count: 34 })).toBe(
      Math.round(449000 / 12) + Math.round((4 * 1000) / 12),
    );

    // The rollup uses the same conversion, so ARR of a single annual tenant is
    // 12 × its monthly equivalent (i.e. the annual price, up to rounding).
    const m = computePlatformSaasMetrics([{ ...DEMO, plan: annualScale }, ...FREE_ORGS]);
    expect(m.mrrCents).toBe(Math.round(449000 / 12));
    expect(m.arrCents).toBe(Math.round(449000 / 12) * 12);
  });

  it("an annual plan with no annual price falls back to price_cents / 12", () => {
    // Catalog rows mirroring a plan flipped to interval='year' before its
    // annual_price_cents was set: the base must not be double-counted.
    const partial: PlanForMrr = { ...SCALE, interval: "year", annual_price_cents: null };
    expect(monthlyEquivalentCents({ ...DEMO, plan: partial })).toBe(Math.round(44900 / 12));
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
      id: "g",
      name: "Growth Co",
      billing_status: "active",
      active_seat_count: 5,
      plan: GROWTH,
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

// BUG-11: the console reported MRR $449 for the demo tenant while its actual
// subscription billed $527 — recurring add-ons were not counted at all.
describe("recurring add-ons count toward platform MRR (BUG-11)", () => {
  const RECEPTIONIST = { status: "active", price_cents: 4900, billing_interval: "month" };
  const PRIORITY = { status: "active", price_cents: 2900, billing_interval: "month" };
  const SETUP = { status: "active", price_cents: 49900, billing_interval: "one_time" };

  it("reproduces the finding: $449 plan + $49 + $29 add-ons = $527", () => {
    const org: OrgForMrr = { ...DEMO, addons: [RECEPTIONIST, PRIORITY] };
    expect(monthlyEquivalentCents(org)).toBe(44900); // plan alone — the old number
    expect(addonMonthlyEquivalentCents(org)).toBe(7800);
    expect(totalMonthlyEquivalentCents(org)).toBe(52700); // $527.00
  });

  it("excludes ONE-TIME add-ons from a recurring metric", () => {
    // "Done-for-you setup" is $499 charged once. Folding it into MRR would
    // overstate monthly recurring revenue by more than a year of the plan.
    const org: OrgForMrr = { ...DEMO, addons: [SETUP] };
    expect(addonMonthlyEquivalentCents(org)).toBe(0);
    expect(totalMonthlyEquivalentCents(org)).toBe(44900);
  });

  it("excludes canceled add-ons, and add-ons on a non-paying tenant", () => {
    expect(
      addonMonthlyEquivalentCents({ ...DEMO, addons: [{ ...RECEPTIONIST, status: "canceled" }] }),
    ).toBe(0);
    expect(
      addonMonthlyEquivalentCents({
        ...DEMO,
        billing_status: "suspended",
        addons: [RECEPTIONIST],
      }),
    ).toBe(0);
  });

  it("divides an annual add-on by 12, and ignores an unrecognized interval", () => {
    expect(
      addonMonthlyEquivalentCents({
        ...DEMO,
        addons: [{ status: "active", price_cents: 12000, billing_interval: "year" }],
      }),
    ).toBe(1000);
    // Treating an unknown cadence as monthly is how a metric starts lying.
    expect(
      addonMonthlyEquivalentCents({
        ...DEMO,
        addons: [{ status: "active", price_cents: 5000, billing_interval: "fortnightly" }],
      }),
    ).toBe(0);
  });

  it("rolls the split up so plan + add-ons reconcile to the headline MRR", () => {
    const m = computePlatformSaasMetrics([
      { ...DEMO, addons: [RECEPTIONIST, PRIORITY, SETUP] },
      ...FREE_ORGS,
    ]);
    expect(m.planMrrCents).toBe(44900);
    expect(m.addonMrrCents).toBe(7800);
    expect(m.mrrCents).toBe(52700);
    expect(m.planMrrCents + m.addonMrrCents).toBe(m.mrrCents);
    expect(m.arrCents).toBe(52700 * 12);
    // Add-ons must not invent paying tenants.
    expect(m.payingTenants).toBe(1);
    expect(m.perOrg[0].plan_mrr_cents).toBe(44900);
    expect(m.perOrg[0].addon_mrr_cents).toBe(7800);
  });

  it("does not count a tenant that has add-ons but no priced plan", () => {
    const noPlan: OrgForMrr = {
      id: "x",
      name: "Add-ons only",
      billing_status: "active",
      active_seat_count: 1,
      plan: null,
      addons: [RECEPTIONIST],
    };
    const m = computePlatformSaasMetrics([noPlan]);
    expect(m.payingTenants).toBe(0);
    expect(m.mrrCents).toBe(0);
  });

  it("leaves orgs with no add-ons exactly as before", () => {
    expect(addonMonthlyEquivalentCents(DEMO)).toBe(0);
    expect(totalMonthlyEquivalentCents(DEMO)).toBe(monthlyEquivalentCents(DEMO));
  });
});

// The demo org is now comped: Enterprise plan, all six add-ons, no Stripe
// subscription, billing_status 'active' — because it is not a lapsed customer
// and must never be dunned. Every status-based test therefore says "paying",
// and its add-ons alone would have put $126/month into MRR that nobody sends
// us. BUG-11 was this defect pointing the other way (add-ons uncounted, $449
// reported for a tenant paying $527); understating and overstating are the
// same bug, and a metric that includes free accounts is not a revenue metric.
describe("comped tenants", () => {
  const COMPED: OrgForMrr = {
    ...DEMO,
    is_comped: true,
    addons: [
      { status: "active", price_cents: 4900, billing_interval: "month" },
      { status: "active", price_cents: 2900, billing_interval: "month" },
      { status: "active", price_cents: 49900, billing_interval: "one_time" },
    ],
  };

  it("contributes no plan revenue despite carrying a priced plan", () => {
    // Not because the plan is unpriced — Scale is $449 and the same org
    // contributes it the moment the flag comes off.
    expect(monthlyEquivalentCents(COMPED)).toBe(0);
    expect(monthlyEquivalentCents({ ...COMPED, is_comped: false })).toBe(44900);
  });

  it("contributes no add-on revenue despite carrying active add-ons", () => {
    expect(addonMonthlyEquivalentCents(COMPED)).toBe(0);
    expect(addonMonthlyEquivalentCents({ ...COMPED, is_comped: false })).toBe(7800);
  });

  it("is not counted as a paying tenant", () => {
    const m = computePlatformSaasMetrics([COMPED, ...FREE_ORGS]);
    expect(m.payingTenants).toBe(0);
    expect(m.mrrCents).toBe(0);
    expect(m.addonMrrCents).toBe(0);
    expect(m.arrCents).toBe(0);
  });

  it("does not drag real tenants down with it", () => {
    const paying: OrgForMrr = {
      id: "p",
      name: "Real Co",
      billing_status: "active",
      active_seat_count: 2,
      plan: GROWTH,
    };
    const m = computePlatformSaasMetrics([COMPED, paying]);
    expect(m.mrrCents).toBe(19900);
    expect(m.payingTenants).toBe(1);
  });

  it("treats an absent flag as false, so existing rows and fixtures are unchanged", () => {
    // The column is optional on the type for exactly this reason.
    expect(monthlyEquivalentCents(DEMO)).toBe(44900);
    expect(monthlyEquivalentCents({ ...DEMO, is_comped: null })).toBe(44900);
  });

  it("stays distinct from the freemium tier", () => {
    // 'free' gates client creation at 3 and feeds the conversion funnel on the
    // platform overview. A comped org is not a prospect who hasn't paid — if
    // comping were implemented by writing billing_status='free', the demo would
    // start appearing in the upgrade funnel and hit the client cap.
    expect(COMPED.billing_status).toBe("active");
  });
});
