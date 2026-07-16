import { describe, expect, it } from "vitest";
import {
  computeCommercialZonePrice,
  zoneHasCommercialPricing,
  SQM_PER_ACRE,
} from "@/lib/pricing";

// An HOA zone: $100 base + $3.50 per unit + $40 per acre of grounds.
const HOA_ZONE = {
  commercial_base_cents: 10000,
  commercial_per_unit_cents: 350,
  commercial_per_acre_cents: 4000,
};

describe("computeCommercialZonePrice", () => {
  it("sums base + per-unit + per-acre components", () => {
    // 2 acres of grounds, 40 units.
    const r = computeCommercialZonePrice(HOA_ZONE, {
      unitCount: 40,
      boundaryAreaSqm: 2 * SQM_PER_ACRE,
    });
    expect(r.baseCents).toBe(10000);
    expect(r.unitCents).toBe(40 * 350); // $140.00
    expect(r.acreageCents).toBe(2 * 4000); // $80.00
    expect(r.perVisitCents).toBe(10000 + 14000 + 8000); // $320.00
    expect(r.recurringCents).toBe(32000);
  });

  it("rounds fractional acreage to whole cents", () => {
    // 0.5 acres at $40/acre = exactly $20; 0.333... acres rounds.
    const r = computeCommercialZonePrice(HOA_ZONE, {
      unitCount: 0,
      boundaryAreaSqm: SQM_PER_ACRE / 3,
    });
    expect(r.acreageCents).toBe(Math.round(4000 / 3)); // 1333
    expect(r.perVisitCents).toBe(10000 + 1333);
  });

  it("charges no acreage when the property has no drawn boundary", () => {
    const r = computeCommercialZonePrice(HOA_ZONE, { unitCount: 12 });
    expect(r.acreageCents).toBe(0);
    expect(r.perVisitCents).toBe(10000 + 12 * 350);
  });

  it("treats missing components as zero", () => {
    const r = computeCommercialZonePrice(
      { commercial_base_cents: null, commercial_per_unit_cents: 500, commercial_per_acre_cents: null },
      { unitCount: 10, boundaryAreaSqm: SQM_PER_ACRE },
    );
    expect(r.perVisitCents).toBe(5000);
  });

  it("never charges negative unit counts", () => {
    const r = computeCommercialZonePrice(HOA_ZONE, { unitCount: -5 });
    expect(r.unitCents).toBe(0);
    expect(r.perVisitCents).toBe(10000);
  });

  it("applies the frequency multiplier to the full per-visit price", () => {
    const r = computeCommercialZonePrice(HOA_ZONE, {
      unitCount: 40,
      boundaryAreaSqm: 2 * SQM_PER_ACRE,
      multiplier: 0.9,
    });
    expect(r.perVisitCents).toBe(32000);
    expect(r.recurringCents).toBe(Math.round(32000 * 0.9));
  });

  it("uses 4046.8564 sqm per acre", () => {
    expect(SQM_PER_ACRE).toBeCloseTo(4046.8564, 4);
  });
});

describe("zoneHasCommercialPricing", () => {
  it("is true when any component is configured", () => {
    expect(zoneHasCommercialPricing(HOA_ZONE)).toBe(true);
    expect(
      zoneHasCommercialPricing({
        commercial_base_cents: null,
        commercial_per_unit_cents: null,
        commercial_per_acre_cents: 100,
      }),
    ).toBe(true);
  });

  it("is false when nothing is configured (drawer shows the setup hint)", () => {
    expect(
      zoneHasCommercialPricing({
        commercial_base_cents: null,
        commercial_per_unit_cents: null,
        commercial_per_acre_cents: null,
      }),
    ).toBe(false);
    expect(
      zoneHasCommercialPricing({
        commercial_base_cents: 0,
        commercial_per_unit_cents: 0,
        commercial_per_acre_cents: 0,
      }),
    ).toBe(false);
  });
});
