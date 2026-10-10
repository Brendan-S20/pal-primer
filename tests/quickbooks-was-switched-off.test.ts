// QuickBooks was switched off.
//
// The live sync was built and disabled (until 2026-10-09), so an owner moving
// their books had nothing to give a bookkeeper but monthly totals. The file
// stays as the no-connection alternative now that the sync is on. QuickBooks Online imports invoices from a CSV with no connection at
// all, and the accountant pack now produces that file. These pin the
// importer's rules, because each one it breaks fails the WHOLE import, not
// one row: 100 invoices and 1,000 rows per file, no negative amounts, and
// nothing in the file that is not an invoice line.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { qboDate, qboRows, splitForImport, type QboInvoice } from "@/lib/quickbooks-import";
import { REPORT_DEFS } from "@/lib/cpa-reports";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const inv = (n: number, lines: number[], extra: Partial<QboInvoice> = {}): QboInvoice => ({
  invoiceNo: `INV-${n}`,
  customer: `Customer ${n}`,
  issuedDay: "2026-09-01",
  dueOn: "2026-09-16",
  totalCents: lines.reduce((s, x) => s + x, 0),
  lines: lines.map((a, i) => ({ description: `Line ${i + 1}`, amountCents: a })),
  ...extra,
});

describe("the rows", () => {
  it("are one per line, repeating the invoice on each", () => {
    const { rows } = qboRows([inv(1001, [9600, 3600])]);
    expect(rows).toEqual([
      {
        invoiceNo: "INV-1001",
        customer: "Customer 1001",
        invoiceDate: "09/01/2026",
        dueDate: "09/16/2026",
        description: "Line 1",
        quantity: 1,
        rateCents: 9600,
        amountCents: 9600,
      },
      expect.objectContaining({ invoiceNo: "INV-1001", description: "Line 2", amountCents: 3600 }),
    ]);
  });

  it("dates in MM/DD/YYYY, and falls back to the invoice date when there is no due date", () => {
    expect(qboDate("2026-01-31")).toBe("01/31/2026");
    expect(qboDate("garbage")).toBe("");
    expect(qboRows([inv(1, [100], { dueOn: null })]).rows[0].dueDate).toBe("09/01/2026");
  });

  it("leaves out an invoice with a credit line, and says so, rather than drop the discount", () => {
    const { rows, excluded } = qboRows([inv(1, [9600, -300]), inv(2, [500])]);
    expect(rows.map((r) => r.invoiceNo)).toEqual(["INV-2"]);
    expect(excluded).toEqual([
      expect.objectContaining({
        invoiceNo: "INV-1",
        reason: expect.stringMatching(/credit or discount/),
      }),
    ]);
  });

  it("leaves out an invoice whose lines do not make its total", () => {
    const { excluded } = qboRows([inv(1, [100, 200], { totalCents: 350 })]);
    expect(excluded[0].reason).toMatch(/do not add up/);
  });

  it("leaves out an invoice with no lines", () => {
    expect(qboRows([inv(1, [])]).excluded[0].reason).toMatch(/no lines/);
  });
});

describe("the files", () => {
  it("hold at most 100 invoices each", () => {
    const { rows } = qboRows(Array.from({ length: 250 }, (_, i) => inv(i, [100])));
    const files = splitForImport(rows);
    expect(files.map((f) => f.length)).toEqual([100, 100, 50]);
  });

  it("hold at most 1,000 rows each, and never split an invoice", () => {
    // 30 invoices of 40 lines: 25 fit in 1,000 rows, the 26th starts file two.
    const { rows } = qboRows(Array.from({ length: 30 }, (_, i) => inv(i, Array(40).fill(100))));
    const files = splitForImport(rows);
    expect(files.map((f) => f.length)).toEqual([1000, 200]);
    for (const f of files) {
      const first = f[0].invoiceNo;
      const last = f[f.length - 1].invoiceNo;
      // No invoice appears in two files.
      expect(files.filter((g) => g.some((r) => r.invoiceNo === first)).length).toBe(1);
      expect(files.filter((g) => g.some((r) => r.invoiceNo === last)).length).toBe(1);
    }
  });

  it("is one file when it fits", () => {
    const { rows } = qboRows([inv(1, [100, 200]), inv(2, [300])]);
    expect(splitForImport(rows)).toHaveLength(1);
  });
});

describe("the accountant pack", () => {
  it("offers it, marked as a file to import rather than a sheet to read", () => {
    const d = REPORT_DEFS.quickbooks_invoices;
    expect(d.importFile).toBe(true);
    expect(d.columns.map((c) => c.label)).toEqual([
      "Invoice No.",
      "Customer",
      "Invoice Date",
      "Due Date",
      "Item Description",
      "Item Quantity",
      "Item Rate",
      "Item Amount",
    ]);
  });

  it("downloads rows only, split, with no totals or definition lines in the file", () => {
    const page = read("src/routes/_authenticated/tax-reports.tsx");
    const branch = page
      .slice(page.indexOf("if (r.importFile) {"), page.indexOf("const body: Array"))
      .replace(/\/\/[^\n]*/g, "");
    expect(branch).toMatch(/splitForImport\(/);
    expect(branch).toMatch(/return;/);
    expect(branch).not.toMatch(/totals/);
    expect(branch).not.toMatch(/r\.purpose|r\.note|r\.caveats/);
  });

  it("has no totals line to leak into the file", () => {
    const fns = read("src/lib/cpa-reports.functions.ts");
    const b = fns.slice(fns.indexOf("async function buildQuickbooksInvoices"));
    expect(b.slice(0, b.indexOf("\n}\n"))).toMatch(/totals: null/);
  });
});
