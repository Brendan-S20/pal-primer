import { describe, expect, it } from "vitest";
import {
  suggestZonePrice,
  suggestZonePrices,
  zoneSkipRate,
  ZONE_PRICING_RULE_NOTE,
  type ZonePriceStats,
} from "@/lib/zone-price-suggestion";

// Zone price suggestions stopped being a model call on 2026-10-03. The rule is
// written out at the top of src/lib/zone-price-suggestion.ts; these pin each
// branch of it, because an owner acting on "raise 10%" is changing what their
// customers pay.

const zone = (o: Partial<ZonePriceStats>): ZonePriceStats => ({
  zone_id: "z1",
  name: "North",
  postal_prefix: "787",
  account_type: "residential",
  current_price_note: null,
  completed_90d: 50,
  skipped_90d: 1,
  skip_rate_pct: 2,
  avg_visit_price_cents: 2_500,
  ...o,
});

describe("suggestZonePrice", () => {
  it("raises 10% to the nearest dollar when demand is strong and skips are rare", () => {
    const r = suggestZonePrice(zone({}));
    expect(r.suggested_price_cents).toBe(2_800); // $27.50 rounds to $28
    expect(r.delta_pct).toBe(12);
    expect(r.confidence).toBe("high");
    expect(r.reason).toMatch(/^Raise 10%: 50 visits completed in 90 days and only 2% skipped\.$/);
  });

  it("holds when there are too few visits to judge, and says how many", () => {
    const r = suggestZonePrice(zone({ completed_90d: 12, skipped_90d: 0 }));
    expect(r.suggested_price_cents).toBe(2_500);
    expect(r.delta_pct).toBe(0);
    expect(r.confidence).toBe("low");
    expect(r.reason).toBe("Not enough visits in 90 days to judge (12 completed).");
  });

  it("holds a zone that skips 20% or more, and names the skip rate", () => {
    const r = suggestZonePrice(zone({ completed_90d: 40, skipped_90d: 10 }));
    expect(r.delta_pct).toBe(0);
    expect(r.suggested_price_cents).toBe(2_500);
    expect(r.reason).toMatch(/^Hold: 20% of visits were skipped/);
  });

  it("holds between the two thresholds", () => {
    const r = suggestZonePrice(zone({ completed_90d: 45, skipped_90d: 5 })); // 10%
    expect(r.delta_pct).toBe(0);
    expect(r.reason).toMatch(/5% or less/);
  });

  it("takes medium confidence from 20 completed and high from 40", () => {
    expect(suggestZonePrice(zone({ completed_90d: 20, skipped_90d: 0 })).confidence).toBe("medium");
    expect(suggestZonePrice(zone({ completed_90d: 39, skipped_90d: 0 })).confidence).toBe("medium");
    expect(suggestZonePrice(zone({ completed_90d: 40, skipped_90d: 0 })).confidence).toBe("high");
  });

  it("never suggests a residential raise below $12", () => {
    const r = suggestZonePrice(zone({ avg_visit_price_cents: 900 }));
    expect(r.suggested_price_cents).toBe(1_200);
    expect(r.reason).toMatch(/\$12\.00 residential minimum/);
  });

  it("does not apply the residential floor to a commercial zone", () => {
    const r = suggestZonePrice(zone({ account_type: "commercial", avg_visit_price_cents: 900 }));
    expect(r.suggested_price_cents).toBe(1_000);
  });

  it("holds when no completed visit carried a price", () => {
    const r = suggestZonePrice(zone({ avg_visit_price_cents: 0 }));
    expect(r.suggested_price_cents).toBe(0);
    expect(r.delta_pct).toBe(0);
    expect(r.confidence).toBe("low");
  });

  it("measures skips against completed plus skipped, not every visit booked", () => {
    expect(zoneSkipRate(19, 1)).toBe(0.05);
    expect(zoneSkipRate(0, 0)).toBe(0);
    // Exactly 5% still raises.
    expect(suggestZonePrice(zone({ completed_90d: 38, skipped_90d: 2 })).delta_pct).toBeGreaterThan(0);
  });
});

describe("suggestZonePrices", () => {
  it("returns every zone, holds included, with its stats, and the rule as the notes", () => {
    const out = suggestZonePrices([
      zone({ zone_id: "a" }),
      zone({ zone_id: "b", completed_90d: 3 }),
    ]);
    expect(out.notes).toBe(ZONE_PRICING_RULE_NOTE);
    expect(out.suggestions.map((s) => s.zone_id)).toEqual(["a", "b"]);
    // The shape PricingPanel reads: suggestion fields and stats on one row.
    expect(out.suggestions[1]).toMatchObject({
      name: "North",
      completed_90d: 3,
      skip_rate_pct: 2,
      avg_visit_price_cents: 2_500,
      suggested_price_cents: 2_500,
      delta_pct: 0,
      confidence: "low",
    });
  });

  it("states the rule without an em dash, since an owner reads it", () => {
    expect(ZONE_PRICING_RULE_NOTE).not.toMatch(/—/);
  });
});
