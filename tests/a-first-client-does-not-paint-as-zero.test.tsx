// #790 (onboarding QA, 2026-11-09): stale zeros on first paint after the
// first client exists.
//
//   * /clients: header "0 total" with the new client's row listed under it.
//   * /dashboard: "0 active clients / $0.00 AR" painted, then settled at
//     "1 active client / $20.00 AR".
//   * Setup banner: "Next: Add or import clients" on the client's own page.
//
// All three were a cached answer from before the client existed, painted
// while (or instead of) a refetch. Invalidating does not stop that: an
// invalidated query still renders its data. The fix drops those caches when
// the book changes, and /clients refuses a summary its own list contradicts.

import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tanstack/react-start", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-start")>()),
  useServerFn: (f: unknown) => f,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => () => undefined,
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/clients/c-1" } }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getUser: vi.fn(), updateUser: vi.fn() } },
  isImpersonationTab: () => false,
}));
vi.mock("@/lib/onboarding.functions", () => ({
  getOnboardingStatus: vi.fn(),
  dismissOnboarding: vi.fn(),
}));
vi.mock("@/hooks/useMyRole", async (orig) => ({
  ...(await orig<typeof import("@/hooks/useMyRole")>()),
  useMyRole: () => ({ role: "owner", isLoading: false }),
}));
vi.mock("@/lib/setup-guide", async (orig) => ({
  ...(await orig<typeof import("@/lib/setup-guide")>()),
  useSetupGuide: () => ({ phase: "open", userId: "owner-1" }),
  // Left /setup at the clients step for /clients/new (the walkthrough path).
  readRememberedStep: () => "clients",
}));

import { SetupGuideBanner } from "@/components/SetupGuideBanner";
import {
  CLIENTS_SUMMARY_KEY,
  DASHBOARD_SUMMARY_KEY,
  afterClientBookChanged,
  summaryLagsRows,
} from "@/lib/client-book-queries";

const IDS = ["business", "zones", "clients", "staff", "dump_site", "payouts"] as const;
const LABELS: Record<(typeof IDS)[number], string> = {
  business: "Your business details",
  zones: "Your service area and price",
  clients: "Add or import clients",
  staff: "Who runs the route",
  dump_site: "Where the day ends",
  payouts: "Get paid",
};
function onboarding(doneIds: readonly string[]) {
  const steps = IDS.map((id) => ({
    id,
    label: LABELS[id],
    description: "",
    done: doneIds.includes(id),
    to: "/setup",
    cta: "Do it",
  }));
  return { steps, completed: doneIds.length, total: 6, dismissed: false, emailVerified: true };
}

const PAGE_KEY = ["clients", "page", { q: "", status: "all", type: "all", tag: "all" }, 0];

/** The cache as it stood before the first client was saved: everything the
 *  owner had already looked at once during setup. */
function cacheBeforeTheFirstClient() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(CLIENTS_SUMMARY_KEY, {
    stats: { total: 0, active: 0, outstanding: 0, owedTotal: 0, atRisk: 0, noPlan: 0 },
    tags: [],
  });
  qc.setQueryData(PAGE_KEY, { rows: [], matched: 0, offset: 0 });
  qc.setQueryData(DASHBOARD_SUMMARY_KEY, { activeClients: 0, arOpenCents: 0 });
  qc.setQueryData(["onboarding-status"], onboarding(["business", "zones"]));
  qc.setQueryData(["invoices", "list"], { untouched: true });
  return qc;
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const banner = (qc: QueryClient) =>
  text(
    renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <SetupGuideBanner />
      </QueryClientProvider>,
    ),
  );

