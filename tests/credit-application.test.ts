import { describe, expect, it } from "vitest";
import { computeCreditApplication } from "@/lib/ar";

// B7 / I13 #5: credit-application money math. computeCreditApplication is the
// pure mirror of the SQL writer public.apply_credit_to_invoice (migration
// 20260717090000_credit-application.sql) — same inputs, same amounts — so the
// arithmetic is regression-tested without a database.
describe("computeCreditApplication (B7)", () => {
  const open = (totalCents: number, creditAppliedCents = 0) => ({
    status: "open",
    total_cents: totalCents,
    credit_applied_cents: creditAppliedCents,
  });

  it("applies min(credit balance, open amount): balance smaller (Bark Park: $20 credit, $1,695 open)", () => {
    const r = computeCreditApplication({ creditBalanceCents: 2000, invoice: open(169500) });
    expect(r.applyCents).toBe(2000);
    expect(r.remainingDueCents).toBe(167500);
    expect(r.invoiceStatus).toBe("open"); // partially covered stays open
  });

  it("applies min(credit balance, open amount): balance larger — invoice fully paid, credit remains", () => {
    const r = computeCreditApplication({ creditBalanceCents: 50000, invoice: open(12000) });
    expect(r.applyCents).toBe(12000); // never more than the open amount
    expect(r.remainingDueCents).toBe(0);
    expect(r.invoiceStatus).toBe("paid");
  });

  it("exact cover flips to paid", () => {
    const r = computeCreditApplication({ creditBalanceCents: 12000, invoice: open(12000) });
    expect(r.applyCents).toBe(12000);
    expect(r.remainingDueCents).toBe(0);
    expect(r.invoiceStatus).toBe("paid");
  });

  it("respects credit already applied: only the remaining open amount can take credit", () => {
    const r = computeCreditApplication({ creditBalanceCents: 10000, invoice: open(10000, 7000) });
    expect(r.applyCents).toBe(3000);
    expect(r.remainingDueCents).toBe(0);
    expect(r.invoiceStatus).toBe("paid");
  });

  it("no credit -> nothing applied, nothing changes", () => {
    const r = computeCreditApplication({ creditBalanceCents: 0, invoice: open(5000) });
    expect(r.applyCents).toBe(0);
    expect(r.remainingDueCents).toBe(5000);
    expect(r.invoiceStatus).toBe("open");
  });

  it("negative balances never apply (no minting money from a corrected over-grant)", () => {
    const r = computeCreditApplication({ creditBalanceCents: -4000, invoice: open(5000) });
    expect(r.applyCents).toBe(0);
    expect(r.remainingDueCents).toBe(5000);
  });

  it("idempotent under double-click: re-running after a full application applies nothing more", () => {
    // First click: $30 balance fully covers a $30 invoice.
    const first = computeCreditApplication({ creditBalanceCents: 3000, invoice: open(3000) });
    expect(first.invoiceStatus).toBe("paid");
    // Second click sees the post-application state (paid, credit consumed).
    const second = computeCreditApplication({
      creditBalanceCents: 3000 - first.applyCents,
      invoice: { status: "paid", total_cents: 3000, credit_applied_cents: first.applyCents },
    });
    expect(second.applyCents).toBe(0);
    expect(second.remainingDueCents).toBe(0);
  });

  it("only open invoices take credit (paid/void/draft don't)", () => {
    for (const status of ["paid", "void", "draft", "uncollectible"]) {
      const r = computeCreditApplication({
        creditBalanceCents: 9999,
        invoice: { status, total_cents: 5000, credit_applied_cents: 0 },
      });
      expect(r.applyCents).toBe(0);
    }
  });

  it("prepaid top-ups never take credit (paying a top-up GRANTS credit — circular)", () => {
    const r = computeCreditApplication({
      creditBalanceCents: 9999,
      invoice: { ...open(5000), kind: "prepaid_topup" },
    });
    expect(r.applyCents).toBe(0);
    expect(r.remainingDueCents).toBe(5000);
    expect(r.invoiceStatus).toBe("open");
  });

  it("autopay ordering (I8): credit first, card charges only the remainder", () => {
    // $50 credit against a $120 invoice: apply $50, then the saved card is
    // charged exactly the remaining $70 — never the gross total.
    const r = computeCreditApplication({ creditBalanceCents: 5000, invoice: open(12000) });
    expect(r.applyCents).toBe(5000);
    const cardChargeCents = r.remainingDueCents;
    expect(cardChargeCents).toBe(7000);
    expect(r.applyCents + cardChargeCents).toBe(12000);
  });
});
