import { describe, expect, it } from "vitest";
import { promoDescription } from "@/lib/promo-copy";

const spring = {
  code: "DEMOSPRING",
  description: "15% off your next 3 visits",
  discount_type: "percent",
  discount_percent: 15,
  applies_to: "first_visit",
};

describe("promo descriptions", () => {
  it("shows the computed rule without the conflicting demo description", () => {
    expect(promoDescription(spring)).toBeNull();
    expect(promoDescription({ ...spring, description: "15% off next 3 visits" })).toBeNull();
    expect(promoDescription({ ...spring, discount_percent: "15" })).toBeNull();
  });

  it("preserves custom descriptions and different promo rules", () => {
    for (const changes of [
      { code: "SPRING" },
      { discount_percent: 20 },
      { discount_type: "fixed" },
      { applies_to: "recurring" },
    ]) {
      expect(promoDescription({ ...spring, ...changes })).toBe(spring.description);
    }
    expect(promoDescription({ ...spring, description: "Spring offer" })).toBe("Spring offer");
    expect(promoDescription({ ...spring, description: null })).toBeNull();
  });
});
