/* eslint-disable @typescript-eslint/no-explicit-any -- module mocks stand in for router and server-fn types */
// A refunded invoice is honest to the customer too (#674).
//
// Nov 10 2026, the owner: "yes, fix the Paid badge with the Void work." #698
// made the staff screens say Refunded or Partly refunded on a paid invoice
// whose money went back, and left the two customer surfaces, the pay page
// (/pay/i/{token}) and the portal's Billing list, drawing a plain Paid. Both
// now read the same rule the staff invoice page reads, and say Void once the
// invoice is voided.
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { PORTAL_INVOICES } from "./viewports/fixtures/portal-dataset";

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

// The fixture's paid invoice, refunded in full (INV-1069's shape), one partly
// refunded, and one voided afterwards.
const [open, paid] = PORTAL_INVOICES.invoices as Array<any>;
const refunded = {
  ...paid,
  invoice_id: "r1",
  number_label: "INV-1069",
  amount_paid_cents: 0,
  amount_refunded_cents: paid.total_cents,
};
const partly = {
  ...paid,
  invoice_id: "r2",
  number_label: "INV-1070",
  amount_paid_cents: 1000,
  amount_refunded_cents: paid.total_cents - 1000,
};
const voided = { ...refunded, invoice_id: "r3", number_label: "INV-1071", status: "void" };

vi.mock("@/lib/portal-ui", async (orig) => ({
  ...((await orig()) as object),
  usePortalCtx: () => ({
    clientQ: q({ display_name: "Test client", autopay_enabled: false }),
    invoicesQ: q({ ...PORTAL_INVOICES, invoices: [open, refunded, partly, voided] }),
    subsQ: q([]),
    setAutopayMut: m(),
    removeCardMut: m(),
    paySavedMut: m(),
    promoMut: m(),
  }),
}));

import { InvoiceStatusBadge as PortalBadge } from "@/lib/portal-ui";
import { InvoiceStatusBadge as PayPageBadge } from "@/components/InvoiceStatusBadge";
import { Route as BillingRoute } from "@/routes/portal.$slug.$token.billing";

const read = (p: string) => readFileSync(p, "utf8");

describe("the badge the customer sees", () => {
  it("says Refunded, Partly refunded or Void, never Paid, once the money went back", () => {
    for (const Badge of [PortalBadge, PayPageBadge]) {
      const html = (props: any) => renderToStaticMarkup(createElement(Badge, props));
      expect(html({ status: "paid" })).toContain(">Paid<");
      expect(html({ status: "paid", refund: "refunded" })).toContain(">Refunded<");
      expect(html({ status: "paid", refund: "refunded" })).not.toContain(">Paid<");
      expect(html({ status: "paid", refund: "partly_refunded" })).toContain(">Partly refunded<");
      expect(html({ status: "void", refund: null })).toContain(">Void<");
    }
  });
});

describe("the portal's Billing list", () => {
  it("draws each refunded invoice by what happened to its money", () => {
    vi.stubGlobal("React", React);
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement((BillingRoute as any).options.component),
      ),
    );
    expect(html).toContain(">Refunded<");
    expect(html).toContain(">Partly refunded<");
    expect(html).toContain(">Void<");
    // The one open invoice says Open; nothing on the page says Paid.
    expect(html).toContain(">Open<");
    expect(html).not.toContain(">Paid<");
  });

  it("is given the refund figure by the server, from the invoice row", () => {
    const fn = read("src/lib/portal.functions.ts");
    expect(fn).toMatch(
      /"id, number, due_on, credit_applied_cents, amount_paid_cents, amount_refunded_cents,/,
    );
    expect(fn).toMatch(/amount_refunded_cents: Number\(extra\?\.amount_refunded_cents \?\? 0\)/);
    const page = read("src/routes/portal.$slug.$token.billing.tsx");
    expect(page).toMatch(
      /<InvoiceStatusBadge status=\{i\.status\} refund=\{invoiceRefundState\(i\)\} \/>/,
    );
  });
});

describe("the pay page", () => {
  const page = read("src/routes/pay.i.$token.tsx");

  it("reads the refund with the invoice, so it never says Paid first and Refunded a moment later", () => {
    expect(page).toMatch(
      /Promise\.all\(\[\s*getFn\(\{ data: \{ token \} \}\),\s*refundFn\(\{ data: \{ token \} \}\)/,
    );
    expect(page).toMatch(/amount_refunded_cents: data\?\.amountRefundedCents \?\? 0/);
    expect(page).toMatch(/invoiceRefundState\(\{/);
  });

  it("passes it to both places the badge is drawn", () => {
    expect(page).toMatch(/<InvoiceStatusBadge status=\{invoice\.status\} refund=\{refund\} \/>/);
    expect(page).toMatch(
      /invoice\.status === "paid" && \(?\s*<InvoiceStatusBadge status="paid" refund=\{refund\} \/>/,
    );
    expect(page).not.toMatch(/<InvoiceStatusBadge status=\{invoice\.status\} \/>/);
    expect(page).not.toMatch(/<InvoiceStatusBadge status="paid" \/>/);
  });

  it("gets the figure by the pay link's own capability, and nothing else about the client", () => {
    const fn = read("src/lib/public-invoice-refund.functions.ts").replace(/\/\/[^\n]*/g, "");
    expect(fn).toMatch(/z\.object\(\{ token: z\.string\(\)\.uuid\(\) \}\)/);
    expect(fn).toMatch(/\.select\("amount_refunded_cents"\)\s*\.eq\("public_token", data\.token\)/);
    expect(fn).not.toMatch(/display_name|email|phone|clients\(/);
  });
});
