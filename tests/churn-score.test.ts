import { describe, expect, it } from "vitest";
import { scoreChurnSignals, type ChurnSignals } from "@/lib/churn-score";

// Churn risk stopped being a model call on 2026-10-03 (src/lib/churn-score.ts
// has the weights and the reasoning). These are the cases an owner would use
// to decide whether to trust the number: a client they know is fine, a client
// they know is drifting, and the edges of the scale.

const base: ChurnSignals = {
  client_id: "c1",
  display_name: "Pat Example",
  tenure_days: 400,
  days_since_last_visit: 3,
  completed_last_30: 4,
  skipped_last_30: 0,
  unpaid_invoice_count: 0,
  unpaid_total_cents: 0,
  sms_opt_out: false,
};
const sig = (o: Partial<ChurnSignals>): ChurnSignals => ({ ...base, ...o });

describe("scoreChurnSignals", () => {
  it("scores a healthy weekly client at the bottom of the scale", () => {
    const r = scoreChurnSignals(base);
    expect(r.score).toBe(0);
    expect(r.reason).toBe("Visiting regularly with nothing unpaid.");
  });

  it("scores 40 days without a visit and $250 unpaid as high risk", () => {
    const r = scoreChurnSignals(
      sig({
        days_since_last_visit: 40,
        completed_last_30: 0,
        unpaid_invoice_count: 1,
        unpaid_total_cents: 25_000,
      }),
    );
    // 15 + 18 for recency, 25 for the balance.
    expect(r.score).toBe(58);
    expect(r.reason).toBe("No visit in 40 days and $250.00 unpaid.");
  });

  it("names the biggest factor first", () => {
    // $50 unpaid is about 6 points; two skips are 20. Skips lead.
    const r = scoreChurnSignals(
      sig({ skipped_last_30: 2, unpaid_invoice_count: 1, unpaid_total_cents: 5_000, completed_last_30: 2 }),
    );
    expect(r.reason).toMatch(/^2 skipped visits in 30 days and \$50\.00 unpaid\.$/);
  });

  it("caps at 100", () => {
    const r = scoreChurnSignals({
      ...base,
      tenure_days: 45,
      days_since_last_visit: 90,
      completed_last_30: 0,
      skipped_last_30: 5,
      unpaid_invoice_count: 4,
      unpaid_total_cents: 90_000,
      sms_opt_out: true,
    });
    expect(r.score).toBe(100);
  });

  it("never goes below 0", () => {
    // A new client earns 10; four recent visits take 10 off. Nothing else.
    const r = scoreChurnSignals(sig({ tenure_days: 20, completed_last_30: 4 }));
    expect(r.score).toBe(0);
    // And the reason says why the number is low despite the factor.
    expect(r.reason).toBe("Joined 20 days ago; 4 visits completed in 30 days.");
  });

  it("does not penalise a biweekly gap", () => {
    expect(scoreChurnSignals(sig({ days_since_last_visit: 14, completed_last_30: 2 })).score).toBe(0);
    expect(scoreChurnSignals(sig({ days_since_last_visit: 21, completed_last_30: 2 })).score).toBe(0);
    expect(scoreChurnSignals(sig({ days_since_last_visit: 22, completed_last_30: 1 })).score).toBe(15);
  });

  it("treats no visit in the lookback as the full recency weight for an established client", () => {
    const r = scoreChurnSignals(sig({ days_since_last_visit: null, completed_last_30: 0 }));
    expect(r.score).toBe(35);
    expect(r.reason).toBe("No completed visit in the last 30 days.");
  });

  it("does not put a client who signed up last week on the watch list for having no visit yet", () => {
    const r = scoreChurnSignals(
      sig({ tenure_days: 9, days_since_last_visit: null, completed_last_30: 0 }),
    );
    // Only the new-client weight; nine days without a visit is inside the grace.
    expect(r.score).toBe(10);
    expect(r.reason).toBe("Joined 9 days ago.");
  });

  it("adds weight for a second unpaid invoice and says how many", () => {
    const one = scoreChurnSignals(sig({ unpaid_invoice_count: 1, unpaid_total_cents: 10_000 }));
    const two = scoreChurnSignals(sig({ unpaid_invoice_count: 2, unpaid_total_cents: 10_000 }));
    expect(two.score - one.score).toBe(5);
    expect(two.reason).toMatch(/\$100\.00 unpaid across 2 invoices/);
  });

  it("returns integers within 0-100 and the same answer every time", () => {
    const s = sig({
      days_since_last_visit: 33,
      skipped_last_30: 1,
      unpaid_invoice_count: 1,
      unpaid_total_cents: 12_345,
      sms_opt_out: true,
      completed_last_30: 1,
    });
    const a = scoreChurnSignals(s);
    const b = scoreChurnSignals({ ...s });
    expect(a).toEqual(b);
    expect(Number.isInteger(a.score)).toBe(true);
    expect(a.score).toBeGreaterThanOrEqual(0);
    expect(a.score).toBeLessThanOrEqual(100);
  });
});
