// An invoice carries the rate it was made at. Changing the setting later
// changes invoices made later and nothing already issued -- the same rule
// visits.price_cents follows for the price of work already done.
//
// The SQL half (set_invoice_totals, and an UPDATE to the organization after an
// invoice exists) is proved in a real database by
// the-billing-run-charges-the-organizations-rate. This is the TypeScript half,
// and the displays: every surface that prints the tax line reads it off the
// INVOICE, never off the organization's current setting.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { freshState, manualInvoiceFakeDb } from "./helpers/manual-invoice-fake-db";

vi.mock("@/lib/activity.server", () => ({ logActivity: vi.fn(async () => {}) }));

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("the hand-made invoice snapshots the rate", () => {
  it("writes the rate and label in force at the moment it is made", async () => {
    const { insertManualInvoice } = await import("@/lib/manual-invoice.server");
    const state = freshState({
      org: { invoice_net_days: 15, timezone: "UTC", sales_tax_rate_bps: 700, sales_tax_label: "Service tax" },
    });
    await insertManualInvoice(manualInvoiceFakeDb(state) as never, {
      orgId: "0a000000-0000-4000-8000-0000000000aa",
      userId: "a0000000-0000-4000-8000-00000000a001",
      clientId: "c0000000-0000-4000-8000-0000000000a1",
      items: [{ description: "Cleanup", amountCents: 12_000 }],
    });
    // Change the setting after: the row already written is what it is.
    state.org.sales_tax_rate_bps = 1_000;
    state.org.sales_tax_label = "Other";
    await insertManualInvoice(manualInvoiceFakeDb(state) as never, {
      orgId: "0a000000-0000-4000-8000-0000000000aa",
      userId: "a0000000-0000-4000-8000-00000000a001",
      clientId: "c0000000-0000-4000-8000-0000000000a1",
      items: [{ description: "Cleanup", amountCents: 12_000 }],
    });
    const [first, second] = state.inserted.invoices;
    expect(first).toMatchObject({ tax_rate_bps: 700, tax_cents: 840, tax_label: "Service tax", total_cents: 12_840 });
    expect(second).toMatchObject({ tax_rate_bps: 1_000, tax_cents: 1_200, tax_label: "Other", total_cents: 13_200 });
  });
});

describe("the SQL writer snapshots the rate", () => {
  const mig = read(
    "supabase/migrations/20260929110000_tax-was-always-zero-and-could-not-be-anything-else.sql",
  );
  const writer = mig.slice(
    mig.indexOf("CREATE OR REPLACE FUNCTION public.set_invoice_totals"),
    mig.indexOf("COMMENT ON FUNCTION public.set_invoice_totals"),
  );

  it("stores the rate on the invoice, from the org and the client's exemption", () => {
    expect(writer).toMatch(/CASE WHEN c\.tax_exempt THEN 0 ELSE COALESCE\(o\.sales_tax_rate_bps, 0\) END/);
    expect(writer).toMatch(/tax_rate_bps\s+= _rate/);
    expect(writer).toMatch(/total_cents\s+= COALESCE\(_subtotal_cents, 0\) \+ _tax/);
  });

  it("is the only thing the generators call to write their totals", () => {
    expect(mig).toMatch(/PERFORM public\.set_invoice_totals\(_invoice_id, _total\);/);
    for (const fn of ["admin_generate_invoice_for_client", "generate_prepaid_invoice", "portal_start_prepaid_topup"]) {
      expect(mig).toContain(`'${fn}'`);
    }
  });
});

describe("every surface prints the tax the invoice carries", () => {
  const SURFACES: Array<[string, RegExp]> = [
    ["src/components/InvoiceDrawer.tsx", /taxLineLabel\(inv\.tax_label, inv\.tax_rate_bps\)/],
    ["src/routes/_authenticated/invoices.$invoiceId.tsx", /taxLineLabel\(invoice\.tax_label, invoice\.tax_rate_bps\)/],
    ["src/routes/pay.i.$token.tsx", /taxLineLabel\(invoice\.taxLabel, invoice\.taxRateBps\)/],
    ["src/routes/portal.$slug.$token.billing.tsx", /taxLineLabel\(i\.tax_label, i\.tax_rate_bps\)/],
    ["src/lib/document-pdf.server.ts", /taxLineLabel\(inv\.tax_label, inv\.tax_rate_bps\)/],
    ["src/lib/sales-tax.ts", /taxLineLabel\(inv\.tax_label, inv\.tax_rate_bps\)/], // the email
    ["src/lib/accounting.server.ts", /taxLineLabel\(invoice\.tax_label, invoice\.tax_rate_bps\)/],
  ];

  it.each(SURFACES)("%s", (file, pattern) => {
    const src = read(file);
    expect(src).toMatch(pattern);
    // Never the organization's live setting. (sales-tax.ts is the module that
    // defines the rule, and names the setting in its own documentation.)
    if (!file.endsWith("sales-tax.ts")) expect(src).not.toMatch(/sales_tax_rate_bps/);
  });

  it("draws the line only when the invoice has tax", () => {
    expect(read("src/components/InvoiceDrawer.tsx")).toMatch(/\{showsTaxLine\(inv\) && \(/);
    expect(read("src/routes/_authenticated/invoices.$invoiceId.tsx")).toMatch(/\{showsTaxLine\(invoice\) && \(/);
    expect(read("src/routes/pay.i.$token.tsx")).toMatch(/\{\(invoice\.taxCents \?\? 0\) > 0 && \(/);
    expect(read("src/routes/portal.$slug.$token.billing.tsx")).toMatch(/\{\(i\.tax_cents \?\? 0\) > 0 && \(/);
    expect(read("src/lib/pdf/invoice-pdf.ts")).toMatch(/if \(\(m\.taxCents \?\? 0\) > 0\)/);
    expect(read("src/lib/email-templates/invoice-sent.tsx")).toMatch(/\{taxCents > 0 \? \(/);
  });
});
