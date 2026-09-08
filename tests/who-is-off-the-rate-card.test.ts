import { describe, it, expect } from "vitest";
import {
  computePricingDrift,
  sortBySeverity,
  type DriftSubscription,
  type DriftRow,
} from "@/lib/pricing-drift";

// The two zones that actually exist on the demo organization, copied from
// production on 2026-09-07. Westside is the interesting one: per_sqft at
// 0.75c/sqft with a $25 floor and NO ceiling, which is what produces the
// four-figure quotes the report has to surface.
const WESTSIDE = {
  id: "z-west",
  name: "Westside Suburb",
  base_price_cents: 2500,
  per_dog_addl_cents: 500,
  pricing_mode: "per_sqft" as const,
  price_per_sqft_cents: 0.75,
  price_per_acre_cents: 0,
  area_min_charge_cents: 2500,
  area_max_charge_cents: null,
};

const DOWNTOWN = {
  id: "z-down",
  name: "Downtown Core",
  base_price_cents: 2500,
  per_dog_addl_cents: 500,
  pricing_mode: "flat" as const,
  price_per_sqft_cents: 0,
  price_per_acre_cents: 0,
  area_min_charge_cents: 0,
  area_max_charge_cents: null,
};

const MULTS = { weekly: 1, biweekly: 1.7, twice_weekly: 1.8, monthly: 3.2 };

function sub(over: Partial<DriftSubscription> = {}): DriftSubscription {
  return {
    id: "s1",
    clientId: "c1",
    clientName: "A Client",
    frequency: "weekly",
    priceCents: 2500,
    dogCount: 1,
    zone: DOWNTOWN,
    boundaryAreaSqm: null,
    pricedAt: null,
    pricedFromZoneId: null,
    priceOverriddenAt: null,
    ...over,
  };
}

describe("what the rate card says today", () => {
  it("calls a service on the card on_rate, with a zero difference", () => {
    const { rows, summary } = computePricingDrift([sub()], MULTS);
    expect(rows[0].outcome).toBe("on_rate");
    expect(rows[0].diffCents).toBe(0);
    expect(rows[0].todayCents).toBe(2500);
    expect(summary.onRate).toBe(1);
  });

  it("applies the frequency multiplier, so biweekly is compared against the biweekly rate", () => {
    // $25 flat x 1.7 = $42.50. A customer paying the weekly $25 for a biweekly
    // service is underpriced by $17.50, which is three real Downtown Core
    // customers in production.
    const { rows } = computePricingDrift(
      [sub({ frequency: "biweekly", priceCents: 2500 })],
      MULTS,
    );
    expect(rows[0].todayCents).toBe(4250);
    expect(rows[0].diffCents).toBe(1750);
    expect(rows[0].outcome).toBe("under");
  });

  it("falls back to a multiplier of 1 for a frequency the org has not configured", () => {
    const { rows } = computePricingDrift([sub({ frequency: "fortnightly" })], MULTS);
    expect(rows[0].todayCents).toBe(2500);
    expect(rows[0].outcome).toBe("on_rate");
  });

  it("counts paying more than the card as over, with a negative difference", () => {
    const { rows, summary } = computePricingDrift([sub({ priceCents: 9000 })], MULTS);
    expect(rows[0].outcome).toBe("over");
    expect(rows[0].diffCents).toBe(-6500);
    expect(summary.over).toBe(1);
    expect(summary.overSumCents).toBe(-6500);
  });

  it("reproduces the 18x Westside fault from real data", () => {
    // 35,700 sqft at 0.75c = $267.75, floored at $25 so the floor does not
    // bind, plus the $25 base = $292.75/visit, x1.7 biweekly = $497.68.
    // The customer pays $26.00.
    const areaSqm = 35700 / 10.7639;
    const { rows } = computePricingDrift(
      [sub({ zone: WESTSIDE, boundaryAreaSqm: areaSqm, frequency: "biweekly", priceCents: 2600 })],
      MULTS,
    );
    expect(rows[0].outcome).toBe("under");
    expect(rows[0].ratio).toBeGreaterThan(18);
    expect(rows[0].areaCapped).toBe(false);
  });

  it("reports areaCapped when a ceiling binds the area charge down", () => {
    const areaSqm = 35700 / 10.7639;
    const capped = { ...WESTSIDE, area_max_charge_cents: 5000 };
    const { rows } = computePricingDrift(
      [sub({ zone: capped, boundaryAreaSqm: areaSqm, priceCents: 2600 })],
      MULTS,
    );
    // $25 base + $50 capped area = $75.
    expect(rows[0].todayCents).toBe(7500);
    expect(rows[0].areaCapped).toBe(true);
  });
});

