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

describe("the demo seed writes DEMOSPRING as the rule it is (#433)", () => {
  it("the seed and existing seeded rows say one first visit, never three", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(
      "supabase/migrations/20261027230000_the-spring-code-says-one-visit.sql",
      "utf8",
    );
    expect(sql).toContain(
      "(_org_id, 'DEMOSPRING',  'percent', NULL, 15,   '15% off a new client''s first visit', true)",
    );
    expect(sql).toMatch(
      /UPDATE public\.promo_codes\s+SET description = '15% off a new client''s first visit'/,
    );
    expect(sql).toMatch(/AND applies_to = 'first_visit'/);
    expect(promoDescription({ ...spring, description: "15% off a new client's first visit" })).toBe(
      "15% off a new client's first visit",
    );
  });
});
