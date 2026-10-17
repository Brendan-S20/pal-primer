/* eslint-disable @typescript-eslint/no-explicit-any -- module mocks stand in for router and server-fn types */
// QA batch 6, row 13 (F-05, A-05, A-07): three money surfaces that printed a
// figure, or "Loading", that was not true.
//
// - Invoices drew "Outstanding $0.00 / 0 open / Collected $0.00" over a
//   skeleton list for up to five seconds on live.
// - The invoice drawer read `isLoading || !inv ? "Loading..."`, so a failed
//   read spun forever: an errored query is not loading and has no invoice.
// - Plan & billing summed the lines it knew and printed "Monthly total
//   $0.00/mo" under a plan line with no price. It now says "+ usage" after
//   the priced sum, or "Usage only".
//
// Same pattern as #442 on the dashboard and clients: a bone until the read
// answers, a dash or a Retry after it fails, and a zero only when the server
// said zero.
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: any) => ({
    options,
    useSearch: () => ({}),
    useParams: () => ({}),
  }),
  Link: ({ children }: any) => createElement("a", null, children),
  useNavigate: () => vi.fn(),
  useRouter: () => ({ navigate: vi.fn() }),
}));
vi.mock("@tanstack/react-start", () => ({
  useServerFn: (f: any) => f,
  createServerFn: () => {
    const b: any = {
      middleware: () => b,
      inputValidator: () => b,
      validator: () => b,
      handler: () => vi.fn(async () => ({})),
    };
    return b;
  },
  createMiddleware: () => ({ server: () => ({}) }),
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/components/motion/PullToRefresh", () => ({ PullToRefresh: () => null }));
vi.mock("@/components/FieldCollectionsCard", () => ({ FieldCollectionsCard: () => null }));
vi.mock("@/components/HelpTip", () => ({ HelpTip: () => null }));
vi.mock("@/hooks/useOrgToday", () => ({
  useOrgToday: () => "2026-10-15",
  useOrgTimezone: () => "America/Chicago",
}));
vi.mock("@/hooks/useMyRole", () => ({
  useMyRole: () => ({ role: "owner", orgId: "org" }),
  usePermissions: () => ({ can: () => true }),
}));
vi.mock("@/lib/motion/use-motion-list", () => ({ useMotionList: () => null }));
// The real drawer is a Radix sheet in a portal, which static rendering skips.
vi.mock("@/components/client-detail/EditDrawer", () => ({
  EditDrawer: ({ children, open }: any) => (open ? createElement("div", null, children) : null),
  DrawerFooter: ({ children }: any) => createElement("div", null, children),
}));

import { Route as InvoicesRoute } from "@/routes/_authenticated/invoices.index";
import { InvoiceDrawer } from "@/components/InvoiceDrawer";
import { nextInvoiceTotalCents } from "@/lib/next-invoice-total";

let qc: QueryClient;
beforeEach(() => {
  vi.stubGlobal("React", React);
  // retryOnMount off: a static render is a single frame, and an errored query
  // seen on mount would otherwise be drawn as the refetch it is about to start.
  // This is the frame AFTER that refetch failed, which is the one at issue.
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } },
  });
  qc.setQueryData(["my-org"], { organization: { id: "org", name: "Test company", role: "owner" } });
});
function render(el: React.ReactElement) {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, el));
}
const invoicesPage = () => render(createElement((InvoicesRoute as any).options.component));
const failed = (key: unknown[]) =>
  qc
    .getQueryCache()
    .build(qc, { queryKey: key })
    .setState({ status: "error", fetchStatus: "idle", error: new Error("Read failed") });

const collected = {
  grossCents: 50000,
  refundsCents: 0,
  netCents: 50000,
  paymentCount: 4,
  reversalCount: 0,
};
const openInvoice = {
  id: "11111111-0000-4000-8000-000000000001",
  number: 1042,
  client_id: "c1",
  status: "open",
  kind: "postpaid",
  subtotal_cents: 8000,
  total_cents: 8000,
  credit_applied_cents: 0,
  currency: "usd",
  period_start: "2026-09-01",
  period_end: "2026-09-30",
  issued_at: "2026-10-01T12:00:00Z",
  paid_at: null,
  due_on: "2026-10-20",
  send_after: null,
  sent_at: null,
  public_token: "t",
  checkout_url: null,
  clients: { display_name: "Test client" },
};

