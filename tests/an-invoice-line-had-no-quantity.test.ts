// An invoice line had no quantity.
//
// A line was a description and a total, so "3 extra yards at $15" was typed
// as one line for $45: the customer could not see the unit price, and
// QuickBooks and Xero were told it was one of something at $45.
//
// The design choice these pin: amount_cents stays the LINE TOTAL and the only
// number anything adds up. Quantity and unit price are detail beside it, held
// to it by a CHECK, so no sum in the product had to change.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  accountingLine,
  lineQuantityLabel,
  lineTotalCents,
  parseQuantity,
} from "@/lib/invoice-lines";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const MIG = read("supabase/migrations/20260928150000_an-invoice-line-had-no-quantity.sql");
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

describe("the arithmetic agrees with the database's", () => {
  it("rounds half away from zero, like round(numeric)", () => {
    expect(lineTotalCents(3, 1500)).toBe(4500);
    expect(lineTotalCents(2.5, 1333)).toBe(3333); // 3332.5
    expect(lineTotalCents(0.5, 1)).toBe(1); // 0.5
    expect(lineTotalCents(1.1, 1000)).toBe(1100); // 1.1 * 100 is 110.00000000000001
  });

  it("is the same rounding the constraint uses", () => {
    expect(MIG).toMatch(/amount_cents = round\(quantity \* unit_amount_cents\)/);
    expect(MIG).toMatch(/quantity numeric\(10,2\) NOT NULL DEFAULT 1/);
  });

  it("accepts a quantity the column can hold and nothing else", () => {
    expect(parseQuantity("3")).toBe(3);
    expect(parseQuantity(" 1.5 ")).toBe(1.5);
    expect(parseQuantity("0.25")).toBe(0.25);
    for (const bad of ["", "0", "0.00", "-1", "1.255", "abc", "1e3", "100000000"]) {
      expect(parseQuantity(bad), bad).toBeNull();
    }
  });
});

describe("what the customer reads", () => {
  it("says 3 × $15.00 for an itemized line", () => {
    expect(
      lineQuantityLabel({ amount_cents: 4500, quantity: 3, unit_amount_cents: 1500 }, usd),
    ).toBe("3 × $15.00");
    // numeric arrives from PostgREST as a string.
    expect(
      lineQuantityLabel({ amount_cents: 3333, quantity: "2.50", unit_amount_cents: 1333 }, usd),
    ).toBe("2.5 × $13.33");
  });

  it("says nothing for a line that is only a total, or one of something", () => {
    expect(lineQuantityLabel({ amount_cents: 4500 }, usd)).toBeNull();
    expect(
      lineQuantityLabel({ amount_cents: 4500, quantity: 1, unit_amount_cents: null }, usd),
    ).toBeNull();
    expect(
      lineQuantityLabel({ amount_cents: 1500, quantity: 1, unit_amount_cents: 1500 }, usd),
    ).toBeNull();
  });

  it("is drawn on the office page, the drawer and the customer's pay page", () => {
    for (const f of [
      "src/routes/_authenticated/invoices.$invoiceId.tsx",
      "src/components/InvoiceDrawer.tsx",
      "src/routes/pay.i.$token.tsx",
    ]) {
      expect(read(f), f).toMatch(/<LineQuantity/);
    }
  });

  it("is fetched by every reader that draws it", () => {
    const fns = read("src/lib/invoices.functions.ts");
    const selects = [
      ...fns.matchAll(/\.from\("invoice_line_items"\)\s*\.select\(\s*"([^"]+)"/g),
    ].map((m) => m[1]);
    expect(selects.length).toBeGreaterThanOrEqual(3);
    for (const sel of selects) {
      expect(sel).toMatch(/quantity, unit_amount_cents/);
    }
  });
});

describe("what the books are told", () => {
  it("sends Qty and UnitPrice when the product is exact", () => {
    expect(
      accountingLine(
        { description: "Extra yard", amount_cents: 4500, quantity: 3, unit_amount_cents: 1500 },
        usd,
      ),
    ).toEqual({ description: "Extra yard", quantity: 3, unitAmount: 15, amount: 45 });
  });

  it("sends one of the total, described, when a fractional quantity could round differently there", () => {
    expect(
      accountingLine(
        { description: "Labour", amount_cents: 3333, quantity: "2.50", unit_amount_cents: 1333 },
        usd,
      ),
    ).toEqual({
      description: "Labour (2.5 × $13.33)",
      quantity: 1,
      unitAmount: 33.33,
      amount: 33.33,
    });
  });

  it("sends a plain line exactly as before", () => {
    expect(accountingLine({ description: "Weekly service", amount_cents: 9600 }, usd)).toEqual({
      description: "Weekly service",
      quantity: 1,
      unitAmount: 96,
      amount: 96,
    });
  });

  it("is wired into the QuickBooks sync (the only provider since Xero was dropped, 2026-10-09)", () => {
    const src = read("src/lib/accounting.server.ts");
    expect(src.match(/accountingLine\(li, money\)/g)?.length).toBe(1);
    expect(src).toMatch(/Qty: l\.quantity/);
    expect(src).not.toMatch(/Qty: 1,/);
  });
});

describe("the manual invoice form", () => {
  it("sends a line of one as only a total, and refuses a quantity it cannot read", () => {
    const page = read("src/routes/_authenticated/invoices.index.tsx");
    expect(page).toMatch(
      // A linked line (#605) carries its visit or add-on beside the total.
      /l\.quantity === 1\s*\?\s*\{ description: l\.description, amountCents: l\.amountCents(, \.\.\.link)? \}/,
    );
    expect(page).toMatch(/badQuantity \|\| createM\.isPending/);
  });

  it("is checked again on the server, which says which rule a line broke", () => {
    const fns = read("src/lib/invoices.functions.ts");
    expect(fns).toMatch(/A line with a quantity needs a unit price/);
    expect(fns).toMatch(/lineTotalCents\(i\.quantity, i\.unitAmountCents!\) === i\.amountCents/);
  });
});
