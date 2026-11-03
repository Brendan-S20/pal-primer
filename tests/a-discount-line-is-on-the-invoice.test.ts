// A discount line is on the invoice (#653, R2-16 / F-09).
//
// Round-2 audit, 2026-10-30: New invoice accepted "-5.00" on a line and then
// dropped the line before it saved, so $20 - $5 was created as $20, $150 - $15
// as $150 and $70 - $5 as $70. Nothing said so. The form filtered every line
// at or below zero, and the server's schema refused below zero anyway.
//
// A minus line is now a discount, end to end: the form sends it, the server
// accepts it, and the invoice's subtotal, tax and total are net of it. The
// PDF, the portal and the pay page all read the stored lines and the stored
// total, and Stripe is charged one PaymentIntent for the invoice's balance, so
// none of them has a separate sum to get wrong. What a discount may not do is
// stated once, in src/lib/invoice-lines.ts, and refused in the same words by
// the form, the server function and insertManualInvoice.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DISCOUNT_MORE_THAN_CHARGES,
  DISCOUNT_NEEDS_ONE,
  DISCOUNT_NOT_ON_WORK,
  accountingLine,
  draftInvoiceItems,
  manualLinesProblem,
  type DraftInvoiceLine,
} from "@/lib/invoice-lines";
import { invoiceTotals } from "@/lib/sales-tax";
import {
  freshState,
  manualInvoiceFakeDb,
  type FakeDbState,
} from "./helpers/manual-invoice-fake-db";

vi.mock("@/lib/activity.server", () => ({ logActivity: vi.fn(async () => {}) }));

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const line = (description: string, price: string, quantity = "1"): DraftInvoiceLine => ({
  description,
  quantity,
  price,
});

describe("the New invoice form", () => {
  it.each([
    ["38.00", "-5.00", 3_300],
    ["20.00", "-5.00", 1_500],
    ["150.00", "-15.00", 13_500],
    ["70.00", "-5.00", 6_500],
  ])("sends $%s and a %s discount, and totals %i cents", (charge, discount, total) => {
    const r = draftInvoiceItems([line("Yard cleanup", charge), line("Loyalty discount", discount)]);
    expect(r.problem).toBeNull();
    expect(r.items).toHaveLength(2);
    expect(r.items[1]).toEqual({
      description: "Loyalty discount",
      amountCents: -Math.round(Number(discount.slice(1)) * 100),
    });
    expect(r.totalCents).toBe(total);
  });

  it("still leaves out a $0 line with no visit, and an empty one", () => {
    const r = draftInvoiceItems([line("Yard cleanup", "38"), line("Nothing", "0"), line("", "")]);
    expect(r.items.map((i) => i.amountCents)).toEqual([3_800]);
  });

  it("keeps an itemized charge beside a discount", () => {
    const r = draftInvoiceItems([line("Walk", "15.00", "3"), line("Discount", "-5")]);
    expect(r.items[0]).toEqual({
      description: "Walk",
      amountCents: 4_500,
      quantity: 3,
      unitAmountCents: 1_500,
    });
    expect(r.totalCents).toBe(4_000);
    expect(r.problem).toBeNull();
  });

  it("refuses, in words, a discount of more than one", () => {
    const r = draftInvoiceItems([line("Walk", "15"), line("Discount", "-2", "2")]);
    expect(r.problem).toBe(DISCOUNT_NEEDS_ONE);
  });

  it("refuses discounts that take the invoice to $0 or below", () => {
    expect(draftInvoiceItems([line("Walk", "5"), line("Discount", "-5")]).problem).toBe(
      DISCOUNT_MORE_THAN_CHARGES,
    );
    expect(draftInvoiceItems([line("Discount", "-5")]).problem).toBe(DISCOUNT_MORE_THAN_CHARGES);
    expect(draftInvoiceItems([line("Walk", "5.01"), line("Discount", "-5")]).problem).toBeNull();
  });

  it("refuses a discount on a visit's line or an add-on's", () => {
    expect(
      manualLinesProblem([
        { amountCents: 3_000 },
        { amountCents: -500, visitId: "00000000-0000-4000-8000-000000000001" },
      ]),
    ).toBe(DISCOUNT_NOT_ON_WORK);
    expect(
      manualLinesProblem([
        { amountCents: 3_000 },
        { amountCents: -500, addonChargeId: "00000000-0000-4000-8000-000000000002" },
      ]),
    ).toBe(DISCOUNT_NOT_ON_WORK);
  });

  it("no longer filters a minus line out, and lets a minus price be typed", () => {
    const src = read("src/routes/_authenticated/invoices.index.tsx");
    expect(src).not.toMatch(/amountCents > 0 \|\| l\.visitId/);
    expect(src).toContain("draftInvoiceItems(items)");
    expect(src).toContain("linesProblem");
    // The price input had min="0", which a browser also enforces on submit.
    const price = src.slice(src.indexOf("price each"), src.indexOf("price each") + 400);
    expect(price).not.toContain('min="0"');
  });
});