describe("#790: after a client is added, no count paints from the cache that predates it", () => {
  it("why invalidating was not enough: the stale zero is still what renders", async () => {
    const qc = cacheBeforeTheFirstClient();
    await qc.invalidateQueries({ queryKey: ["clients"] });
    await qc.invalidateQueries({ queryKey: DASHBOARD_SUMMARY_KEY });
    expect((qc.getQueryData(CLIENTS_SUMMARY_KEY) as { stats: { total: number } }).stats.total).toBe(
      0,
    );
    expect((qc.getQueryData(DASHBOARD_SUMMARY_KEY) as { arOpenCents: number }).arOpenCents).toBe(0);
  });

  it("drops the /clients header and list, the dashboard KPIs and the setup status", async () => {
    const qc = cacheBeforeTheFirstClient();
    await afterClientBookChanged(qc);
    expect(qc.getQueryData(CLIENTS_SUMMARY_KEY)).toBeUndefined();
    expect(qc.getQueryData(PAGE_KEY)).toBeUndefined();
    expect(qc.getQueryData(DASHBOARD_SUMMARY_KEY)).toBeUndefined();
    expect(qc.getQueryData(["onboarding-status"])).toBeUndefined();
    // Nothing else is thrown away.
    expect(qc.getQueryData(["invoices", "list"])).toEqual({ untouched: true });
  });

  it("the setup banner stops saying Next: Add or import clients the moment the client is saved", async () => {
    const qc = cacheBeforeTheFirstClient();
    // Before: the stale copy the tester saw on the new client's page.
    expect(banner(qc)).toMatch(/Next: Add or import clients/);
    await afterClientBookChanged(qc);
    // After: nothing until the server answers, never the wrong step.
    expect(banner(qc)).not.toMatch(/Add or import clients/);
    // And the server's answer reads as the server's answer.
    qc.setQueryData(["onboarding-status"], onboarding(["business", "zones", "clients"]));
    const fresh = banner(qc);
    expect(fresh).toMatch(/Setup: 3 of 6 done\./);
    expect(fresh).not.toMatch(/Add or import clients/);
  });
});

describe("#790: /clients does not show a header its own list contradicts", () => {
  const zero = { stats: { total: 0 } };
  const one = { stats: { total: 1 } };

  it("a row listed under a 0 total means the summary is stale", () => {
    expect(summaryLagsRows(zero, { rows: [{ id: "c-1" }], matched: 1 })).toBe(true);
    expect(summaryLagsRows(zero, { rows: [{ id: "c-1" }], matched: 0 })).toBe(true);
    expect(summaryLagsRows(one, { rows: [{}, {}], matched: 2 })).toBe(true);
  });

  it("agrees when it can be right, and says nothing until both have answered", () => {
    expect(summaryLagsRows(one, { rows: [{ id: "c-1" }], matched: 1 })).toBe(false);
    // A filter narrows: fewer matched than the book is normal.
    expect(summaryLagsRows({ stats: { total: 40 } }, { rows: [], matched: 3 })).toBe(false);
    expect(summaryLagsRows(zero, { rows: [], matched: 0 })).toBe(false);
    expect(summaryLagsRows(undefined, { rows: [{}], matched: 1 })).toBe(false);
    expect(summaryLagsRows(zero, undefined)).toBe(false);
  });
});

describe("#790: the surfaces are wired to it", () => {
  const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

  it("the new-client form, both import commits, and undo reset the counts", () => {
    const form = src("src/routes/_authenticated/clients.new.tsx");
    const onSuccess = form.slice(
      form.indexOf("onSuccess: ({"),
      form.indexOf("onError:", form.indexOf("onSuccess: ({")),
    );
    expect(onSuccess).toMatch(/afterClientBookChanged\(qc\)/);
    const imports = src("src/routes/_authenticated/imports.$batchId.tsx");
    // Commit, Try again, and since #857 Undo, which deletes what a commit
    // added and so moves every client count the other way.
    expect(imports.match(/afterClientBookChanged\(qc\)/g)?.length ?? 0).toBe(3);
  });

  it("/clients hides a summary that lags its rows and refetches it", () => {
    const page = src("src/routes/_authenticated/clients.index.tsx");
    expect(page).toMatch(/summaryLagsRows\(summaryQ\.data, data\)/);
    // The header, tiles and empty state read the guarded summary only.
    expect(page).not.toMatch(/summaryQ\.data\?\.stats/);
    expect(page).toMatch(/summaryQ\.refetch\(\)/);
  });
});
