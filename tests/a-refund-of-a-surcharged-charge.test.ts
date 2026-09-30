import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitRefund } from "@/lib/refund-split";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** SQL with its comments removed. These migrations explain the defect they fix
 *  in prose, so `DO NOTHING` appears in the file describing what was replaced —
 *  matching raw text reports the fix as the bug. */
const sqlCode = (src: string) =>
  src
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");

// With pass-through on, a $100 invoice is charged as $103. The payment row
// keeps those apart on purpose — `surcharge_cents` sits beside `amount_cents`
// so the recovered fee is "reported as fee recovery and never as revenue".
//
// The refund path ignored the split. `charge.refunded` carries `amount_refunded`
// on the CHARGE (base + surcharge) and that went straight into the reversal
// ledger, which every revenue surface subtracts. Refunding in full took $103
// off revenue that had only ever contained $100.

describe("splitting a refund", () => {
  it("takes only the base off revenue when the whole charge is refunded", () => {
    // The bug, at its simplest: $103 left the bank, $100 leaves revenue.
    const s = splitRefund(10300, 10300, 300);
    expect(s.refundedCents).toBe(10300);
    expect(s.revenueCents).toBe(10000);
    expect(s.surchargeCents).toBe(300);
  });

  it("splits a partial refund in the charge's own ratio", () => {
    // Half the charge back → half the service and half the fee.
    const s = splitRefund(5150, 10300, 300);
    expect(s.refundedCents).toBe(5150);
    expect(s.revenueCents).toBe(5000);
    expect(s.surchargeCents).toBe(150);
  });

  it("never loses or invents a cent", () => {
    // Revenue is rounded and the surcharge is the remainder, so the parts add
    // back exactly — the property that matters when these land in a ledger.
    for (const refunded of [1, 7, 33, 99, 100, 1234, 5149, 10299, 10300]) {
      const s = splitRefund(refunded, 10300, 300);
      expect(s.revenueCents + s.surchargeCents).toBe(s.refundedCents);
    }
  });

  it("sums to the whole across a sequence of partials", () => {
    // Consistency under partials is the reason for a proportional split rather
    // than "surcharge comes off last" or "surcharge comes off first".
    const a = splitRefund(3000, 10300, 300);
    const whole = splitRefund(10300, 10300, 300);
    const rest = splitRefund(10300 - 3000, 10300, 300);
    expect(a.revenueCents + rest.revenueCents).toBe(whole.revenueCents);
    expect(a.surchargeCents + rest.surchargeCents).toBe(whole.surchargeCents);
  });

  it("passes the refund through untouched when the tenant absorbs the fee", () => {
    // The majority case, and every payment taken before pass-through existed.
    const s = splitRefund(10000, 10000, 0);
    expect(s.revenueCents).toBe(10000);
    expect(s.surchargeCents).toBe(0);
  });

  it("refuses to divide by a total it cannot trust", () => {
    // Understating revenue is survivable; a divide-by-zero or a negative
    // revenue line in a contra ledger is not.
    expect(splitRefund(5000, 0, 300).revenueCents).toBe(5000);
    expect(splitRefund(5000, 100, 300).revenueCents).toBe(5000);
    expect(splitRefund(-5, 10300, 300).revenueCents).toBe(0);
  });

  it("clamps a refund larger than the charge", () => {
    const s = splitRefund(99999, 10300, 300);
    expect(s.refundedCents).toBe(10300);
    expect(s.revenueCents).toBe(10000);
  });

  it("keeps revenue at or below the refund, never above", () => {
    // The direction that matters: this figure is SUBTRACTED from income, so an
    // overstatement here silently deletes a tenant's revenue.
    for (const total of [1000, 5000, 10300, 250000]) {
      for (const sur of [0, 30, 300, 7500]) {
        for (const ref of [1, total / 3, total / 2, total]) {
          const s = splitRefund(Math.round(ref), total, sur);
          expect(s.revenueCents).toBeLessThanOrEqual(s.refundedCents);
          expect(s.revenueCents).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

// ── The two ledger defects this split exists to fix ────────────────────────
//
// Both probed live against the migration, in a transaction cleaned up after:
//
//   1st partial refund $30.00 ............ amount 3000  revenue 2913
//   redelivery of the same event ......... amount 3000  revenue 2913
//   2nd partial, cumulative $80.00 ....... amount 8000  revenue 7767
//   late redelivery of the older event ... amount 8000  revenue 7767
//   rows filed ........................... 1
//
// The third line is the bug: `ON CONFLICT … DO NOTHING` discarded it, so the
// ledger said $30 for ever while $80 had left the bank. The fourth is why the
// fix uses GREATEST rather than plain assignment — webhook delivery is not
// ordered, and a late retry of the earlier event must not walk the total back.

describe("the reversal ledger migration", () => {
  const sql = sqlCode(
    readFileSync(
      join(
        ROOT,
        "supabase/migrations/20260804040000_the-second-partial-refund-was-never-deducted.sql",
      ),
      "utf8",
    ),
  );

  it("raises a repeat filing instead of discarding it", () => {
    expect(sql).not.toMatch(/ON CONFLICT[\s\S]{0,120}DO NOTHING/i);
    expect(sql).toMatch(/ON CONFLICT[\s\S]{0,120}DO UPDATE/i);
  });

  it("takes the maximum, so an out-of-order redelivery cannot lower the total", () => {
    expect(sql).toMatch(
      /GREATEST\(COALESCE\(\(review_items\.detail->>'amount_cents'\)::bigint, 0\), _amount_cents\)/,
    );
    expect(sql).toMatch(
      /GREATEST\(COALESCE\(\(review_items\.detail->>'revenue_cents'\)::bigint, 0\), _revenue\)/,
    );
  });

  it("records what MOVED and what comes off revenue as two fields", () => {
    expect(sql).toMatch(/'amount_cents', _amount_cents/);
    expect(sql).toMatch(/'revenue_cents', _revenue/);
    // An un-updated caller must keep the old behaviour exactly.
    expect(sql).toMatch(/_revenue bigint := coalesce\(_revenue_cents, _amount_cents\)/);
  });

  it("drops the old signature so no caller can keep using the broken one", () => {
    // Postgres overloads on argument list: leaving the 6-arg version in place
    // means half the callers reach the fixed function and half do not, with
    // nothing to show for it.
    expect(sql).toMatch(
      /DROP FUNCTION IF EXISTS public\.file_reversal_review_item\(uuid, uuid, text, bigint, uuid, text\);/,
    );
  });

  it("does not re-point adjustment_id on a later filing", () => {
    // The franchise adjustment belongs to the first filing's settlement row.
    expect(sql).not.toMatch(/SET detail[\s\S]{0,400}'adjustment_id',\s*COALESCE\(_adjustment_id/);
  });
});

describe("the webhook passes both numbers", () => {
  const src = readFileSync(join(ROOT, "src/routes/api/public/hooks/stripe.ts"), "utf8");

  it("splits a refund before filing it", () => {
    expect(src).toContain("splitRefund(");
    expect(src).toMatch(/_revenue_cents: revenueAmount/);
  });

  it("reads the surcharge off the payment to do the split", () => {
    // Without surcharge_cents in the select the split has nothing to divide by
    // and silently degrades to the old behaviour.
    expect(src).toMatch(/select\(\s*$|surcharge_cents/m);
    // tip_cents too: a tip is inside the same charge and was never revenue
    // either (a-customer-could-not-leave-a-tip).
    // tax_cents too since 20260929110000: the sales tax inside amount_cents
    // was never revenue either.
    expect(src).toMatch(
      /"id, organization_id, amount_cents, surcharge_cents, tip_cents, (?:tax_cents, )?status"/,
    );
  });

  it("leaves a chargeback whole", () => {
    // The bank takes the surcharge too and does not itemise it, so unlike a
    // refund the tenant does not keep the recovered fee.
    // Since sales tax the chargeback goes through splitRefund with a zero
    // surcharge and a zero tip, which is "whole" for both and takes only the
    // payment's sales-tax share back out (it was never revenue).
    expect(src).toMatch(
      /revenueAmount = amount;|revenueAmount = splitRefund\(amount, chargeTotal, 0, 0, Number\(pay\.tax_cents \?\? 0\)\)/,
    );
  });
});

describe("the saved-card path records the surcharge it charged", () => {
  it("passes surchargeCents to the paid flip", () => {
    // It charged quote.totalCents and reported dueCents, so surcharge_cents
    // read 0 for every saved-card charge that settled synchronously — which
    // then made the refund split above divide by the wrong base.
    const src = readFileSync(join(ROOT, "src/lib/invoices.functions.ts"), "utf8");
    expect(src).toMatch(/surchargeCents: quote\.surchargeCents/);
  });
});
