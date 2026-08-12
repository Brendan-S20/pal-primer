import { describe, expect, it } from "vitest";
import {
  outstandingByClient,
  sumOutstandingCents,
  invoiceOutstandingCents,
  isInvoiceOverdue,
  summarizeAr,
} from "@/lib/ar";

// Finding #7: Clients "Outstanding", Dashboard "AR Open", and Reports
// "Outstanding" must agree for the same invoice data. They now share this
// math; the fixture mirrors the demo tenant (12 open invoices → $5,270.00).
const INVOICES = [
  ...Array.from({ length: 11 }, (_, i) => ({
    status: "open",
    total_cents: 44000,
    client_id: `c${i}`,
  })),
  { status: "open", total_cents: 43000, client_id: "c0" },
  { status: "paid", total_cents: 90000, client_id: "c0" },
  { status: "void", total_cents: 10000, client_id: "c1" },
  { status: "draft", total_cents: 5000, client_id: "c2" },
];

describe("shared AR math (finding #7)", () => {
  it("sums only open/overdue invoices by total_cents", () => {
    expect(sumOutstandingCents(INVOICES)).toBe(11 * 44000 + 43000); // $5,270.00
  });

  it("the by-client grouping totals to the same figure", () => {
    const byClient = outstandingByClient(INVOICES);
    const regrouped = [...byClient.values()].reduce((a, b) => a + b, 0);
    expect(regrouped).toBe(sumOutstandingCents(INVOICES));
  });

  it("excludes paid/void/draft invoices from a client's balance", () => {
    const byClient = outstandingByClient(INVOICES);
    // c0 has one open $440 + one open $430; its paid $900 must not count.
    expect(byClient.get("c0")).toBe(44000 + 43000);
    // c1 has one open $440; its extra void invoice must not add to the balance.
    expect(byClient.get("c1")).toBe(44000);
  });

  it("counts open as outstanding but never paid or uncollectible", () => {
    expect(invoiceOutstandingCents({ status: "open", total_cents: 5000 })).toBe(5000);
    expect(invoiceOutstandingCents({ status: "paid", total_cents: 5000 })).toBe(0);
    expect(invoiceOutstandingCents({ status: "uncollectible", total_cents: 5000 })).toBe(0);
  });

  it("nets applied credit out of an open invoice's balance (B7)", () => {
    expect(
      invoiceOutstandingCents({ status: "open", total_cents: 5000, credit_applied_cents: 2000 }),
    ).toBe(3000);
    // Never negative, even if data is inconsistent.
    expect(
      invoiceOutstandingCents({ status: "open", total_cents: 5000, credit_applied_cents: 9000 }),
    ).toBe(0);
  });

  it("regression (B1): a row fetched WITHOUT its status sums to zero — the select must include status", () => {
    // This is exactly how the dashboard read $0.00 while Reports read $4,805:
    // the dashboard query filtered on status server-side but didn't SELECT it.
    expect(invoiceOutstandingCents({ total_cents: 44000 } as any)).toBe(0);
  });
});

// B1: the dashboard's AR/overdue cards must equal the invoice ledger math.
// Fixture mirrors the QA round-3 demo tenant: 13 open invoices = $4,805.00,
// 8 of them past due_on ("Invoices page shows $4,805.00 outstanding, 13 open,
// 8 overdue" while the dashboard claimed $0 / nothing overdue).
describe("summarizeAr — dashboard equals the ledger (B1, I13 #1)", () => {
  const TODAY = "2026-07-17";
  const LEDGER = [
    // 8 overdue open invoices (due before today)
    ...Array.from({ length: 8 }, (_, i) => ({
      status: "open",
      total_cents: 40000,
      due_on: "2026-07-16",
      client_id: `c${i}`,
    })),
    // 5 open but not yet due
    ...Array.from({ length: 5 }, (_, i) => ({
      status: "open",
      total_cents: 32100,
      due_on: "2026-07-31",
      client_id: `d${i}`,
    })),
    // noise that must not count
    { status: "paid", total_cents: 90000, due_on: "2026-07-01", client_id: "x" },
    { status: "void", total_cents: 1500, due_on: "2026-07-01", client_id: "x" },
    { status: "draft", total_cents: 7000, due_on: null, client_id: "x" },
    { status: "uncollectible", total_cents: 12000, due_on: "2026-01-01", client_id: "x" },
  ];

  it("matches the invoice ledger exactly: $4,805.00 open across 13, 8 overdue", () => {
    const s = summarizeAr(LEDGER, TODAY);
    expect(s.arOpenCents).toBe(480500); // $4,805.00
    expect(s.openCount).toBe(13);
    expect(s.overdueCount).toBe(8);
    expect(s.overdueCents).toBe(8 * 40000);
    // Dashboard figure === straight ledger sum (no drift possible).
    expect(s.arOpenCents).toBe(sumOutstandingCents(LEDGER));
  });

  it("overdue keys on due_on, not issued_at + 30 days", () => {
    expect(
      isInvoiceOverdue({ status: "open", total_cents: 100, due_on: "2026-07-16" }, TODAY),
    ).toBe(true);
    expect(
      isInvoiceOverdue({ status: "open", total_cents: 100, due_on: "2026-07-17" }, TODAY),
    ).toBe(false);
    expect(isInvoiceOverdue({ status: "open", total_cents: 100, due_on: null }, TODAY)).toBe(false);
    expect(
      isInvoiceOverdue({ status: "paid", total_cents: 100, due_on: "2026-01-01" }, TODAY),
    ).toBe(false);
  });

  it("overdue balances are net of applied credit", () => {
    const s = summarizeAr(
      [{ status: "open", total_cents: 10000, credit_applied_cents: 4000, due_on: "2026-07-01" }],
      TODAY,
    );
    expect(s.overdueCents).toBe(6000);
    expect(s.arOpenCents).toBe(6000);
  });
});
