import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: any) => ({ options }),
  Link: ({ children }: any) => createElement("a", null, children),
  useNavigate: () => vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  useServerFn: (f: any) => f,
  createServerFn: () => {
    const b: any = { middleware: () => b, inputValidator: () => b, handler: () => vi.fn(async () => ({})) };
    return b;
  },
  createMiddleware: () => ({ server: () => ({}) }),
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/components/RouteMap", () => ({ RouteMap: () => null, buildTechGroups: () => [] }));
vi.mock("@/components/VisitDetailDrawer", () => ({ VisitDetailDrawer: () => null }));
vi.mock("@/components/OnboardingChecklist", () => ({ OnboardingChecklist: () => null }));
vi.mock("@/components/ai/AiPanels", () => ({ AiSection: () => null, DigestPanel: () => null, MarketingPanel: () => null, ChurnPanel: () => null }));
vi.mock("@/components/motion/PullToRefresh", () => ({ PullToRefresh: () => null }));
vi.mock("@/components/billing/ExportDataCard", () => ({ ExportDataCard: () => null }));
vi.mock("@/components/HelpTip", () => ({ HelpTip: () => null }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }) }));
vi.mock("@/hooks/useMyRole", () => ({ useMyRole: () => ({ role: "owner", orgId: "org" }), usePermissions: () => ({ can: () => true }) }));
vi.mock("@/hooks/useClientTexting", () => ({ useClientTexting: () => false }));
vi.mock("@/lib/dismissible", () => ({ useDismissed: () => ({ dismissed: false, dismiss: vi.fn() }) }));
vi.mock("@/lib/motion/use-motion-list", () => ({ useMotionList: () => null }));
vi.mock("@/components/motion/CountUp", () => ({ CountUp: ({ value, format }: any) => createElement("span", null, format ? format(value) : value) }));
vi.mock("@/lib/native", () => ({ platform: () => "web" }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key === "common.loading" ? "Loading" : key, i18n: { language: "en" } }) }));

import { Route as DashboardRoute } from "@/routes/_authenticated/dashboard";
import { Route as ClientsRoute } from "@/routes/_authenticated/clients.index";

// /clients reads one server-filtered page since #617, and the tiles over it
// come from a separate whole-book summary asked for once. Two cache entries:
// the first page with no filters, shaped as listClientsPage returns it, and
// the summary, shaped as listClientsSummary returns it.
import { filterRoster, rosterStats, rosterTags } from "@/lib/client-roster";
const CLIENTS_KEY = ["clients", "page", { q: "", status: "all", type: "all", tag: "all" }, 0];
const SUMMARY_KEY = ["clients", "summary"];
const keyOf = (key: string) => (key === "clients" ? CLIENTS_KEY : [key]);
function setClients(clients: any[]) {
  const rows = filterRoster(clients, {});
  qc.setQueryData(CLIENTS_KEY, { rows: rows.slice(0, 50), matched: rows.length, offset: 0 });
  qc.setQueryData(SUMMARY_KEY, { stats: rosterStats(clients), tags: rosterTags(clients), tagSpellings: {} });
}

let qc: QueryClient;
beforeEach(() => {
  vi.stubGlobal("React", React);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["my-org"], { organization: { name: "Test company", role: "owner" } });
});
function render(route: any) {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(route.options.component)));
}

const summary = { activeClients: 112, mtdRevenueCents: 12345, arOpenCents: 3456, visitCounts: { completed: 1, total: 3 }, todayVisits: [], staff: [], overdueInvoices: [] };

