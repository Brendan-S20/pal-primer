// A quote's one-time charges were never billed.
//
// Converting an accepted quote set up the per-visit service and stopped. The
// one-time lines (the initial cleanup, almost always) were billed by nothing;
// the banner told the office to retype them on the Billing tab. There is now a
// button on the accepted quote that bills them once, at the quantities and
// prices the customer accepted.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { oneTimeInvoiceItems, quoteBillTo } from "@/lib/quotes";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const code = (p: string) => read(p).replace(/\/\/[^\n]*/g, "");

const line = (over: Partial<Parameters<typeof oneTimeInvoiceItems>[0][number]>) => ({
  description: "Initial cleanup",
  quantity: 1,
  unit_amount_cents: 8500,
  amount_cents: 8500,
  recurring: false,
  ...over,
});

describe("which lines are billed", () => {
  it("bills the one-time lines and never the per-visit price", () => {
    const items = oneTimeInvoiceItems([
      line({}),
      line({
        description: "Weekly service",
        recurring: true,
        amount_cents: 2000,
        unit_amount_cents: 2000,
      }),
    ]);
    expect(items).toEqual([{ description: "Initial cleanup", amountCents: 8500 }]);
  });

  it("keeps the accepted quantity and price, which numeric arrives as a string", () => {
    expect(
      oneTimeInvoiceItems([
        line({
          description: "Extra yard",
          quantity: "3.00",
          unit_amount_cents: 1500,
          amount_cents: 4500,
        }),
      ]),
    ).toEqual([
      { description: "Extra yard", amountCents: 4500, quantity: 3, unitAmountCents: 1500 },
    ]);
  });

  it("leaves out a free line", () => {
    expect(oneTimeInvoiceItems([line({ amount_cents: 0, unit_amount_cents: 0 })])).toEqual([]);
  });

  it("bills the client the quote was for, or the client it became", () => {
    expect(quoteBillTo({ client_id: "a", converted_client_id: null })).toBe("a");
    expect(quoteBillTo({ client_id: null, converted_client_id: "b" })).toBe("b");
    expect(quoteBillTo({ client_id: null, converted_client_id: null })).toBeNull();
  });
});

describe("billing it once", () => {
  const fns = code("src/lib/quotes.functions.ts");
  const fn = fns.slice(fns.indexOf("export const invoiceQuoteOneTimeCharges"));

  it("returns the invoice already made instead of making another", () => {
    expect(fn.indexOf("if (q.one_time_invoice_id)")).toBeGreaterThan(-1);
    expect(fn.indexOf("if (q.one_time_invoice_id)")).toBeLessThan(
      fn.indexOf("insertManualInvoice"),
    );
  });

  it("only for an accepted quote with somebody to bill", () => {
    expect(fn).toMatch(/q\.status !== "accepted"/);
    expect(fn).toMatch(/if \(!billTo\)/);
  });

  it("claims the quote with a conditional update, and the loser removes its invoice", () => {
    expect(fn).toMatch(
      /\.update\(\{ one_time_invoice_id: inv\.invoiceId \}\)[\s\S]*?\.is\("one_time_invoice_id", null\)/,
    );
    expect(fn).toMatch(
      /if \(wErr \|\| !won\?\.length\) \{[\s\S]*?\.from\("invoices"\)\.delete\(\)\.eq\("id", inv\.invoiceId\)/,
    );
  });

  it("uses the same invoice code as the New invoice dialog", () => {
    expect(fn).toMatch(/insertManualInvoice\(supabase,/);
    expect(code("src/lib/invoices.functions.ts")).toMatch(/insertManualInvoice\(supabase,/);
  });
});

describe("the office is asked, not surprised", () => {
  const page = read("src/routes/_authenticated/quotes.$quoteId.tsx");

  it("offers it on an accepted quote, behind a confirm that says autopay will charge it", () => {
    expect(page).toMatch(/quote\.status === "accepted" &&\s*oneTimeCents > 0 &&\s*billTo/);
    expect(page).toMatch(/If they pay by autopay, it will be charged/);
    expect(page).toMatch(/Open one-time invoice/);
  });

  it("no longer tells anyone to retype the charges on the Billing tab", () => {
    for (const f of [
      "src/routes/_authenticated/clients.new.tsx",
      "src/components/client-detail/ServicesTab.tsx",
    ]) {
      expect(read(f), f).not.toMatch(/Invoice them from the/);
      expect(read(f), f).toMatch(/Invoice one-time charges/);
    }
  });
});

describe("the database", () => {
  const mig = read(
    "supabase/migrations/20260929010000_a-quotes-one-time-charges-were-never-billed.sql",
  );

  it("remembers the invoice, and forgets it if the invoice is deleted", () => {
    expect(mig).toMatch(
      /one_time_invoice_id uuid REFERENCES public\.invoices\(id\) ON DELETE SET NULL/,
    );
  });

  it("keeps it inside the tenant", () => {
    expect(mig).toMatch(
      /NEW\.one_time_invoice_id IS NOT NULL AND NOT EXISTS[\s\S]*?i\.organization_id = NEW\.organization_id/,
    );
    expect(mig).toMatch(
      /REVOKE ALL ON FUNCTION public\.quotes_before_write\(\) FROM PUBLIC, anon, authenticated/,
    );
  });
});
