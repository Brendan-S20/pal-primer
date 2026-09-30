// Sales tax arithmetic: the rate, the rounding, and why it is the whole
// invoice rather than each line.
//
// The rule (src/lib/sales-tax.ts, mirrored by public.sales_tax_cents in
// 20260929110000): tax = round(subtotal x bps / 10000), half away from zero,
// ONCE, on the whole invoice subtotal. A negative subtotal is taxed as zero.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SALES_TAX_LABEL,
  SALES_TAX_MAX_BPS,
  formatTaxRate,
  invoiceTotals,
  parseTaxRatePercent,
  preTaxShareCents,
  roundHalfAwayFromZero,
  salesTaxCents,
  showsTaxLine,
  taxLineLabel,
  taxShareCents,
} from "@/lib/sales-tax";

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = readFileSync(
  join(ROOT, "supabase/migrations/20260929110000_tax-was-always-zero-and-could-not-be-anything-else.sql"),
  "utf8",
);

describe("the tax on an invoice", () => {
  it("is the subtotal times the rate, to the cent", () => {
    expect(salesTaxCents(10_000, 825)).toBe(825);
    expect(salesTaxCents(12_345, 700)).toBe(864); // 864.15
    expect(salesTaxCents(4_500, 625)).toBe(281); // 281.25
    expect(salesTaxCents(1, SALES_TAX_MAX_BPS)).toBe(0); // 0.25
  });

  it("rounds half away from zero, not half to even", () => {
    // Exactly half a cent in each: 0.5, 1.5, 2.5, 10.5. Banker's rounding
    // would give 0, 2, 2, 10.
    expect(salesTaxCents(1, 5_000)).toBe(1);
    expect(salesTaxCents(3, 5_000)).toBe(2);
    expect(salesTaxCents(5, 5_000)).toBe(3);
    expect(salesTaxCents(21, 5_000)).toBe(11);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
    expect(roundHalfAwayFromZero(-0.4)).toBe(0);
    expect(Object.is(roundHalfAwayFromZero(-0.4), -0)).toBe(false);
  });

  it("is charged once on the whole invoice, never summed line by line", () => {
    // Three $33.33 lines and a $0.07 one at 8.25%: whole invoice 10,006 ->
    // 825.495 -> 825; line by line 275 + 275 + 275 + 1 = 826. The SQL proof
    // bills exactly these lines and gets 825.
    const lines = [3_333, 3_333, 3_333, 7];
    const whole = salesTaxCents(
      lines.reduce((s, l) => s + l, 0),
      825,
    );
    const perLine = lines.reduce((s, l) => s + salesTaxCents(l, 825), 0);
    expect(whole).toBe(825);
    expect(perLine).toBe(826);
    expect(invoiceTotals(10_006, 825).taxCents).toBe(whole);
  });

  it("is zero at a zero rate, on a zero or negative subtotal, and on garbage", () => {
    expect(salesTaxCents(10_000, 0)).toBe(0);
    expect(salesTaxCents(0, 825)).toBe(0);
    expect(salesTaxCents(-5_000, 825)).toBe(0);
    expect(salesTaxCents(Number.NaN, 825)).toBe(0);
    expect(salesTaxCents(10_000, Number.NaN)).toBe(0);
    expect(salesTaxCents(10_000, -100)).toBe(0);
  });

  it("makes the total the subtotal plus the tax, and labels only a real tax", () => {
    expect(invoiceTotals(10_000, 825, "County service tax")).toEqual({
      subtotalCents: 10_000,
      taxRateBps: 825,
      taxCents: 825,
      taxLabel: "County service tax",
      totalCents: 10_825,
    });
    expect(invoiceTotals(10_000, 0, "County service tax")).toEqual({
      subtotalCents: 10_000,
      taxRateBps: 0,
      taxCents: 0,
      taxLabel: null,
      totalCents: 10_000,
    });
    expect(invoiceTotals(10_000, 825, "  ").taxLabel).toBe(DEFAULT_SALES_TAX_LABEL);
  });

  it("agrees with the SQL function on the values the migration asserts", () => {
    // The migration's $check$ block asks public.sales_tax_cents these exact
    // questions; the TypeScript twin must give the same answers.
    const asked = [...MIGRATION.matchAll(/public\.sales_tax_cents\((-?\d+), (\d+)\) <> (\d+)/g)];
    expect(asked.length).toBeGreaterThanOrEqual(5);
    for (const [, base, bps, want] of asked) {
      expect(salesTaxCents(Number(base), Number(bps)), `${base} @ ${bps}`).toBe(Number(want));
    }
    const shares = [
      ...MIGRATION.matchAll(/public\.sales_tax_share_cents\((\d+), (\d+), (\d+)\) <> (\d+)/g),
    ];
    expect(shares.length).toBeGreaterThanOrEqual(4);
    for (const [, amt, tax, total, want] of shares) {
      expect(taxShareCents(Number(amt), Number(tax), Number(total))).toBe(Number(want));
    }
  });

  it("uses Postgres round(numeric), which is half away from zero, in SQL", () => {
    expect(MIGRATION).toMatch(/round\(_taxable_cents::numeric \* _rate_bps \/ 10000\)::integer/);
  });
});

