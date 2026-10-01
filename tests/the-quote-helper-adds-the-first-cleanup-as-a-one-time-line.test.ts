// "Add first cleanup" on the quote editor: one one-time line, priced from the
// owner's first-cleanup settings, which the person writing the quote can then
// edit like any other line. One-time matters twice over: a quote's one-time
// lines are what invoiceQuoteOneTimeCharges bills once, and a per-visit line
// would charge the first cleanup on every visit for the life of the service.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FIRST_CLEANUP_OFF,
  firstCleanupQuoteLine,
  type FirstCleanupPricing,
} from "@/lib/first-cleanup";
import { lineAmountCents, parseMoneyToCents, parseQuantity, quoteTotals } from "@/lib/quotes";

const TIERED: FirstCleanupPricing = {
  mode: "by_last_cleaned",
  perExtraDogCents: 1000,
  tiers: [
    { id: "within_a_week", label: "Within a week", priceCents: 4500 },
    { id: "three_months_or_never", label: "3+ months or never", priceCents: 15000 },
  ],
};

describe("the line it adds", () => {
  it("is one-time, quantity one, at the tier's price for the dogs given", () => {
    const line = firstCleanupQuoteLine(TIERED, { tierId: "three_months_or_never", dogCount: 2 });
    expect(line).toEqual({
      description: "First cleanup (last cleaned: 3+ months or never, 2 dogs)",
      quantity: "1",
      price: "160.00",
      recurring: false,
    });
  });

  it("parses back into the editor's own money rules as the same amount", () => {
    // The editor stores price and quantity as the strings a person types; the
    // helper must hand it strings the editor's parsers accept, or the line
    // would show as invalid the moment it appeared.
    const line = firstCleanupQuoteLine(TIERED, { tierId: "within_a_week", dogCount: 1 })!;
    const unit = parseMoneyToCents(line.price);
    const qty = parseQuantity(line.quantity);
    expect(unit).toBe(4500);
    expect(qty).toBe(1);
    const totals = quoteTotals([
      { amount_cents: lineAmountCents(qty!, unit!), recurring: line.recurring },
    ]);
    expect(totals).toMatchObject({ oneTimeCents: 4500, recurringCents: 0 });
  });

  it("prices flat mode from the zone picked", () => {
    const flat: FirstCleanupPricing = { mode: "flat", tiers: [], perExtraDogCents: 0 };
    expect(
      firstCleanupQuoteLine(flat, { tierId: null, zoneFlatCents: 7500, dogCount: 1 }),
    ).toMatchObject({ description: "First cleanup", price: "75.00", recurring: false });
  });

  it("adds nothing when pricing is off, or when no answer was picked", () => {
    expect(firstCleanupQuoteLine(FIRST_CLEANUP_OFF, { tierId: null, dogCount: 1 })).toBeNull();
    expect(firstCleanupQuoteLine(TIERED, { tierId: null, dogCount: 1 })).toBeNull();
    expect(firstCleanupQuoteLine(TIERED, { tierId: "gone", dogCount: 1 })).toBeNull();
  });
});

describe("the editor wires it", () => {
  const src = readFileSync(
    join(import.meta.dirname, "..", "src/components/quotes/QuoteEditor.tsx"),
    "utf8",
  );

  it("offers the button only when the owner prices a first cleanup", () => {
    expect(src).toMatch(/fcPricing && fcPricing\.mode !== "off" && \(/);
    expect(src).toMatch(/Add first cleanup/);
  });

  it("builds the line with the helper, as a one-time line", () => {
    expect(src).toMatch(/firstCleanupQuoteLine\(fcPricing,/);
    expect(src).toMatch(/\{ \.\.\.blankEditorLine\(false\), \.\.\.fcLine \}/);
  });
});
