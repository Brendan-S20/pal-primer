// A refund of a taxed payment gives the customer back their share of the tax,
// and that share comes off TAX COLLECTED, not off revenue -- because it was
// never revenue.
//
// splitRefund already divided a refund in the charge's own ratio between the
// invoiced amount, the card surcharge and the tip. The invoiced amount now
// divides once more, between revenue and tax, in the ratio the payment itself
// carried them (payments.tax_cents / payments.amount_cents).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitRefund } from "@/lib/refund-split";

const ROOT = join(import.meta.dirname, "..");
const code = (p: string) => readFileSync(join(ROOT, p), "utf8").replace(/\/\/[^\n]*/g, "");

describe("the refund split with tax", () => {
  it("takes the service off revenue and the tax off tax collected, on a full refund", () => {
    // $100 of service + $8.25 of tax.
    expect(splitRefund(10_825, 10_825, 0, 0, 825)).toEqual({
      refundedCents: 10_825,
      revenueCents: 10_000,
      surchargeCents: 0,
      tipCents: 0,
      taxCents: 825,
    });
  });

  it("splits a partial refund in the payment's own ratio", () => {
    const half = splitRefund(5_413, 10_825, 0, 0, 825);
    expect(half.taxCents).toBe(413); // 412.53
    expect(half.revenueCents).toBe(5_000);
  });

  it("divides four ways when a surcharge and a tip share the charge", () => {
    // Invoice $108.25 ($8.25 tax) + $3.00 surcharge + $10.00 tip = $121.25.
    const s = splitRefund(12_125, 12_125, 300, 1_000, 825);
    expect(s).toEqual({
      refundedCents: 12_125,
      revenueCents: 10_000,
      surchargeCents: 300,
      tipCents: 1_000,
      taxCents: 825,
    });
  });

  it("never loses or invents a cent, and partials sum to the whole", () => {
    for (const refunded of [1, 7, 99, 1_234, 6_062, 12_124, 12_125]) {
      const s = splitRefund(refunded, 12_125, 300, 1_000, 825);
      expect(s.revenueCents + s.taxCents + s.surchargeCents + s.tipCents, String(refunded)).toBe(s.refundedCents);
      expect(s.taxCents).toBeGreaterThanOrEqual(0);
      expect(s.taxCents).toBeLessThanOrEqual(825);
      expect(s.revenueCents).toBeGreaterThanOrEqual(0);
    }
    const a = splitRefund(4_000, 10_825, 0, 0, 825);
    const rest = splitRefund(6_825, 10_825, 0, 0, 825);
    const whole = splitRefund(10_825, 10_825, 0, 0, 825);
    expect(a.taxCents + rest.taxCents).toBe(whole.taxCents);
    expect(a.revenueCents + rest.revenueCents).toBe(whole.revenueCents);
  });

  it("is exactly the old split when the payment carried no tax", () => {
    for (const [r, total, sur, tip] of [
      [1, 10_300, 300, 0],
      [5_150, 10_300, 300, 0],
      [10_750, 10_750, 250, 500],
      [5_750, 11_500, 0, 1_500],
      [7_000, 7_000, 0, 0],
    ]) {
      const without = splitRefund(r, total, sur, tip);
      expect(splitRefund(r, total, sur, tip, 0)).toEqual(without);
      expect(without.taxCents).toBe(0);
    }
  });

  it("treats a chargeback's whole charge as its base, taking out only the tax", () => {
    // What the webhook does for a dispute: surcharge and tip stay in (the bank
    // takes them too), only the tax share is not revenue.
    const s = splitRefund(12_125, 12_125, 0, 0, 825);
    expect(s.taxCents).toBe(825);
    expect(s.revenueCents).toBe(12_125 - 825);
  });
});

describe("everything that files or previews a refund passes the tax", () => {
  it("the webhook, for a refund and for a dispute", () => {
    const hook = code("src/routes/api/public/hooks/stripe.ts");
    // Both refund paths: the payment's own tax as the fifth argument.
    expect(hook.match(/Number\((?:rpay|pay)\.tip_cents \?\? 0\),\s*Number\((?:rpay|pay)\.tax_cents \?\? 0\),\s*\)/g)?.length).toBe(2);
    // The dispute path.
    expect(hook).toMatch(/revenueAmount = splitRefund\(amount, chargeTotal, 0, 0, Number\(pay\.tax_cents \?\? 0\)\)/);
    // And both reads of the payment select its tax.
    expect(hook.match(/amount_cents, surcharge_cents, tip_cents, tax_cents/g)?.length).toBe(2);
  });

  it("the office's Refund dialog and the activity entry it writes", () => {
    const server = code("src/lib/refunds.server.ts");
    expect(server).toMatch(/taxCents: Math\.max\(Number\(\(pay as \{ tax_cents\?: number \| null \}\)\.tax_cents \?\? 0\), 0\)/);
    expect(server).toMatch(/quote\.taxCents \?\? 0,\s*\)/);
    expect(server).toMatch(/tax_cents: split\.taxCents/);
    const dialog = code("src/components/RefundPaymentAction.tsx");
    expect(dialog).toMatch(/quote\.taxCents \?\? 0,\s*\)/);
    expect(dialog).toMatch(/of it is sales tax/);
  });

  it("the prepaid credit reversal takes back the pre-tax share only", () => {
    const mig = readFileSync(
      join(ROOT, "supabase/migrations/20260929110000_tax-was-always-zero-and-could-not-be-anything-else.sql"),
      "utf8",
    );
    expect(mig).toMatch(/_granted := COALESCE\(_total, 0\) - _tax;/);
    expect(mig).toMatch(/_refunded_cents - public\.sales_tax_share_cents\(_refunded_cents, _tax, _total\)/);
  });
});
