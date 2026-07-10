import { describe, expect, it } from "vitest";
import { outstandingByClient, sumOutstandingCents, invoiceOutstandingCents } from "@/lib/ar";

// Finding #7: Clients "Outstanding", Dashboard "AR Open", and Reports
// "Outstanding" must agree for the same invoice data. They now share this
// math; the fixture mirrors the demo tenant (12 open invoices → $5,270.00).
const INVOICES = [
  ...Array.from({ length: 11 }, (_, i) => ({ status: "open", total_cents: 44000, client_id: `c${i}` })),
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
});
