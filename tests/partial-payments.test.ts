import { describe, expect, it } from "vitest";
import { arPositionAsOf, outstandingAsOf, summarizeAr, type LedgerInvoice } from "@/lib/ar";
import { attachDatedPartialPayments } from "@/lib/partial-payments.server";
import { SERVICE_LINES } from "@/lib/service-lines";

type Payment = {
  organization_id: string;
  invoice_id: string;
  status: string;
  amount_cents: number;
  refunded_cents: number | null;
  paid_at: string | null;
  created_at: string;
  raw_event: { partial?: boolean };
};

const orgId = "test-refund-org";
const issued = "2026-11-01T12:00:00Z";
const payment = (over: Partial<Payment> = {}): Payment => ({
  organization_id: orgId,
  invoice_id: "invoice",
  status: "succeeded",
  amount_cents: 15_000,
  refunded_cents: 0,
  paid_at: "2026-11-02T12:00:00Z",
  created_at: "2026-11-02T11:00:00Z",
  raw_event: { partial: true },
  ...over,
});

function paymentDb(payments: Payment[]) {
  return {
    from(table: string) {
      expect(table).toBe("payments");
      let rows = [...payments];
      let columns: string[] = [];
      const query = {
        select(value: string) {
          columns = value.split(",").map((c) => c.trim());
          return query;
        },
        eq(column: string, value: unknown) {
          rows = rows.filter((row) =>
            column === "raw_event->>partial"
              ? String(row.raw_event.partial) === value
              : row[column as keyof Payment] === value,
          );
          return query;
        },
        in(column: string, values: string[]) {
          rows = rows.filter((row) => values.includes(String(row[column as keyof Payment])));
          return query;
        },
        then(resolve: (result: unknown) => void) {
          resolve({
            data: rows.map((row) =>
              Object.fromEntries(columns.map((column) => [column, row[column as keyof Payment]])),
            ),
            error: null,
          });
        },
      };
      return query;
    },
  };
}

const invoice = (over: Partial<LedgerInvoice & { id: string }> = {}) => ({
  id: "invoice",
  status: "open",
  total_cents: 35_000,
  amount_paid_cents: 0,
  issued_at: issued,
  ...over,
});

describe("attachDatedPartialPayments", () => {
  it.each([
    ["succeeded", "succeeded", 0, 15_000],
    ["succeeded with a partial refund", "succeeded", 5_000, 10_000],
    ["succeeded with a full refund", "succeeded", 15_000, 0],
    ["succeeded with a refund above the payment", "succeeded", 20_000, 0],
    ["partly refunded", "refunded", 5_000, 10_000],
    ["fully refunded", "refunded", 15_000, 0],
    ["legacy full refund", "refunded", 0, 0],
    ["legacy full refund with no amount", "refunded", null, 0],
    ["refund above the payment", "refunded", 20_000, 0],
  ])("counts what was kept from a %s payment", async (_label, status, refunded, kept) => {
    const book = [invoice()];
    await attachDatedPartialPayments(
      paymentDb([payment({ status, refunded_cents: refunded })]),
      orgId,
      book,
    );
    expect(book[0].paymentsAsOf).toEqual([{ amount_cents: kept, paid_at: "2026-11-02T12:00:00Z" }]);
    expect(outstandingAsOf(book[0], "2026-11-03", "UTC")).toBe(35_000 - kept);
  });

  it.each(SERVICE_LINES)("nets refunds and a later top-up for %s invoices", async (serviceLine) => {
    const book = [
      invoice({ amount_paid_cents: 20_000 }),
      invoice({ id: "later", total_cents: 50_000 }),
    ].map((row) => ({ ...row, service_line: serviceLine }));
    await attachDatedPartialPayments(
      paymentDb([
        payment({ status: "refunded", refunded_cents: 5_000 }),
        payment({ status: "refunded", refunded_cents: 15_000 }),
        payment({
          amount_cents: 10_000,
          paid_at: null,
          created_at: "2026-11-04T12:00:00Z",
          raw_event: {},
        }),
        payment({ status: "pending", amount_cents: 100_000 }),
        payment({ status: "failed", amount_cents: 100_000 }),
        payment({ organization_id: "another-org", amount_cents: 100_000 }),
      ]),
      orgId,
      book,
    );
    expect(book[0].paymentsAsOf).toEqual([
      { amount_cents: 10_000, paid_at: "2026-11-02T12:00:00Z" },
      { amount_cents: 0, paid_at: "2026-11-02T12:00:00Z" },
      { amount_cents: 10_000, paid_at: "2026-11-04T12:00:00Z" },
    ]);
    expect(outstandingAsOf(book[0], "2026-11-01", "UTC")).toBe(35_000);
    expect(outstandingAsOf(book[0], "2026-11-03", "UTC")).toBe(25_000);
    const position = arPositionAsOf(book, "2026-11-05", "UTC");
    expect(position.outstandingCents).toBe(65_000);
    expect(Object.values(position.aging).reduce((sum, amount) => sum + amount, 0)).toBe(65_000);
    expect(summarizeAr(book, "2026-11-05").arOpenCents).toBe(65_000);
  });

  it("includes the kept deposit and top-up once on the stay invoice", async () => {
    const book = [
      invoice({ id: "stay", amount_paid_cents: 20_000 }),
      invoice({ id: "deposit", total_cents: 15_000, deposit_for_invoice_id: "stay" }),
      invoice({ id: "later", total_cents: 50_000 }),
    ];
    await attachDatedPartialPayments(
      paymentDb([
        payment({
          invoice_id: "deposit",
          status: "refunded",
          refunded_cents: 5_000,
          raw_event: {},
        }),
        payment({ invoice_id: "stay", amount_cents: 10_000, paid_at: "2026-11-04T12:00:00Z" }),
      ]),
      orgId,
      book,
    );
    expect(book[0].paymentsAsOf).toEqual([
      { amount_cents: 10_000, paid_at: "2026-11-04T12:00:00Z" },
      { amount_cents: 10_000, paid_at: "2026-11-02T12:00:00Z" },
    ]);
    expect(arPositionAsOf(book, "2026-11-05", "UTC").outstandingCents).toBe(65_000);
  });
});
