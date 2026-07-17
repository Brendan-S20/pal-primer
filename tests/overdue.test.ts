import { describe, expect, it } from "vitest";
import { isInvoiceOverdue, summarizeOpenInvoices } from "@/lib/overdue";

// QA round 3, I13 #13: portal balances, due dates, and overdue state must be
// computed from one shared implementation. Fixture mirrors the G1 repro:
// two open invoices ($295 + $1,400), the $1,400 one overdue since Jul 16.
const TODAY = "2026-07-17";

const INVOICES = [
  { status: "open", total_cents: 29500, due_on: "2026-07-31" },
  { status: "open", total_cents: 140000, due_on: "2026-07-16" },
  { status: "paid", total_cents: 50000, due_on: "2026-06-01" },
  { status: "void", total_cents: 12000, due_on: "2026-06-15" },
  { status: "draft", total_cents: 8000, due_on: null },
  { status: "uncollectible", total_cents: 7000, due_on: "2026-01-01" },
];

describe("isInvoiceOverdue", () => {
  it("is overdue when open and past the due date", () => {
    expect(isInvoiceOverdue("open", "2026-07-16", TODAY)).toBe(true);
  });

  it("is not overdue on the due date itself", () => {
    expect(isInvoiceOverdue("open", TODAY, TODAY)).toBe(false);
  });

  it("is not overdue before the due date", () => {
    expect(isInvoiceOverdue("open", "2026-07-31", TODAY)).toBe(false);
  });

  it("never marks paid, void, draft, or uncollectible invoices overdue", () => {
    for (const status of ["paid", "void", "draft", "uncollectible"]) {
      expect(isInvoiceOverdue(status, "2020-01-01", TODAY)).toBe(false);
    }
  });

  it("is not overdue without a due date", () => {
    expect(isInvoiceOverdue("open", null, TODAY)).toBe(false);
    expect(isInvoiceOverdue("open", undefined, TODAY)).toBe(false);
  });
});

describe("summarizeOpenInvoices (portal home card, G1)", () => {
  it("reports the G1 repro as 2 open · $1,695.00 · 1 overdue", () => {
    const s = summarizeOpenInvoices(INVOICES, TODAY);
    expect(s.openCount).toBe(2);
    expect(s.openTotalCents).toBe(169500); // $1,695.00
    expect(s.overdueCount).toBe(1);
  });

  it("only counts status open as owed (drafts are quotes, uncollectible is written off)", () => {
    const s = summarizeOpenInvoices(
      [
        { status: "draft", total_cents: 1000, due_on: "2020-01-01" },
        { status: "uncollectible", total_cents: 2000, due_on: "2020-01-01" },
        { status: "paid", total_cents: 3000, due_on: "2020-01-01" },
        { status: "void", total_cents: 4000, due_on: "2020-01-01" },
      ],
      TODAY,
    );
    expect(s).toEqual({ openCount: 0, openTotalCents: 0, overdueCount: 0, nextDueOn: null });
  });

  it("treats missing totals as zero and surfaces the soonest open due date", () => {
    const s = summarizeOpenInvoices(
      [
        { status: "open", total_cents: null, due_on: "2026-08-02" },
        { status: "open", total_cents: 500, due_on: "2026-07-20" },
        { status: "open", total_cents: 250 }, // no due date at all
      ],
      TODAY,
    );
    expect(s.openCount).toBe(3);
    expect(s.openTotalCents).toBe(750);
    expect(s.overdueCount).toBe(0);
    expect(s.nextDueOn).toBe("2026-07-20");
  });

  it("nets applied credit out of the open total (B7)", () => {
    const s = summarizeOpenInvoices(
      [
        { status: "open", total_cents: 29500, credit_applied_cents: 10000, due_on: "2026-07-31" },
        { status: "open", total_cents: 140000, credit_applied_cents: 0, due_on: "2026-07-16" },
        { status: "paid", total_cents: 50000, credit_applied_cents: 50000, due_on: "2026-06-01" },
      ],
      TODAY,
    );
    expect(s.openCount).toBe(2);
    expect(s.openTotalCents).toBe(159500); // $1,595.00 after $100 credit
    expect(s.overdueCount).toBe(1);
  });

  it("handles an empty ledger", () => {
    expect(summarizeOpenInvoices([], TODAY)).toEqual({
      openCount: 0,
      openTotalCents: 0,
      overdueCount: 0,
      nextDueOn: null,
    });
  });
});
