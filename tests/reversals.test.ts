import { describe, expect, it } from "vitest";
import { totalReversals, type Reversal } from "@/lib/reversals.server";

// The arithmetic of the contra line. The queries are exercised live; what is
// worth pinning here is the treatment of a WON dispute, because getting that
// wrong is invisible — the numbers still look plausible, they are just wrong by
// twice the disputed amount.

const rev = (over: Partial<Reversal>): Reversal => ({
  id: "r",
  kind: "payment_refunded",
  paymentId: "p",
  day: "2026-06-10",
  amountCents: 0,
  deducts: true,
  typeLabel: "Refund",
  ...over,
});

describe("reversal totals", () => {
  it("nets a recovery against the deductions", () => {
    const totals = totalReversals([
      rev({ amountCents: 10_000 }),
      rev({ amountCents: 2_500, kind: "payment_chargeback" }),
      rev({ amountCents: 4_000, kind: "payment_chargeback_won", deducts: false }),
    ]);
    expect(totals.deductedCents).toBe(12_500);
    expect(totals.recoveredCents).toBe(4_000);
    expect(totals.netCents).toBe(8_500);
    expect(totals.count).toBe(3);
  });

  it("does not treat a won dispute as a deduction", () => {
    // If a recovery were also deducted, income would be understated by twice
    // the amount — and every figure would still look like a plausible number.
    const totals = totalReversals([
      rev({ amountCents: 5_000, kind: "payment_chargeback_won", deducts: false }),
    ]);
    expect(totals.deductedCents).toBe(0);
    expect(totals.netCents).toBe(-5_000);
  });

  it("is zero for a period with no reversals", () => {
    const totals = totalReversals([]);
    expect(totals).toEqual({
      deductedCents: 0,
      recoveredCents: 0,
      netCents: 0,
      count: 0,
    });
  });

  it("can net to zero without pretending nothing happened", () => {
    // A refund and an equal recovery cancel in money terms. The count must
    // still be 2 — "no reversals" and "two reversals that offset" are
    // different facts, and the second one is worth showing.
    const totals = totalReversals([
      rev({ amountCents: 7_500 }),
      rev({ amountCents: 7_500, kind: "payment_chargeback_won", deducts: false }),
    ]);
    expect(totals.netCents).toBe(0);
    expect(totals.count).toBe(2);
  });
});
