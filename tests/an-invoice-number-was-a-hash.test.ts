import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { invoiceNumberLabel, invoiceRef } from "@/lib/invoice-labels";

// Every invoice was labelled with the first eight characters of its UUID
// ("#26db55a4"): unreadable on a phone call, unsortable, unmatchable to a
// deposit. 20260928120000 gives each organization its own INV-1001 sequence,
// assigned by a trigger on insert and never changed.

describe("the label", () => {
  it("is the number", () => {
    expect(invoiceNumberLabel({ id: "26db55a4-0000-4000-8000-000000000001", number: 1042 })).toBe(
      "INV-1042",
    );
  });
  it("falls back to the fragment only for a row read without its number", () => {
    expect(invoiceNumberLabel({ id: "26db55a4-0000-4000-8000-000000000001", number: null })).toBe(
      "#26db55a4",
    );
  });
  it("reads the number for server-written text", async () => {
    const fake = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { number: 1107 } }) }) }),
      }),
    };
    expect(await invoiceRef(fake, "x")).toBe("INV-1107");
  });
});

describe("no screen prints the fragment any more", () => {
  it.each([
    "src/components/InvoiceRow.tsx",
    "src/components/InvoiceDrawer.tsx",
    "src/components/client-detail/billing-panels.tsx",
    "src/routes/_authenticated/invoices.$invoiceId.tsx",
    "src/routes/pay.i.$token.tsx",
    "src/lib/invoices.functions.ts",
    "src/lib/invoice-reconcile.server.ts",
    "src/lib/cpa-reports.functions.ts",
    // QA batch 6: the portal printed a list position, and the add-on trail on
    // client detail printed the fragment.
    "src/routes/portal.$slug.$token.billing.tsx",
    "src/routes/portal.$slug.$token.pay.$invoiceId.tsx",
    "src/lib/addon-billing.ts",
  ])("%s", (file) => {
    const src = readFileSync(file, "utf8");
    expect(src).not.toMatch(/#\{?\$?\{?[a-zA-Z.()_]*\bid\b[a-zA-Z.()_]*\.slice\(0, 8\)/i);
    expect(src).not.toMatch(/invoice(?:Id|_id|\.id)[^\n]{0,20}\.slice\(0, 8\)/);
  });
});
