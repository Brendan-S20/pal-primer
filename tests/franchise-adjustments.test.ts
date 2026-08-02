import { describe, expect, it } from "vitest";
import {
  describeAdjustment,
  reversalTrail,
  settlementEffectCents,
  summariseLedger,
  type AdjustmentLedgerRow,
} from "@/lib/franchise-adjustments";
import { addonBillingTrail, shortInvoiceRef } from "@/lib/addon-billing";

// The reversal trail (BUG-26 readback) and the add-on billing pointer.
//
// The SQL is exercised live; what is worth pinning here is the WORDING and the
// SIGN, because both fail silently. A trail sentence that says a deduction was
// repaid when it wasn't reads perfectly well, and an effect figure on the wrong
// side of the ledger is still a plausible number — that is the BUG-24 shape.

const row = (over: Partial<AdjustmentLedgerRow>): AdjustmentLedgerRow => ({
  id: "a1",
  child_organization_id: "child",
  child_name: "Ann Arbor",
  payment_id: "pay1",
  kind: "chargeback",
  status: "applied",
  amount_cents: 100_000,
  franchise_share_cents: 0,
  location_share_cents: 100_000,
  collected_by_parent: true,
  note: null,
  dispute_ref: "dp_1",
  created_at: "2026-06-03T14:00:00+00:00",
  settlement_id: "s1",
  settlement_period_start: "2026-06-01",
  settlement_period_end: "2026-06-30",
  settlement_status: "issued",
  reversed_at: null,
  reversed_by_adjustment_id: null,
  repaid_amount_cents: null,
  repaid_at: null,
  repaid_settlement_id: null,
  repaid_settlement_period_start: null,
  repaid_settlement_period_end: null,
  repaid_settlement_status: null,
  repays_adjustment_id: null,
  repays_amount_cents: null,
  repays_created_at: null,
  repays_settlement_period_start: null,
  repays_settlement_period_end: null,
  ...over,
});

/** The deduction after the dispute was won and the repayment was settled. */
const repaidDeduction = row({
  status: "reversed",
  reversed_at: "2026-07-14T09:30:00+00:00",
  reversed_by_adjustment_id: "a2",
  repaid_amount_cents: 100_000,
  repaid_at: "2026-07-14T09:30:00+00:00",
  repaid_settlement_id: "s2",
  repaid_settlement_period_start: "2026-07-01",
  repaid_settlement_period_end: "2026-07-31",
  repaid_settlement_status: "issued",
});

/** The compensating adjustment BUG-26 raises, read from its own side. */
const repayment = row({
  id: "a2",
  kind: "chargeback_won",
  status: "pending",
  location_share_cents: -100_000,
  settlement_id: null,
  settlement_period_start: null,
  settlement_period_end: null,
  settlement_status: null,
  repays_adjustment_id: "a1",
  repays_amount_cents: 100_000,
  repays_created_at: "2026-06-03T14:00:00+00:00",
  repays_settlement_period_start: "2026-06-01",
  repays_settlement_period_end: "2026-06-30",
});

describe("the reversal trail", () => {
  it("names the statement a won chargeback was repaid on", () => {
    expect(reversalTrail(repaidDeduction)).toBe(
      "Reversed 2026-07-14 — the $1,000.00 was repaid on the 2026-07-01 → 2026-07-31 statement.",
    );
  });

  it("says a repayment is still coming when it has not been settled yet", () => {
    expect(
      reversalTrail(
        row({
          status: "reversed",
          reversed_at: "2026-07-14T09:30:00+00:00",
          reversed_by_adjustment_id: "a2",
          repaid_amount_cents: 100_000,
        }),
      ),
    ).toBe("Reversed 2026-07-14 — the $1,000.00 repayment carries into the next statement.");
  });

  it("does not claim a repayment when the deduction was simply cancelled", () => {
    // Reversed before any statement billed it: no money moved in either
    // direction, and saying "repaid" would have the franchisee looking for a
    // credit that does not exist.
    const trail = reversalTrail(
      row({
        status: "reversed",
        reversed_at: "2026-06-20T09:00:00+00:00",
        settlement_id: null,
        settlement_period_start: null,
        settlement_period_end: null,
        settlement_status: null,
      }),
    );
    expect(trail).toBe(
      "Reversed 2026-06-20 before any statement billed it, so nothing was deducted.",
    );
    expect(trail).not.toContain("repaid");
  });

  it("flags a billed deduction reversed with nothing repaying it", () => {
    const orphan = row({
      status: "reversed",
      reversed_at: "2026-07-14T09:30:00+00:00",
      // No reversed_by_adjustment_id, but it WAS on an issued statement.
      settlement_status: "issued",
    });
    expect(reversalTrail(orphan)).toContain("no repayment has been raised");
    expect(describeAdjustment(orphan).needsAttention).toBe(true);
  });

  it("reads the link backwards, so a credit line names the deduction it cancels", () => {
    // The half a franchisee needs when the unexplained figure is on the
    // statement in front of them rather than the one from two months ago.
    expect(reversalTrail(repayment)).toBe(
      "Repays the $1,000.00 chargeback deducted on the 2026-06-01 → 2026-06-30 statement.",
    );
  });

  it("has no trail for an ordinary open deduction", () => {
    expect(reversalTrail(row({ status: "pending" }))).toBeNull();
  });
});

