import { describe, expect, it } from "vitest";
import {
  quoteProcessingFee,
  railOfPaymentMethod,
  stripeCostCents,
  STRIPE_ACH_CAP_CENTS,
  SURCHARGE_BANNED_REGIONS,
  type QuoteInput,
} from "@/lib/processing-fee";

/** A tenant who has switched pass-through on and attested, in a state that allows it. */
const ALLOWED: Omit<QuoteInput, "baseCents" | "rail"> = {
  funding: "credit",
  merchantRegion: "TX",
  passThroughEnabled: true,
  attested: true,
};

const card = (baseCents: number, over: Partial<QuoteInput> = {}) =>
  quoteProcessingFee({ baseCents, rail: "card", ...ALLOWED, ...over });

describe("what Stripe costs the tenant", () => {
  it("charges 2.9% + 30c on a card", () => {
    expect(stripeCostCents(10_000, "card")).toBe(320); // $100 → $3.20
    expect(stripeCostCents(6_000, "card")).toBe(204); // $60 → $2.04
    expect(stripeCostCents(2_500, "card")).toBe(103); // $25 → $1.03
  });

  it("charges 0.8% on ACH and caps it at $5", () => {
    expect(stripeCostCents(10_000, "ach")).toBe(80); // $100 → 80c
    expect(stripeCostCents(62_500, "ach")).toBe(500); // $625 → exactly the cap
    expect(stripeCostCents(1_000_000, "ach")).toBe(STRIPE_ACH_CAP_CENTS); // $10k → still $5
  });

  it("never returns a cost for a non-amount", () => {
    expect(stripeCostCents(0, "card")).toBe(0);
    expect(stripeCostCents(-500, "card")).toBe(0);
    expect(stripeCostCents(Number.NaN, "card")).toBe(0);
    expect(stripeCostCents(Number.POSITIVE_INFINITY, "ach")).toBe(0);
  });
});

describe("the 3% cap binds below $300, and the tenant eats the rest", () => {
  // This is the table in the module header. If these numbers change, the header
  // is wrong and a tenant has been told something untrue.
  it.each([
    [2_500, 75, 30], // $25     → capped at 75c, absorbs 30c
    [6_000, 180, 29], // $60    → capped at $1.80, absorbs 29c
    [10_000, 300, 29], // $100  → capped at $3.00, absorbs 29c
    [30_000, 900, 26], // $300  → cost meets the cap exactly, still absorbs 26c
    [100_000, 2_930, 85], // $1,000 → under the cap, absorbs the fee on the surcharge
  ])("on a %i cent ticket surcharges %i and leaves %i unrecovered", (base, expected, shortfall) => {
    const q = card(base);
    expect(q.surchargeCents).toBe(expected);
    expect(q.shortfallCents).toBe(shortfall);
    expect(q.suppressed).toBeNull();
  });

  it("leaves a shortfall at every ticket size — there is no break-even", () => {
    // The tempting claim is "it recovers in full above $300", where the 2.9%+30c
    // cost stops exceeding the 3% cap. Not so: the fee lands on base+surcharge,
    // so something is always absorbed. Said plainly here because the header
    // table said otherwise until this test disagreed with it.
    for (const base of [2_500, 30_000, 100_000, 1_000_000]) {
      expect(card(base).shortfallCents).toBeGreaterThan(0);
    }
  });

  it("never exceeds either ceiling, at any amount", () => {
    for (const base of [100, 999, 1_000, 5_000, 30_000, 100_000, 500_000]) {
      const q = card(base);
      // Under the cost of acceptance actually incurred...
      expect(q.surchargeCents).toBeLessThanOrEqual(q.stripeCostCents);
      // ...and under 3% of what the payer is charged.
      expect(q.surchargeCents * 10_000).toBeLessThanOrEqual(q.totalCents * 300);
    }
  });

  it("adds the surcharge to the total and never touches the base", () => {
    const q = card(6_000);
    expect(q.baseCents).toBe(6_000);
    expect(q.totalCents).toBe(6_000 + q.surchargeCents);
  });
});

