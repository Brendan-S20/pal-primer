import { describe, expect, it } from "vitest";
import { computeZoneVisitPrice } from "@/lib/pricing";

// The "Downtown Commercial" zone from finding #3: $20 base + $5/extra dog +
// $5.00/acre, drawn boundary of 2,472 sq ft (~229.66 m² ≈ 0.0567 acres).
const DOWNTOWN_COMMERCIAL = {
  base_price_cents: 2000,
  per_dog_addl_cents: 500,
  pricing_mode: "per_acre" as const,
  price_per_sqft_cents: 0,
  price_per_acre_cents: 500,
  area_min_charge_cents: 0,
};

describe("computeZoneVisitPrice (finding #3)", () => {
  it("includes the base price alongside the per-acre component (the QA repro)", () => {
    const sqm = 2472 / 10.7639; // 2,472 sq ft
    const r = computeZoneVisitPrice(DOWNTOWN_COMMERCIAL, { dogCount: 1, boundaryAreaSqm: sqm });
    expect(r.areaBasisCents).toBe(28); // acreage component alone ≈ $0.28
    expect(r.perVisitCents).toBe(2028); // $20.00 base + $0.28 acreage — not $0.28
  });

  it("adds per-extra-dog on top of base + area", () => {
    const sqm = 2472 / 10.7639;
    const r = computeZoneVisitPrice(DOWNTOWN_COMMERCIAL, { dogCount: 3, boundaryAreaSqm: sqm });
    expect(r.perVisitCents).toBe(2028 + 2 * 500);
  });

  it("applies the area minimum charge to the area component only", () => {
    const zone = { ...DOWNTOWN_COMMERCIAL, area_min_charge_cents: 1500 };
    const sqm = 2472 / 10.7639;
    const r = computeZoneVisitPrice(zone, { dogCount: 1, boundaryAreaSqm: sqm });
    expect(r.perVisitCents).toBe(2000 + 1500);
  });

  it("prices flat zones from base price alone", () => {
    const r = computeZoneVisitPrice(
      { ...DOWNTOWN_COMMERCIAL, pricing_mode: "flat" },
      { dogCount: 2, boundaryAreaSqm: 500 },
    );
    expect(r.perVisitCents).toBe(2500);
  });

  it("falls back to base price when an area zone has no drawn boundary", () => {
    const r = computeZoneVisitPrice(DOWNTOWN_COMMERCIAL, { dogCount: 1 });
    expect(r.perVisitCents).toBe(2000);
    expect(r.areaBasisCents).toBeNull();
  });

  it("computes per-sqft zones as base + sqft rate", () => {
    const zone = {
      ...DOWNTOWN_COMMERCIAL,
      pricing_mode: "per_sqft" as const,
      price_per_sqft_cents: 1,
      price_per_acre_cents: 0,
    };
    const sqm = 1000 / 10.7639; // 1,000 sq ft
    const r = computeZoneVisitPrice(zone, { dogCount: 1, boundaryAreaSqm: sqm });
    expect(r.perVisitCents).toBe(2000 + 1000);
  });

  it("applies the frequency multiplier to the full per-visit price", () => {
    const sqm = 2472 / 10.7639;
    const r = computeZoneVisitPrice(DOWNTOWN_COMMERCIAL, {
      dogCount: 1,
      boundaryAreaSqm: sqm,
      multiplier: 0.9,
    });
    expect(r.recurringCents).toBe(Math.round(2028 * 0.9));
  });
});