describe("loading is not an empty account", () => {
  it("keeps the dashboard visit hint behind a skeleton until the summary arrives", () => {
    const pending = render(DashboardRoute);
    expect(pending).toContain("hs-skeleton");
    expect(pending).not.toContain("None scheduled");
    expect(pending).not.toContain("No visits scheduled");
    expect(pending).not.toContain("No routes yet");
    qc.setQueryData(["dashboard-summary"], summary);
    expect(render(DashboardRoute)).toContain("33% done");
  });

  it("allows a real empty dashboard only after a successful response", () => {
    qc.setQueryData(["dashboard-summary"], { ...summary, visitCounts: { total: 0, completed: 0 } });
    expect(render(DashboardRoute)).toContain("None scheduled");
  });

  it("skeletons all client totals and the list, then renders the loaded roster", () => {
    const pending = render(ClientsRoute);
    for (const falseEmpty of ["0 total", "0 active", "$0.00", "0 clients", "0 archived", "No clients yet"]) {
      expect(pending).not.toContain(falseEmpty);
    }
    expect(pending).toContain("data-skeleton-region");
    setClients(Array.from({ length: 112 }, (_, i) => ({ id: `c${i}`, display_name: `Test ${i}`, active: true, outstanding_cents: 100, active_subscription_count: 1 })));
    const loaded = render(ClientsRoute);
    expect(loaded).toContain("112 total");
    expect(loaded).toContain("112 active");
    expect(loaded).toContain("$112.00");
  });

  it("keeps known client counts visible during a background refresh", () => {
    setClients([{ id: "c1", active: true, display_name: "Test client", outstanding_cents: 1234 }]);
    qc.getQueryCache().find({ queryKey: CLIENTS_KEY, exact: true })!.setState({ fetchStatus: "fetching" });
    qc.getQueryCache().find({ queryKey: SUMMARY_KEY, exact: true })!.setState({ fetchStatus: "fetching" });
    const html = render(ClientsRoute);
    expect(html).toContain("1 total");
    expect(html).toContain("$12.34");
  });

  it.each([
    ["dashboard-summary", DashboardRoute, "None scheduled"],
    ["clients", ClientsRoute, "0 total"],
  ])("keeps %s pending when the first request is paused", (key, route, empty) => {
    qc.getQueryCache().build(qc, { queryKey: keyOf(key) }).setState({ status: "pending", fetchStatus: "paused" });
    const html = render(route);
    expect(html).toContain("hs-skeleton");
    expect(html).not.toContain(empty);
  });

  it.each([
    ["dashboard-summary", DashboardRoute],
    ["clients", ClientsRoute],
  ])("surfaces an initial %s failure to the error boundary", (key, route) => {
    qc.getQueryCache().build(qc, { queryKey: keyOf(key) }).setState({ status: "error", fetchStatus: "idle", error: new Error("Read failed") });
    expect(() => render(route)).toThrow("Read failed");
  });

  it("shows true zero totals once an empty client list succeeds", () => {
    setClients([]);
    const html = render(ClientsRoute);
    expect(html).toContain("0 total");
    expect(html).toContain("$0.00");
    expect(html).toContain("No clients yet");
  });
});

// #790: after the first client was saved, /clients read "0 total" with the
// client's row listed under it, and the dashboard painted "$0.00" AR and no
// active clients before settling at 1 and $20.00. Both were caches from
// before the client existed. See tests/a-first-client-does-not-paint-as-zero.test.tsx.
describe("#790: a cached zero is not painted over a client that exists", () => {
  const row = { id: "c1", active: true, display_name: "First client", outstanding_cents: 2000, active_subscription_count: 1 };

  it("/clients does not say 0 total above a row the list just read", () => {
    // The summary as it was read before the client existed...
    qc.setQueryData(SUMMARY_KEY, { stats: rosterStats([]), tags: [], tagSpellings: {} }, { updatedAt: 1_000 });
    // ...and the list, read since, holding the new client.
    const rows = filterRoster([row], {});
    qc.setQueryData(CLIENTS_KEY, { rows, matched: 1, offset: 0 }, { updatedAt: 2_000 });
    const html = render(ClientsRoute);
    expect(html).toContain("First client");
    for (const stale of ["0 total", "0 active", "0 archived"]) expect(html).not.toContain(stale);
    expect(html).toContain("hs-skeleton");
  });

  it("/clients shows the summary once it has been read after the list, whatever it says", () => {
    const rows = filterRoster([row], {});
    qc.setQueryData(CLIENTS_KEY, { rows, matched: 1, offset: 0 }, { updatedAt: 2_000 });
    qc.setQueryData(SUMMARY_KEY, { stats: rosterStats([row]), tags: [], tagSpellings: {} }, { updatedAt: 3_000 });
    expect(render(ClientsRoute)).toContain("1 total");
    // A disagreement read AFTER the list is the server's answer, not a stale
    // cache: shown, so the tiles can never be held on a skeleton for good.
    qc.setQueryData(SUMMARY_KEY, { stats: rosterStats([]), tags: [], tagSpellings: {} }, { updatedAt: 4_000 });
    expect(render(ClientsRoute)).toContain("0 total");
  });

  it("the dashboard does not paint the pre-client zero once a client is saved", async () => {
    const { afterClientBookChanged } = await import("@/lib/client-book-queries");
    qc.setQueryData(["dashboard-summary"], { ...summary, activeClients: 0, arOpenCents: 0, mtdRevenueCents: 0 });
    expect(render(DashboardRoute)).toContain("$0.00");
    await afterClientBookChanged(qc);
    const pending = render(DashboardRoute);
    expect(pending).not.toContain("$0.00");
    expect(pending).toContain("hs-skeleton");
    qc.setQueryData(["dashboard-summary"], { ...summary, activeClients: 1, arOpenCents: 2000, mtdRevenueCents: 0 });
    expect(render(DashboardRoute)).toContain("$20.00");
  });
});