describe("what a line does to the location's settlement", () => {
  // Mirrors generate_franchise_settlements: settle the half the OTHER party is
  // carrying. Getting the side wrong is BUG-24, which billed a franchisee for a
  // refund their own Stripe account had already paid out.
  it("deducts the location's share when the parent collected the money", () => {
    expect(settlementEffectCents(row({ collected_by_parent: true }))).toBe(-100_000);
  });

  it("owes the franchise's share back when the location collected it", () => {
    expect(
      settlementEffectCents(
        row({
          collected_by_parent: false,
          franchise_share_cents: 10_000,
          location_share_cents: 90_000,
        }),
      ),
    ).toBe(10_000);
  });

  it("flips sign for the compensating adjustment, because its shares are negated", () => {
    expect(settlementEffectCents(repayment)).toBe(100_000);
  });
});

describe("ledger summary", () => {
  it("does not count a reversed deduction as money still held", () => {
    // The pair nets to zero: the deduction was cancelled, and the repayment is
    // the line that gives it back. Counting both would show a location owing
    // $1,000 it had already been repaid.
    const s = summariseLedger([repaidDeduction, repayment]);
    expect(s.deductedCents).toBe(0);
    expect(s.repaidCents).toBe(100_000);
    expect(s.reversedCount).toBe(1);
    expect(s.needsAttentionCount).toBe(0);
  });

  it("counts an open deduction and reports what has not reached a statement", () => {
    const s = summariseLedger([row({ status: "pending" })]);
    expect(s.deductedCents).toBe(100_000);
    expect(s.openCents).toBe(-100_000);
  });

  it("ignores a written-off adjustment", () => {
    expect(summariseLedger([row({ status: "written_off" })]).deductedCents).toBe(0);
  });
});

describe("where an add-on charge was billed", () => {
  it("names the invoice a billed charge became a line on", () => {
    const t = addonBillingTrail({
      status: "invoiced",
      invoice_line_item_id: "li1",
      billed_invoice_id: "0f3c9a11-2222-3333-4444-555555555555",
      billed_invoice_status: "paid",
    });
    expect(t.label).toBe("Billed on invoice #0f3c9a11 (paid)");
    expect(t.invoiceId).toBe("0f3c9a11-2222-3333-4444-555555555555");
    expect(t.warning).toBeNull();
  });

  it("admits when a charge says billed and the line is gone", () => {
    // The FK is ON DELETE SET NULL, so this is reachable. Offering a link that
    // resolves to nothing is worse than saying the record is incomplete.
    const t = addonBillingTrail({ status: "invoiced", invoice_line_item_id: null });
    expect(t.invoiceId).toBeNull();
    expect(t.warning).toBe("The invoice line this was billed on no longer exists.");
  });

  it("distinguishes a pointer that is still set but unreadable", () => {
    // A different fault with a different fix: the line is there, the read
    // failed. Collapsing the two into one message sends someone looking for a
    // deleted row that exists.
    const t = addonBillingTrail({ status: "invoiced", invoice_line_item_id: "li1" });
    expect(t.warning).toBe("The invoice line it was billed on couldn't be read.");
  });

  it("does not claim an invoice for a charge taken from prepaid credit", () => {
    const t = addonBillingTrail({ status: "paid_from_credit", credit_ledger_id: "c1" });
    expect(t.label).toBe("Paid from prepaid credit — not on an invoice");
    expect(t.invoiceId).toBeNull();
  });

  it("says an unbilled charge is still coming", () => {
    expect(addonBillingTrail({ status: "pending" }).label).toBe(
      "Unbilled — lands on the next invoice",
    );
  });

  it("says a voided charge was never billed", () => {
    expect(addonBillingTrail({ status: "voided" }).label).toBe("Voided — never billed");
  });

  it("shortens an invoice id the way the payments list does", () => {
    expect(shortInvoiceRef("0f3c9a11-2222-3333-4444-555555555555")).toBe("#0f3c9a11");
  });
});
