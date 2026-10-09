// The owner's decision was "typically 0%, but allow it to be changed". So the
// default is zero, and at zero NOTHING may move: not a total, not a revenue
// figure, not a royalty, not a fee, not a refund split, not a line on a
// screen. Every business on the platform today is at zero.
//
// Golden figures: each number below is what the code produced BEFORE sales
// tax existed, written down as a literal, and the rows are given both the way
// old rows read (no tax columns at all) and the way new ones do (tax 0).
import { describe, expect, it, vi } from "vitest";
import { grossReceivedCents, taxReceivedCents } from "@/lib/revenue";
import { billedInPeriod } from "@/lib/ar";
import { splitRefund } from "@/lib/refund-split";
import { platformFeeCents } from "@/lib/platform-fee";
import { quoteProcessingFee } from "@/lib/processing-fee";
import { tippedCharge } from "@/lib/tips";
import { invoiceEmailTaxData, invoiceTotals, preTaxShareCents, taxShareCents } from "@/lib/sales-tax";
import { salesTaxByMonth } from "@/lib/cpa-reports";
import { describeSettlement } from "@/lib/franchise-settlement";
import { accountingTaxLine } from "@/lib/accounting.server";
import { freshState, manualInvoiceFakeDb } from "./helpers/manual-invoice-fake-db";

vi.mock("@/lib/activity.server", () => ({ logActivity: vi.fn(async () => {}) }));

const OLD_ROWS = [
  { amount_cents: 12_500, surcharge_cents: 0, tip_cents: 1_500, status: "succeeded" },
  { amount_cents: 6_000, surcharge_cents: 180, tip_cents: 900, status: "refunded" },
  { amount_cents: 3_333, status: "succeeded" },
  { amount_cents: 4_000, status: "failed" },
];
const NEW_ROWS = OLD_ROWS.map((r) => ({ ...r, tax_cents: 0 }));