describe("Invoices stat cards", () => {
  it("draw bones, not $0.00 and 0 open, while the reads are in flight", () => {
    const html = invoicesPage();
    expect(html).toContain("hs-skeleton");
    expect(html).not.toContain("$0.00");
    expect(html).not.toContain("0 invoices open");
    expect(html).not.toContain("0 payments received");
    expect(html).not.toContain("No invoices yet");
  });

  it("draw the real figures once both reads answer", () => {
    qc.setQueryData(["invoices"], [openInvoice]);
    qc.setQueryData(["invoices", "collected-mtd"], collected);
    const html = invoicesPage();
    expect(html).toContain("$80.00");
    expect(html).toContain("1 invoice open");
    expect(html).toContain("$500.00");
    expect(html).toContain("4 payments received");
  });

  it("show a true zero only after a successful empty answer", () => {
    qc.setQueryData(["invoices"], []);
    qc.setQueryData(["invoices", "collected-mtd"], {
      ...collected,
      netCents: 0,
      grossCents: 0,
      paymentCount: 0,
    });
    const html = invoicesPage();
    expect(html).toContain("$0.00");
    expect(html).toContain("0 invoices open");
    expect(html).toContain("No invoices yet");
  });

  it("keep the collected card a bone while only it is still loading", () => {
    qc.setQueryData(["invoices"], [openInvoice]);
    const html = invoicesPage();
    expect(html).toContain("$80.00");
    expect(html).not.toContain("$0.00");
    expect(html).not.toContain("0 payments received");
  });

  it("say the list failed, with Retry, instead of zeros or a skeleton forever", () => {
    failed(["invoices"]);
    failed(["invoices", "collected-mtd"]);
    const html = invoicesPage();
    expect(html).toContain("Couldn&#x27;t load your invoices.");
    expect(html).toContain("Retry");
    expect(html).not.toContain("$0.00");
    expect(html).not.toContain("No invoices yet");
    expect(html).not.toContain("hs-skeleton rounded-md bg-primary/10 h-9");
  });

  it("say the collected total failed when only that read did", () => {
    qc.setQueryData(["invoices"], [openInvoice]);
    failed(["invoices", "collected-mtd"]);
    const html = invoicesPage();
    expect(html).toContain("Couldn&#x27;t load this month&#x27;s collected total.");
    expect(html).not.toContain("$0.00");
  });
});

describe("the invoice drawer", () => {
  const drawer = () =>
    render(createElement(InvoiceDrawer, { invoiceId: openInvoice.id, onClose: () => {} }));
  const key = ["invoice-detail", openInvoice.id];

  it("draws bones while the invoice loads, and no Loading text", () => {
    const html = drawer();
    expect(html).not.toContain("Loading");
  });

  it("says it could not load, with Retry, when the read fails", () => {
    failed(key);
    const html = drawer();
    expect(html).toContain("Couldn&#x27;t load this invoice.");
    expect(html).toContain("Retry");
    expect(html).not.toContain("Loading");
  });

  it("says the invoice was not found when the read answers with none", () => {
    qc.setQueryData(key, { invoice: null, client: null, lineItems: [], payments: [] });
    const html = drawer();
    expect(html).toContain("This invoice was not found.");
    expect(html).not.toContain("Loading");
  });

  it("has no branch that turns an error into Loading", () => {
    const src = readFileSync("src/components/InvoiceDrawer.tsx", "utf8");
    expect(src).not.toMatch(/\{isLoading \|\| !inv \?/);
  });
});

describe("Plan & billing next-invoice total", () => {
  const line = (unitAmountCents: number | null, quantity = 1, interval = "month") => ({
    unitAmountCents,
    quantity,
    interval,
    intervalCount: 1,
  });

  it("adds the lines on the plan's interval", () => {
    expect(nextInvoiceTotalCents([line(4900), line(1500, 2)], "month")).toEqual({
      knownCents: 7900,
      hasKnown: true,
      hasUsage: false,
    });
  });

  it("sums the priced lines and flags usage when a line has no price", () => {
    expect(nextInvoiceTotalCents([line(19900), line(null, 3)], "month")).toEqual({
      knownCents: 19900,
      hasKnown: true,
      hasUsage: true,
    });
  });

  it("has nothing known, not a $0.00, when every line is usage", () => {
    expect(nextInvoiceTotalCents([line(null)], "month")).toEqual({
      knownCents: 0,
      hasKnown: false,
      hasUsage: true,
    });
  });

  it("leaves out a line billed on another interval, as the label says", () => {
    expect(nextInvoiceTotalCents([line(4900), line(30000, 1, "year")], "month")).toEqual({
      knownCents: 4900,
      hasKnown: true,
      hasUsage: false,
    });
  });

  it("is what the page prints, with + usage or Usage only for unpriced lines", () => {
    const src = readFileSync("src/routes/_authenticated/settings.billing.tsx", "utf8");
    expect(src).toContain("nextInvoiceTotalCents(items, planInterval)");
    expect(src).toContain('" + usage"');
    expect(src).toContain('"Usage only"');
    // A failed read of the subscription is not "No subscription line items".
    expect(src).toContain('what="your next invoice"');
  });
});
