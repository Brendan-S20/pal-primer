/* eslint-disable @typescript-eslint/no-explicit-any -- module mocks stand in for router and server-fn types */
// QA batch 6, row 14 (C-03): the portal's Billing page numbered invoices by
// their position in the list, `#${String(invoices.length - idx).padStart(4,
// "0")}`, so the invoice the pay link, the PDF and the email all call INV-10427
// was "Invoice #0003" to the customer. A customer who rang about "invoice 3"
// could not be matched to anything the owner sees, and the number moved
// whenever the list did.
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { PORTAL_INVOICES, PORTAL_INVOICE_INTENT } from "./viewports/fixtures/portal-dataset";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: any) => ({
    options,
    useParams: () => ({ slug: "acme", token: "t" }),
    useSearch: () => ({}),
  }),
  Link: ({ children }: any) => createElement("a", null, children),
  useNavigate: () => vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  useServerFn: (f: any) => f,
  createServerFn: () => {
    const b: any = { middleware: () => b, inputValidator: () => b, handler: () => vi.fn() };
    return b;
  },
  createMiddleware: () => ({ server: () => ({}) }),
}));
const q = (data: unknown) => ({
  data,
  isPending: false,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
});
const m = () => ({ mutate: vi.fn(), isPending: false });
vi.mock("@/lib/portal-ui", async (orig) => ({
  ...((await orig()) as object),
  usePortalCtx: () => ({
    clientQ: q({ display_name: "Test client", autopay_enabled: false }),
    invoicesQ: q(PORTAL_INVOICES),
    subsQ: q([]),
    setAutopayMut: m(),
    removeCardMut: m(),
    paySavedMut: m(),
    promoMut: m(),
  }),
}));

import { Route as BillingRoute } from "@/routes/portal.$slug.$token.billing";

describe("the portal's Billing list", () => {
  it("prints each invoice's stored number, as the pay link, PDF and email do", () => {
    vi.stubGlobal("React", React);
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement((BillingRoute as any).options.component),
      ),
    );
    for (const n of ["INV-10427", "INV-10398", "INV-10371"]) expect(html).toContain(n);
    expect(html).not.toMatch(/#000\d/);
    // Same number the pay link fixture shows for the same invoice.
    expect(PORTAL_INVOICES.invoices[0].number_label).toBe("INV-10427");
  });

  it("is given that number by the server, read from the invoice row", () => {
    const src = readFileSync("src/lib/portal.functions.ts", "utf8");
    expect(src).toMatch(/\.select\("id, number, due_on, credit_applied_cents/);
    expect(src).toContain("number_label: invoiceNumberLabel(");
  });

  it("has no position-based numbering left in it", () => {
    const src = readFileSync("src/routes/portal.$slug.$token.billing.tsx", "utf8");
    expect(src).not.toMatch(/padStart\(4/);
    expect(src).not.toMatch(/length - idx/);
  });
});

describe("the portal's pay page", () => {
  it("names the invoice by the same stored number", () => {
    expect(PORTAL_INVOICE_INTENT.invoiceLabel).toBe("INV-10427");
    const fn = readFileSync("src/lib/portal.functions.ts", "utf8");
    expect(fn).toContain("invoiceLabel: invoiceNumberLabel(");
    const page = readFileSync("src/routes/portal.$slug.$token.pay.$invoiceId.tsx", "utf8");
    expect(page).toContain("intentQ.data.invoiceLabel");
  });
});

describe("the owner's Invoices CSV", () => {
  it("exports the stored invoice number, not only the id", () => {
    const src = readFileSync("src/routes/_authenticated/invoices.index.tsx", "utf8");
    expect(src).toMatch(/"Invoice number",\s*\n\s*"Invoice ID"/);
    expect(src).toContain("invoiceNumberLabel(inv)");
  });
});
