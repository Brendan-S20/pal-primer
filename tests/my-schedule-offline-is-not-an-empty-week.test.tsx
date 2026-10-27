// My schedule, offline (#536). A failed load used to fall through to
// "You have no visits assigned in the next two weeks", so a tech in a dead
// zone read that their week had been cleared. The real route component,
// rendered to markup with the query seeded in each state, the same approach as
// my-day-shows-the-saved-copy-when-a-refresh-fails.

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
  useRouterState: () => ({ location: { pathname: "/my-schedule" } }),
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
  useSidebar: () => ({ docksFrom: "lg-mouse", isMobile: true, state: "expanded" }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {},
}));

import i18n from "@/lib/i18n";
import { Route } from "@/routes/_authenticated/my-schedule";

const DAYS = [
  {
    date: "2026-10-07",
    stops: 8,
    done: 0,
    zones: ["Lakeview East"],
    firstEta: null,
    lastEta: null,
  },
  { date: "2026-10-08", stops: 7, done: 0, zones: [], firstEta: null, lastEta: null },
];

/** Render My schedule with the query as it stands: `days` is the copy in the
 *  cache (none when undefined), `failed` the state a failed fetch leaves. */
function render(opts: { days?: unknown[]; failed: boolean }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  const key = ["my-upcoming-days"];
  if (opts.days)
    qc.setQueryData(
      key,
      { staff: { id: "s-1", display_name: "Taylor Tech" }, days: opts.days },
      { updatedAt: Date.now() - 3 * HOUR },
    );
  if (opts.failed) {
    const query = qc.getQueryCache().build(qc, { queryKey: key });
    query.setState({
      status: "error",
      error: new TypeError("Failed to fetch"),
      errorUpdatedAt: Date.now(),
      fetchFailureCount: 1,
      fetchFailureReason: new TypeError("Failed to fetch"),
    });
  }
  const Page = (Route as unknown as { options: { component: () => ReactNode } }).options.component;
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: qc }, createElement(Page)),
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

const EMPTY = "You have no visits assigned in the next two weeks.";

describe("My schedule when the load fails (#536)", () => {
  it("offline with nothing cached: says it could not load, offers Retry, never 'no visits'", () => {
    vi.stubGlobal("navigator", { onLine: false });
    try {
      const text = render({ failed: true });
      expect(text).toContain("You're offline. Your schedule couldn't load");
      expect(text).toContain("Retry");
      expect(text).not.toContain(EMPTY);
    } finally {
      vi.stubGlobal("navigator", { onLine: true });
    }
  });

  it("online with nothing cached and a failed load: same, without the offline words", () => {
    vi.stubGlobal("navigator", { onLine: true });
    const text = render({ failed: true });
    expect(text).toContain("Your schedule couldn't load");
    expect(text).not.toContain("You're offline");
    expect(text).not.toContain(EMPTY);
  });

  it("offline with a saved copy: shows the days under a saved-copy note with its age", () => {
    vi.stubGlobal("navigator", { onLine: false });
    try {
      const text = render({ days: DAYS, failed: true });
      expect(text).toContain("Offline: saved copy, 3 hr ago");
      expect(text).toContain("Lakeview East");
      expect(text).not.toContain(EMPTY);
    } finally {
      vi.stubGlobal("navigator", { onLine: true });
    }
  });

  it("online, a refresh that failed over a copy: says so and keeps the days", () => {
    vi.stubGlobal("navigator", { onLine: true });
    const text = render({ days: DAYS, failed: true });
    expect(text).toContain("Couldn't refresh: saved copy, 3 hr ago");
    expect(text).toContain("Lakeview East");
  });

  it("online, a load that succeeded with no days: the empty state, and only then", () => {
    vi.stubGlobal("navigator", { onLine: true });
    const text = render({ days: [], failed: false });
    expect(text).toContain(EMPTY);
    expect(text).not.toContain("saved copy");
    expect(text).not.toContain("couldn't load");
  });
});

describe("the schedule is kept on the device", () => {
  it("is on the read cache allowlist, ranked after the route", async () => {
    const { isPersistableQueryKey, selectPersistableQueries } =
      await import("@/lib/offline/read-cache-policy");
    expect(isPersistableQueryKey(["my-upcoming-days"])).toBe(true);
    const entry = (queryKey: unknown[], at: number) => ({ queryKey, state: { dataUpdatedAt: at } });
    const kept = selectPersistableQueries(
      [entry(["my-upcoming-days"], 3), entry(["my-day", "2026-10-07", ""], 1)],
      { maxBytes: 10, sizeOf: () => 10 },
    );
    expect(kept.map((q) => q.queryKey[0])).toEqual(["my-day"]);
  });
});