describe("at a zero rate", () => {
  it("an invoice's total is its subtotal", () => {
    for (const sub of [0, 1, 999, 10_006, 123_457]) {
      expect(invoiceTotals(sub, 0)).toEqual({
        subtotalCents: sub,
        taxRateBps: 0,
        taxCents: 0,
        taxLabel: null,
        totalCents: sub,
      });
    }
  });

  it("a hand-made invoice writes exactly the totals it always wrote", async () => {
    const { insertManualInvoice } = await import("@/lib/manual-invoice.server");
    const state = freshState();
    const r = await insertManualInvoice(manualInvoiceFakeDb(state) as never, {
      orgId: "0a000000-0000-4000-8000-0000000000aa",
      userId: "a0000000-0000-4000-8000-00000000a001",
      clientId: "c0000000-0000-4000-8000-0000000000a1",
      items: [
        { description: "Cleanup", amountCents: 12_000 },
        { description: "Bags", amountCents: 450, quantity: 3, unitAmountCents: 150 },
      ],
    });
    expect(state.inserted.invoices[0]).toMatchObject({
      subtotal_cents: 12_450,
      total_cents: 12_450,
      tax_cents: 0,
      tax_rate_bps: 0,
      tax_label: null,
    });
    expect(r.totalCents).toBe(12_450);
  });

  it("revenue is the golden figure, from old rows and new rows alike", () => {
    expect(grossReceivedCents(OLD_ROWS)).toBe(21_833);
    expect(grossReceivedCents(NEW_ROWS)).toBe(21_833);
    expect(taxReceivedCents(NEW_ROWS)).toBe(0);
  });

  it("billed is the golden figure, with no tax billed", () => {
    const invoices = [
      { status: "open", total_cents: 10_000, credit_applied_cents: 1_500, issued_at: "2026-07-03T15:00:00Z" },
      { status: "paid", total_cents: 4_250, credit_applied_cents: 0, issued_at: "2026-07-20T15:00:00Z", tax_cents: 0 },
      { status: "void", total_cents: 9_999, credit_applied_cents: 0, issued_at: "2026-07-21T15:00:00Z" },
    ];
    expect(billedInPeriod(invoices, "2026-07-01", "2026-07-31", "America/Chicago")).toEqual({
      billedCents: 14_250,
      taxBilledCents: 0,
      creditsAppliedCents: 1_500,
      netBilledCents: 12_750,
      invoiceCount: 2,
    });
  });

  it("every refund split is the golden split", () => {
    const GOLDEN: Array<[number[], { revenueCents: number; surchargeCents: number; tipCents: number }]> = [
      [[10_300, 10_300, 300, 0], { revenueCents: 10_000, surchargeCents: 300, tipCents: 0 }],
      [[5_150, 10_300, 300, 0], { revenueCents: 5_000, surchargeCents: 150, tipCents: 0 }],
      [[14_000, 14_000, 0, 1_500], { revenueCents: 12_500, surchargeCents: 0, tipCents: 1_500 }],
      [[5_750, 11_500, 0, 1_500], { revenueCents: 5_000, surchargeCents: 0, tipCents: 750 }],
      [[10_750, 10_750, 250, 500], { revenueCents: 10_000, surchargeCents: 250, tipCents: 500 }],
      [[7_000, 7_000, 0, 0], { revenueCents: 7_000, surchargeCents: 0, tipCents: 0 }],
    ];
    for (const [[r, total, sur, tip], want] of GOLDEN) {
      for (const s of [splitRefund(r, total, sur, tip), splitRefund(r, total, sur, tip, 0)]) {
        expect(s).toEqual({ refundedCents: r, ...want, taxCents: 0 });
      }
    }
  });

  it("the platform fee base is the amount due, and the fee is what it was", () => {
    for (const due of [999, 1_000, 1_001, 4_500, 10_000, 250_000]) {
      const untaxed = { tax_cents: 0, total_cents: due };
      expect(preTaxShareCents(due, untaxed)).toBe(due);
      expect(platformFeeCents(due, untaxed)).toBe(platformFeeCents(due));
      expect(platformFeeCents(due, null)).toBe(platformFeeCents(due));
    }
    const c = tippedCharge({
      dueCents: 10_000,
      choice: { kind: "percent", percent: 15 },
      tipsEnabled: true,
      invoice: { tax_cents: 0, total_cents: 10_000 },
    });
    expect(c).toMatchObject({ dueCents: 10_000, tipCents: 1_500, amountCents: 11_500, platformFeeBaseCents: 10_000 });
  });

  it("a card surcharge is the golden surcharge", () => {
    const cfg = { rail: "card" as const, funding: "credit" as const, merchantRegion: "TX", passThroughEnabled: true, attested: true };
    // $25, $100, $1,000 tickets: the table in processing-fee.ts.
    expect(quoteProcessingFee({ ...cfg, baseCents: 2_500, taxCents: 0 }).surchargeCents).toBe(75);
    expect(quoteProcessingFee({ ...cfg, baseCents: 10_000, taxCents: 0 }).surchargeCents).toBe(300);
    expect(quoteProcessingFee({ ...cfg, baseCents: 100_000, taxCents: 0 }).surchargeCents).toBe(2_930);
    expect(quoteProcessingFee({ ...cfg, baseCents: 10_000, rail: "ach", taxCents: 0 }).surchargeCents).toBe(80);
    expect(quoteProcessingFee({ ...cfg, baseCents: 10_000, taxCents: 0 })).toEqual(
      quoteProcessingFee({ ...cfg, baseCents: 10_000 }),
    );
  });

  it("a payment against an untaxed invoice carries no tax", () => {
    expect(taxShareCents(10_000, 0, 10_000)).toBe(0);
    expect(taxShareCents(10_000, null, null)).toBe(0);
  });

  it("the Sales tax collected sheet is a row of zeros for every month", () => {
    const rows = salesTaxByMonth(["2026-07", "2026-08"], [{ day: "2026-07-03", taxCents: 0 }], [{ day: "2026-07-04", taxCents: 0 }], []);
    expect(rows).toEqual([
      { month: "2026-07", taxBilledCents: 0, taxCollectedCents: 0, taxRefundedCents: 0, netTaxCollectedCents: 0, taxedPaymentCount: 0 },
      { month: "2026-08", taxBilledCents: 0, taxCollectedCents: 0, taxRefundedCents: 0, netTaxCollectedCents: 0, taxedPaymentCount: 0 },
    ]);
  });

  it("a settlement statement reads as it did", () => {
    const line = describeSettlement(
      {
        id: "s",
        period_start: "2026-07-01",
        period_end: "2026-08-01",
        revenue_cents: 100_000,
        royalty_percent: 6,
        royalty_cents: 6_000,
        adjustments_applied_cents: 0,
        revenue_collected_by_parent_cents: 40_000,
        direction: "franchise_owes_location",
        net_due_cents: 34_000,
        status: "issued",
      },
      "location",
    );
    expect(line.taxHeldByFranchiseCents).toBe(0);
    expect(line.collectedByFranchiseCents! - line.royaltyCents).toBe(line.netDueCents);
  });

  it("the invoice email and the accounting sync carry nothing new", () => {
    expect(invoiceEmailTaxData({ subtotal_cents: 10_000, tax_cents: 0, tax_rate_bps: 0, tax_label: null })).toEqual({});
    expect(invoiceEmailTaxData({})).toEqual({});
    // And an untaxed invoice syncs with no sales-tax item set at all.
    expect(accountingTaxLine({ sales_tax_item_id: null }, { tax_cents: 0 })).toBeNull();
  });
});