describe("the stored invoice", () => {
  let state: FakeDbState;
  beforeEach(() => {
    state = freshState();
  });

  async function make(amounts: number[]) {
    const { insertManualInvoice } = await import("@/lib/manual-invoice.server");
    return insertManualInvoice(manualInvoiceFakeDb(state) as never, {
      orgId: "0a000000-0000-4000-8000-0000000000aa",
      userId: "a0000000-0000-4000-8000-00000000a001",
      clientId: "c0000000-0000-4000-8000-0000000000a1",
      items: amounts.map((a, i) => ({ description: `Line ${i + 1}`, amountCents: a })),
    });
  }

  it("$38 - $5 is stored as $33, with both lines", async () => {
    const r = await make([3_800, -500]);
    expect(r.totalCents).toBe(3_300);
    expect(state.inserted.invoices[0]).toMatchObject({ subtotal_cents: 3_300, total_cents: 3_300 });
    expect(state.inserted.lines.map((l) => l.amount_cents)).toEqual([3_800, -500]);
    // A discount line is a total only: the database holds an itemized line's
    // unit price at zero or more.
    expect(state.inserted.lines[1]).toMatchObject({ quantity: 1, unit_amount_cents: null });
  });

  it("taxes what is left after the discount", async () => {
    state.org.sales_tax_rate_bps = 825;
    const r = await make([3_800, -500]);
    const expected = invoiceTotals(3_300, 825);
    expect(r).toMatchObject({ totalCents: expected.totalCents, taxCents: expected.taxCents });
    expect(state.inserted.invoices[0]).toMatchObject({ subtotal_cents: 3_300 });
  });

  it("refuses discounts of more than the charges, and writes nothing", async () => {
    await expect(make([500, -500])).rejects.toThrow(DISCOUNT_MORE_THAN_CHARGES);
    expect(state.inserted.invoices).toHaveLength(0);
  });
});

describe("everywhere else the discount goes", () => {
  it("the server function accepts a minus line under the same rules", () => {
    const fn = read("src/lib/invoices.functions.ts");
    const schema = fn.slice(
      fn.indexOf("const manualInvoiceSchema"),
      fn.indexOf("export const createManualInvoice"),
    );
    expect(schema).toContain("amountCents: z.number().int().min(-10_000_000)");
    expect(schema).toContain("discountLineProblem(i)");
    expect(schema).toContain("manualLinesProblem(items)");
    expect(schema).not.toMatch(/amountCents >= 1 \|\|/);
  });

  it("goes to QuickBooks and Xero as one of a minus amount", () => {
    const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;
    expect(accountingLine({ description: "Discount", amount_cents: -500 }, fmt)).toEqual({
      description: "Discount",
      quantity: 1,
      unitAmount: -5,
      amount: -5,
    });
  });

  it("is paid as one amount, the invoice's balance, never as Stripe lines", () => {
    // A Checkout line item cannot be negative. Nothing here builds one for an
    // invoice: every invoice payment is a PaymentIntent for its balance.
    const fn = read("src/lib/invoices.functions.ts");
    expect(fn).not.toMatch(/checkout\.sessions\.create/);
    expect(fn).toMatch(/paymentIntents\.create/);
  });
});
