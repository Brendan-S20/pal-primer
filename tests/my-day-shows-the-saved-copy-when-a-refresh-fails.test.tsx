// My Day, with a saved copy of the day and a refresh that failed, shows the
// copy under the freshness banner — not "Couldn't load this day".
//
// The read cache now keeps the day through a failed refresh
// (a-failed-refresh-keeps-the-day-on-the-phone.test.ts). This is the screen
// half: the real route component, rendered to markup with its server functions
// stubbed and the query seeded in the exact state a failed refetch leaves it
// in — status "error", data still there — the same approach as
// my-day-in-arabic-reads-right-to-left.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const DAY = "2026-10-06";
const HOUR = 60 * 60_000;

vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  useServerFn: (f: unknown) => f,
  // Every builder step hands back the same callable, so `.handler(...)`
  // yields something the page can hold as a server function.
  createServerFn: () => {
    function chain(): unknown {
      return chain;
    }
    return Object.assign(chain, {
      validator: chain,
      inputValidator: chain,
      middleware: chain,
      handler: chain,
    });
  },
  createMiddleware: () => {
    const chain: Record<string, unknown> = {};
    chain.server = () => chain;
    chain.client = () => chain;
    chain.middleware = () => chain;
    return chain;
  },
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    options: opts,
    useSearch: () => ({}),
    useNavigate: () => () => {},
  }),
  Link: ({ children, to, ...rest }: { children?: ReactNode; to?: string }) =>
    createElement("a", { href: to, ...rest }, children),
  useNavigate: () => () => {},
  useRouterState: () => ({ location: { pathname: "/my-day" } }),
}));
vi.mock("@/hooks/useOrgToday", () => ({
  useOrgToday: () => DAY,
  useOrgTimezone: () => "America/Chicago",
}));
vi.mock("@/hooks/useMyRole", () => ({
  useMyRole: () => ({ role: "tech", orgId: "org-1", loading: false }),
  usePermissions: () => ({ can: () => false }),
  canAccess: () => true,
}));
vi.mock("@/components/ui/sidebar", () => ({
  useSidebar: () => ({ docksFrom: "lg", isMobile: true, state: "expanded" }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {},
}));

import i18n from "@/lib/i18n";
import { Route } from "@/routes/_authenticated/my-day";

function myDay(visits = defaultVisits()) {
  return {
    staff: { id: "s-1", display_name: "Jordan Tech", organization_id: "org-1" },
    previewing: false,
    visits,
  };
}

function defaultVisits() {
  return [
    {
      id: "v-1",
      organization_id: "org-1",
      assigned_staff_id: "s-1",
      sequence: 1,
      status: "scheduled",
      scheduled_on: DAY,
      eta_start: `${DAY}T14:15:00Z`,
      eta_end: `${DAY}T14:45:00Z`,
      visit_photos: [],
      zones: { name: "Lakeview East" },
      clients: {
        display_name: "Anastasia Vandermolen-Whitaker",
        primary_phone: null,
        dna_compliance_enabled: false,
      },
      stop_facts: { dogCount: 0, openBalanceCents: 0, awaitingCents: 0 },
      properties: {
        id: "p-1",
        street: "1418 W Wolfram St",
        city: "Chicago",
        postal_code: "60657",
        account_type: "residential",
        gate_code: "*5521#",
        dogs: [],
        waste_stations: [],
      },
    },
  ];
}

/** Render My Day with the day query in the state a failed refetch leaves:
 *  "error", and — unless `withData` is false — the last good copy still in it. */
function render(opts: { withData: boolean; visits?: unknown[]; upcoming?: unknown[] }) {
  // retryOnMount: false holds the failure as it stands. Otherwise a query in
  // "error" with NO data is fetched again on mount, which on a server render
  // means the loading skeleton — a state the contrast case below is not about.
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  const key = ["my-day", DAY, ""];
  if (opts.withData)
    qc.setQueryData(key, myDay(opts.visits ?? defaultVisits()), {
      updatedAt: Date.now() - 3 * HOUR,
    });
  if (opts.upcoming)
    qc.setQueryData(["my-upcoming-days"], {
      staff: { id: "s-1", display_name: "Jordan Tech", organization_id: "org-1" },
      days: opts.upcoming,
    });
  const query = qc.getQueryCache().build(qc, { queryKey: key });
  query.setState({
    status: "error",
    error: new TypeError("Failed to fetch"),
    errorUpdatedAt: Date.now(),
    fetchFailureCount: 1,
    fetchFailureReason: new TypeError("Failed to fetch"),
  });
  const MyDay = (Route as unknown as { options: { component: () => ReactNode } }).options.component;
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: qc }, createElement(MyDay)),
  )
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ");
}

const root = new Map<string, string>([["lang", "en"]]);
beforeAll(async () => {
  vi.stubGlobal("document", {
    documentElement: {
      getAttribute: (k: string) => root.get(k) ?? null,
      setAttribute: (k: string, v: string) => void root.set(k, v),
    },
  });
  await i18n.changeLanguage("en");
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe("My Day after a failed refresh", () => {
  it("offline: shows the saved day under the offline banner, with its age", () => {
    vi.stubGlobal("navigator", { onLine: false });
    try {
      const text = render({ withData: true });
      expect(text).toContain("Offline: saved copy, 3 hr ago");
      expect(text).toContain("Anastasia Vandermolen-Whitaker");
      expect(text).not.toContain("Couldn't load this day");
    } finally {
      vi.stubGlobal("navigator", { onLine: true });
    }
  });

  it("online: says the refresh failed, and still shows the saved day", () => {
    vi.stubGlobal("navigator", { onLine: true });
    const text = render({ withData: true });
    expect(text).toContain("Couldn't refresh: saved copy, 3 hr ago");
    expect(text).toContain("Anastasia Vandermolen-Whitaker");
    expect(text).not.toContain("Couldn't load this day");
  });

  it("with no saved copy at all, says so (the contrast that makes the cases above mean something)", () => {
    vi.stubGlobal("navigator", { onLine: false });
    const text = render({ withData: false });
    expect(text).toContain("Couldn't load this day (you're offline)");
    expect(text).not.toContain("Anastasia Vandermolen-Whitaker");
  });

  it("with an empty day, points to the next workday when one is known", () => {
    vi.stubGlobal("navigator", { onLine: true });
    const text = render({
      withData: true,
      visits: [],
      upcoming: [
        { date: "2026-10-08", stops: 4, done: 0, zones: [], firstEta: null, lastEta: null },
      ],
    });
    expect(text).toContain("Nothing scheduled for you on this day.");
    expect(text).toContain("Your next workday is Thu, Oct 8.");
  });
});
