// The first cleanup's price: off, flat per zone, or by the owner's answers to
// "when was your yard last cleaned?", plus an optional add-on per extra dog.
//
// The rule exists twice on purpose (see src/lib/first-cleanup.ts): the
// database's `first_cleanup_price_cents` is what the public signup CHARGES,
// and `firstCleanupPriceCents` is what the office screens PREFILL. Two copies
// drift, so the last block here runs the database's own answers, printed by
// the SQL proof, through the TypeScript copy and requires them to agree.
import { describe, expect, it } from "vitest";
import {
  FIRST_CLEANUP_OFF,
  firstCleanupOptions,
  firstCleanupPriceCents,
  firstCleanupPricingProblem,
  parseFirstCleanupPricing,
  toStoredFirstCleanupPricing,
  type FirstCleanupPricing,
} from "@/lib/first-cleanup";
import {
  proofDatabaseReachable,
  proofPriceCases,
  runFirstCleanupProof,
} from "./helpers/first-cleanup-proof";

const TIERED: FirstCleanupPricing = {
  mode: "by_last_cleaned",
  perExtraDogCents: 1500,
  tiers: [
    { id: "within_a_week", label: "Within a week", priceCents: 4500 },
    { id: "one_to_four_weeks", label: "1–4 weeks", priceCents: 7500 },
    { id: "one_to_three_months", label: "1–3 months", priceCents: 11000 },
    { id: "three_months_or_never", label: "3+ months or never", priceCents: 15000 },
    { id: "just_done", label: "Cleaned yesterday by someone else", priceCents: 0 },
  ],
};

describe("pricing by time since the yard was last cleaned", () => {
  it("charges the tier the customer picked, whatever the zone says", () => {
    expect(
      firstCleanupPriceCents(TIERED, { zoneFlatCents: 7500, dogCount: 1, tierId: "within_a_week" }),
    ).toBe(4500);
    expect(
      firstCleanupPriceCents(TIERED, {
        zoneFlatCents: 99_999,
        dogCount: 1,
        tierId: "three_months_or_never",
      }),
    ).toBe(15000);
  });

  it("adds the extra-dog amount once per dog after the first", () => {
    // 3+ months, three dogs: 150 + 2 × 15.
    expect(
      firstCleanupPriceCents(TIERED, {
        zoneFlatCents: 0,
        dogCount: 3,
        tierId: "three_months_or_never",
      }),
    ).toBe(18000);
  });

  it("keeps a free tier free, however many dogs there are", () => {
    expect(
      firstCleanupPriceCents(TIERED, { zoneFlatCents: 7500, dogCount: 4, tierId: "just_done" }),
    ).toBe(0);
  });

  it("prices nothing without an answer, or with an answer the owner does not offer", () => {
    // Null, not 0. 0 would be "free", and a customer who skipped the question
    // or sent a made-up id would get a free first cleanup.
    expect(firstCleanupPriceCents(TIERED, { zoneFlatCents: 7500, dogCount: 1, tierId: null })).toBe(
      null,
    );
    expect(
      firstCleanupPriceCents(TIERED, { zoneFlatCents: 7500, dogCount: 1, tierId: "whatever" }),
    ).toBe(null);
  });

  it("lists every answer priced for this yard, in the owner's order", () => {
    expect(firstCleanupOptions(TIERED, { zoneFlatCents: 0, dogCount: 2 })).toEqual([
      { id: "within_a_week", label: "Within a week", priceCents: 6000 },
      { id: "one_to_four_weeks", label: "1–4 weeks", priceCents: 9000 },
      { id: "one_to_three_months", label: "1–3 months", priceCents: 12500 },
      { id: "three_months_or_never", label: "3+ months or never", priceCents: 16500 },
      { id: "just_done", label: "Cleaned yesterday by someone else", priceCents: 0 },
    ]);
  });
});

describe("flat, and off", () => {
  it("flat is the zone's own first-cleanup fee, plus the dogs", () => {
    const flat: FirstCleanupPricing = { mode: "flat", tiers: [], perExtraDogCents: 1000 };
    expect(firstCleanupPriceCents(flat, { zoneFlatCents: 7500, dogCount: 1, tierId: null })).toBe(
      7500,
    );
    expect(firstCleanupPriceCents(flat, { zoneFlatCents: 7500, dogCount: 3, tierId: null })).toBe(
      9500,
    );
    // A zone whose fee is $0 has no first cleanup to add dogs to.
    expect(firstCleanupPriceCents(flat, { zoneFlatCents: 0, dogCount: 3, tierId: null })).toBe(0);
  });

  it("off is zero, whatever the zone field and the add-on say", () => {
    expect(
      firstCleanupPriceCents(
        { ...FIRST_CLEANUP_OFF, perExtraDogCents: 1000 },
        { zoneFlatCents: 7500, dogCount: 4, tierId: "within_a_week" },
      ),
    ).toBe(0);
  });
});

describe("the owner's draft, checked the way the database will check it", () => {
  it("refuses tiered pricing with no answers", () => {
    expect(firstCleanupPricingProblem({ ...TIERED, tiers: [] })).toMatch(/at least one answer/);
  });

  it("refuses a duplicate id, a blank label and a price in fractions of a cent", () => {
    const [a] = TIERED.tiers;
    expect(firstCleanupPricingProblem({ ...TIERED, tiers: [a, { ...a, label: "Again" }] })).toMatch(
      /share an id/,
    );
    expect(firstCleanupPricingProblem({ ...TIERED, tiers: [{ ...a, label: "  " }] })).toMatch(
      /needs a label/,
    );
    expect(firstCleanupPricingProblem({ ...TIERED, tiers: [{ ...a, priceCents: 45.5 }] })).toMatch(
      /price between/,
    );
  });

  it("round-trips through the stored shape", () => {
    expect(parseFirstCleanupPricing(toStoredFirstCleanupPricing(TIERED))).toEqual(TIERED);
  });

  it("reads anything it does not understand as off", () => {
    for (const raw of [null, undefined, "flat", [], { mode: "sometimes" }]) {
      expect(parseFirstCleanupPricing(raw)).toEqual(FIRST_CLEANUP_OFF);
    }
    // Tiered with no usable tiers cannot price anything, so it is off too.
    expect(parseFirstCleanupPricing({ mode: "by_last_cleaned", tiers: [{ id: "a" }] }).mode).toBe(
      "off",
    );
  });
});

describe.skipIf(!proofDatabaseReachable)("the database agrees, case for case", () => {
  it("prices every case the SQL proof prints exactly as the TypeScript mirror does", () => {
    const run = runFirstCleanupProof();
    expect(run.status, run.out).toBe(0);
    const cases = proofPriceCases(run.out);
    expect(cases.length, "the proof printed no pricing cases").toBeGreaterThanOrEqual(10);
    for (const c of cases) {
      const ts = firstCleanupPriceCents(parseFirstCleanupPricing(c.cfg), {
        zoneFlatCents: c.zoneFlatCents,
        dogCount: c.dogCount,
        tierId: c.tierId,
      });
      expect(ts, `${JSON.stringify(c.cfg)} zone=${c.zoneFlatCents} dogs=${c.dogCount} tier=${c.tierId}`).toBe(
        c.expected,
      );
    }
  });
});