describe("a payment's share of the tax", () => {
  it("is pro rata by the invoice's tax over its total, capped at the tax", () => {
    // A $108.25 invoice carrying $8.25: half of it paid carries half the tax.
    expect(taxShareCents(5_413, 825, 10_825)).toBe(413); // 412.53
    expect(taxShareCents(5_412, 825, 10_825)).toBe(412);
    expect(taxShareCents(10_825, 825, 10_825)).toBe(825);
    // An overpayment never carries more than the invoice's tax.
    expect(taxShareCents(50_000, 825, 10_825)).toBe(825);
    // No tax, no total, nothing paid: zero.
    expect(taxShareCents(5_000, 0, 5_000)).toBe(0);
    expect(taxShareCents(5_000, 825, 0)).toBe(0);
    expect(taxShareCents(0, 825, 10_825)).toBe(0);
  });

  it("leaves the pre-tax share as the rest of the payment", () => {
    expect(preTaxShareCents(10_825, { tax_cents: 825, total_cents: 10_825 })).toBe(10_000);
    expect(preTaxShareCents(10_825, null)).toBe(10_825);
    expect(preTaxShareCents(10_825, { tax_cents: 0, total_cents: 10_825 })).toBe(10_825);
  });
});

describe("the rate an owner types", () => {
  it("reads a percentage to basis points without rounding what nobody typed", () => {
    expect(parseTaxRatePercent("8.25")).toBe(825);
    expect(parseTaxRatePercent("8.25%")).toBe(825);
    expect(parseTaxRatePercent(" 7 ")).toBe(700);
    expect(parseTaxRatePercent("6.5")).toBe(650);
    expect(parseTaxRatePercent("0")).toBe(0);
    expect(parseTaxRatePercent("")).toBe(0);
    expect(parseTaxRatePercent("25")).toBe(2_500);
    expect(parseTaxRatePercent("8.255")).toBeNull();
    expect(parseTaxRatePercent("25.01")).toBeNull();
    expect(parseTaxRatePercent("-1")).toBeNull();
    expect(parseTaxRatePercent("eight")).toBeNull();
  });

  it("prints it back the way it was meant", () => {
    expect(formatTaxRate(825)).toBe("8.25%");
    expect(formatTaxRate(800)).toBe("8%");
    expect(formatTaxRate(850)).toBe("8.5%");
    expect(taxLineLabel("Sales tax", 825)).toBe("Sales tax (8.25%)");
    expect(taxLineLabel(null, 0)).toBe("Sales tax");
    expect(taxLineLabel("  ", 700)).toBe("Sales tax (7%)");
  });

  it("draws a tax line only when there is tax", () => {
    expect(showsTaxLine({ tax_cents: 825 })).toBe(true);
    expect(showsTaxLine({ tax_cents: 0 })).toBe(false);
    expect(showsTaxLine({})).toBe(false);
    expect(showsTaxLine(null)).toBe(false);
  });
});