describe("ACH is not a card, so none of the card rules reach it", () => {
  it("passes the real cost through with no cap and no attestation", () => {
    const q = quoteProcessingFee({
      baseCents: 10_000,
      rail: "ach",
      passThroughEnabled: true,
      attested: false, // irrelevant on ACH
      merchantRegion: null, // irrelevant on ACH
    });
    expect(q.suppressed).toBeNull();
    expect(q.surchargeCents).toBe(80);
  });

  it("surcharges even a Connecticut merchant, because the ban is on cards", () => {
    const q = quoteProcessingFee({
      baseCents: 10_000,
      rail: "ach",
      merchantRegion: "CT",
      passThroughEnabled: true,
      attested: false,
    });
    expect(q.suppressed).toBeNull();
    expect(q.surchargeCents).toBe(80);
  });

  it("recovers almost all of a large payment, where the $5 cap does the work", () => {
    const q = quoteProcessingFee({
      baseCents: 1_000_000, // $10,000
      rail: "ach",
      passThroughEnabled: true,
      attested: true,
      merchantRegion: "TX",
    });
    expect(q.surchargeCents).toBe(500);
    expect(q.shortfallCents).toBe(0); // cost is capped at $5 on the total too
  });
});

describe("every suppression is a stated reason, never a bare zero", () => {
  it("absorbs by default — the tenant has not opted in", () => {
    const q = card(10_000, { passThroughEnabled: false });
    expect(q.surchargeCents).toBe(0);
    expect(q.suppressed).toBe("absorbed");
    expect(q.totalCents).toBe(q.baseCents);
    // The cost does not disappear just because we did not pass it on.
    expect(q.shortfallCents).toBe(320);
  });

  it("refuses to surcharge a debit card, per Durbin", () => {
    expect(card(10_000, { funding: "debit" }).suppressed).toBe("debit");
  });

  it("refuses a prepaid card", () => {
    expect(card(10_000, { funding: "prepaid" }).suppressed).toBe("prepaid");
  });

  it("fails closed when Stripe did not tell us the funding type", () => {
    expect(card(10_000, { funding: "unknown" }).suppressed).toBe("unknown_funding");
    expect(card(10_000, { funding: undefined }).suppressed).toBe("unknown_funding");
  });

  it.each(SURCHARGE_BANNED_REGIONS)("refuses in %s", (region) => {
    expect(card(10_000, { merchantRegion: region }).suppressed).toBe("region");
  });

  it("fails closed when the merchant's state is unknown", () => {
    expect(card(10_000, { merchantRegion: null }).suppressed).toBe("unknown_region");
    expect(card(10_000, { merchantRegion: "  " }).suppressed).toBe("unknown_region");
  });

  it("refuses until the tenant has attested they notified the networks", () => {
    expect(card(10_000, { attested: false }).suppressed).toBe("not_attested");
  });

  it("normalises the region so a lowercase 'ct' is still banned", () => {
    expect(card(10_000, { merchantRegion: "ct" }).suppressed).toBe("region");
  });
});

describe("reading the rail off a PaymentMethod", () => {
  it("recognises a bank account", () => {
    expect(railOfPaymentMethod({ type: "us_bank_account" })).toEqual({
      rail: "ach",
      funding: "unknown",
    });
  });

  it("reads the card funding type through", () => {
    expect(railOfPaymentMethod({ type: "card", card: { funding: "credit" } })).toEqual({
      rail: "card",
      funding: "credit",
    });
    expect(railOfPaymentMethod({ type: "card", card: { funding: "debit" } }).funding).toBe("debit");
  });

  it("calls anything it does not recognise a card with unknown funding, which suppresses", () => {
    // Fail-safe direction: an unrecognised method priced as an un-surchargeable
    // card costs us a fee we could have collected. Priced as ACH it would
    // surcharge something that may be a debit card, which is prohibited.
    expect(railOfPaymentMethod({ type: "link" })).toEqual({ rail: "card", funding: "unknown" });
    expect(railOfPaymentMethod(null)).toEqual({ rail: "card", funding: "unknown" });
    expect(railOfPaymentMethod({ type: "card", card: { funding: "nonsense" } }).funding).toBe(
      "unknown",
    );
  });
});