describe("a property in no zone", () => {
  it("is its own outcome, not on_rate and not a zero difference", () => {
    const { rows, summary } = computePricingDrift([sub({ zone: null })], MULTS);
    expect(rows[0].outcome).toBe("no_zone");
    expect(rows[0].todayCents).toBeNull();
    expect(rows[0].diffCents).toBeNull();
    expect(rows[0].ratio).toBeNull();
    expect(summary.noZone).toBe(1);
    expect(summary.onRate).toBe(0);
    expect(summary.under).toBe(0);
    expect(summary.over).toBe(0);
  });

  it("does not inflate the totals of the rows that do have a zone", () => {
    // Two identical $90 services, one unzoned. Only the zoned one is over the
    // card, and only its gap reaches the money total.
    //
    // Worth being honest about what this does and does not pin. It holds the
    // counts apart -- noZone is not folded into over -- but it does NOT catch
    // summing by the sign of diffCents instead of by outcome, because a
    // no_zone row's diffCents is null and `(null ?? 0) < 0` is false, so both
    // versions exclude it for the same reason. The assertion that catches
    // pricing an absent zone at zero is the todayCents/diffCents null check in
    // the test above; this one guards the counts, not that.
    const { summary } = computePricingDrift(
      [sub({ zone: null, priceCents: 9000 }), sub({ id: "s2", priceCents: 9000 })],
      MULTS,
    );
    expect(summary.overSumCents).toBe(-6500);
    expect(summary.over).toBe(1);
    expect(summary.noZone).toBe(1);
    expect(summary.total).toBe(2);
  });
});

describe("a price a person typed", () => {
  it("is flagged handPriced so a bulk change can leave it alone", () => {
    const { rows, summary } = computePricingDrift(
      [sub({ priceCents: 9000, priceOverriddenAt: "2026-08-01T00:00:00Z" })],
      MULTS,
    );
    expect(rows[0].handPriced).toBe(true);
    expect(summary.handPriced).toBe(1);
  });

  it("still reports its drift, because a deliberate price can still be stale", () => {
    const { rows } = computePricingDrift(
      [sub({ priceCents: 9000, priceOverriddenAt: "2026-08-01T00:00:00Z" })],
      MULTS,
    );
    expect(rows[0].outcome).toBe("over");
    expect(rows[0].diffCents).toBe(-6500);
  });

  it("is not inferred from priced_at alone", () => {
    // priced_at says when the price was set, not that a human overruled the
    // card. Conflating them would mark every recorded price as hand-priced and
    // exclude the whole book from any bulk change.
    const { rows } = computePricingDrift(
      [sub({ pricedAt: "2026-08-01T00:00:00Z", pricedFromZoneId: "z-down" })],
      MULTS,
    );
    expect(rows[0].handPriced).toBe(false);
  });
});

describe("severity ordering", () => {
  const rows: DriftRow[] = [
    { ratio: 1.2, subscriptionId: "small-dollars-big-none" } as DriftRow,
    { ratio: 18.8, subscriptionId: "the-18x" } as DriftRow,
    { ratio: null, subscriptionId: "unzoned" } as DriftRow,
    { ratio: 0.28, subscriptionId: "paying-3.5x-the-card" } as DriftRow,
  ];

  it("puts the worst ratio first, not the biggest dollar gap", () => {
    expect(sortBySeverity(rows)[0].subscriptionId).toBe("the-18x");
  });

  it("ranks paying a third of the card near paying triple it", () => {
    // The mutation this guards: sorting on `ratio` descending, which puts
    // every overpriced row at the bottom and turns the report into a
    // collections tool that cannot see a customer being overcharged.
    const sorted = sortBySeverity(rows);
    expect(sorted[1].subscriptionId).toBe("paying-3.5x-the-card");
    expect(sorted[2].subscriptionId).toBe("small-dollars-big-none");
  });

  it("sorts unrankable rows last", () => {
    expect(sortBySeverity(rows)[3].subscriptionId).toBe("unzoned");
  });

  it("does not mutate its input", () => {
    const before = rows.map((r) => r.subscriptionId);
    sortBySeverity(rows);
    expect(rows.map((r) => r.subscriptionId)).toEqual(before);
  });
});

describe("a customer paying nothing", () => {
  it("has no ratio rather than an infinite one", () => {
    const { rows } = computePricingDrift([sub({ priceCents: 0 })], MULTS);
    expect(rows[0].ratio).toBeNull();
    expect(rows[0].outcome).toBe("under");
    expect(rows[0].diffCents).toBe(2500);
  });
});
