// The accountant pack said "Sales tax is not tracked". It now has a Sales tax
// collected sheet, by month; and the two places invoices leave HoundStack for
// somebody's books -- the QuickBooks import file and the live accounting sync
// -- carry the tax as a line of its own that never posts to income.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPORT_DEFS, REPORT_ORDER, salesTaxByMonth } from "@/lib/cpa-reports";
import { qboRows } from "@/lib/quickbooks-import";
import { accountingTaxLine } from "@/lib/accounting.server";

const ROOT = join(import.meta.dirname, "..");
const code = (p: string) => readFileSync(join(ROOT, p), "utf8").replace(/\/\/[^\n]*/g, "");

describe("the Sales tax collected sheet", () => {
  it("is in the pack, beside tips", () => {
    expect(REPORT_DEFS.sales_tax_collected.title).toBe("Sales tax collected, by month");
    expect(REPORT_ORDER.indexOf("sales_tax_collected")).toBe(REPORT_ORDER.indexOf("tips_received") + 1);
    expect(REPORT_DEFS.sales_tax_collected.columns.map((c) => c.key)).toEqual([
      "month",
      "taxBilledCents",
      "taxCollectedCents",
      "taxRefundedCents",
      "netTaxCollectedCents",
      "taxedPaymentCount",
    ]);
    expect(code("src/lib/cpa-reports.functions.ts")).toMatch(
      /case "sales_tax_collected":\s*built = await buildSalesTaxCollected\(supabase, ctx, from, to\);/,
    );
  });

  it("puts billed, collected and refunded tax in the month each happened", () => {
    const rows = salesTaxByMonth(
      ["2026-07", "2026-08"],
      [
        { day: "2026-07-03", taxCents: 825 },
        { day: "2026-07-28", taxCents: 825 },
        { day: "2026-08-02", taxCents: 0 },
      ],
      [
        { day: "2026-07-10", taxCents: 825 },
        { day: "2026-08-04", taxCents: 413 },
        { day: "2026-08-05", taxCents: 0 },
      ],
      [
        { day: "2026-08-20", taxCents: 825 }, // a July payment refunded in August
        { day: "2026-08-25", taxCents: -100 }, // a dispute won back
      ],
    );
    expect(rows).toEqual([
      { month: "2026-07", taxBilledCents: 1_650, taxCollectedCents: 825, taxRefundedCents: 0, netTaxCollectedCents: 825, taxedPaymentCount: 1 },
      { month: "2026-08", taxBilledCents: 0, taxCollectedCents: 413, taxRefundedCents: 725, netTaxCollectedCents: -312, taxedPaymentCount: 1 },
    ]);
  });

  it("no longer says sales tax is not tracked", () => {
    const src = code("src/lib/cpa-reports.functions.ts");
    expect(src).not.toMatch(/Sales tax is not tracked/);
    expect(src).toMatch(/Sales tax is billed at one rate per business/);
  });

  it("tells the owner at zero that most pet-waste services are not taxable", () => {
    expect(code("src/lib/cpa-reports.functions.ts")).toMatch(
      /Most pet-waste services are not taxable; some states do tax them\. Your accountant can tell you whether yours does\./,
    );
    expect(code("src/routes/_authenticated/settings.invoicing.tsx")).toMatch(/Most pet-waste services are not taxable/);
  });
});

describe("the QuickBooks import file", () => {
  it("adds the tax as the invoice's last line, so the lines still add up to its total", () => {
    const src = code("src/lib/cpa-reports.functions.ts");
    expect(src).toMatch(/description: taxLineLabel\(inv\.tax_label, inv\.tax_rate_bps\), amountCents: inv\.tax_cents \?\? 0/);
    // And the importer takes such an invoice rather than excluding it.
    const { rows, excluded } = qboRows([
      {
        invoiceNo: "INV-1042",
        customer: "Proof",
        issuedDay: "2026-07-03",
        dueOn: null,
        totalCents: 10_825,
        lines: [
          { description: "Weekly service", amountCents: 10_000 },
          { description: "Sales tax (8.25%)", amountCents: 825 },
        ],
      },
    ]);
    expect(excluded).toEqual([]);
    expect(rows.map((r) => r.amountCents)).toEqual([10_000, 825]);
  });
});

describe("the live accounting sync", () => {
  it("sends nothing new for an untaxed invoice", () => {
    expect(accountingTaxLine({ sales_tax_item_id: null }, { tax_cents: 0 })).toBeNull();
  });

  it("sends the tax as its own line through the sales-tax item", () => {
    expect(
      accountingTaxLine({ sales_tax_item_id: "33" }, { tax_cents: 825, tax_rate_bps: 825, tax_label: "Sales tax" }),
    ).toEqual({ description: "Sales tax (8.25%)", amountCents: 825, item: "33" });
  });

  it("refuses to sync a taxed invoice rather than post its tax to income", () => {
    expect(() => accountingTaxLine({ sales_tax_item_id: " " }, { tax_cents: 825 })).toThrow(
      /Choose a sales tax item/,
    );
  });

  it("builds that line through the same accountingLine as every other, through its own item", () => {
    const src = code("src/lib/accounting.server.ts");
    expect(src.match(/linesWithItems\(mapping, invoice, taxLine\)/g)?.length).toBe(1);
    expect(src).toMatch(/ItemRef: \{ value: item \}/);
    // A taxed invoice with no sales-tax item is refused before the customer
    // is created, not after: proved against a mocked QuickBooks in
    // tests/quickbooks-online-for-real.test.ts, and pinned here in the order.
    const sync = code("src/lib/qbo-sync.server.ts");
    expect(sync.indexOf("qboInvoiceBody(mapping, invoice")).toBeGreaterThan(-1);
    expect(sync.indexOf("qboInvoiceBody(mapping, invoice")).toBeLessThan(sync.indexOf("findOrCreateQboCustomer(qbo"));
  });
});
