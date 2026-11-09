import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";

const state = vi.hoisted(() => ({
  cookie: "secret" as string | null,
  contact: true,
  active: true,
  locked: false,
  session: null as Record<string, unknown> | null,
  sessionReads: 0,
  rpc: vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    let validate = (data: unknown) => data;
    const builder = {
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return builder;
      },
      middleware: () => builder,
      handler: (fn: (args: unknown) => unknown) =>
        vi.fn(async (args: { data: unknown }) => fn({ ...args, data: validate(args.data) })),
    };
    return builder;
  },
}));
vi.mock("@tanstack/react-start/server", () => ({ getCookie: () => state.cookie }));
vi.mock("@/lib/account-lock.server", () => ({
  lockForOrg: async () => ({ locked: state.locked }),
}));
vi.mock("@/components/PhotoLightbox", () => ({ PhotoLightbox: () => null }));
// The platform switch (#531) is read beside the home's own reads; it is not
// one of the home's parts, so it answers the default here.
vi.mock("@/lib/service-line-availability.server", async () => ({
  loadServiceLineAvailability: async () =>
    (await import("./support/service-line-availability")).LAUNCH_DEFAULT,
}));
vi.mock("@/lib/skip-rules.functions", () => ({ customerSkipReason: () => "customer_requested" }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: state.rpc,
    from: (table: string) => {
      let columns = "";
      const query: any = {
        select: (value: string) => {
          columns = value;
          return query;
        },
        eq: () => query,
        or: () => query,
        order: () => query,
        limit: () => query,
        update: () => query,
        maybeSingle: async () => {
          if (table === "clients")
            return {
              data: state.contact
                ? {
                    id: "client-1",
                    organization_id: "org-1",
                    active: state.active,
                    primary_phone: null,
                    primary_email: null,
                    organizations: { name: "Org", portal_slug: "org", timezone: "America/Chicago" },
                  }
                : null,
            };
          if (table === "portal_sessions") {
            state.sessionReads++;
            return { data: state.session };
          }
          if (table === "skip_billing_rules") return { data: { billable_pct: 25 } };
          if (table === "organizations")
            return {
              data: {
                reclean_window_hours: 48,
                service_lines: ["pet_waste"],
              },
            };
          return { data: null };
        },
        then: (resolve: (value: unknown) => unknown) =>
          resolve({
            data:
              table === "invoices" && columns !== "id"
                ? [
                    {
                      id: "invoice-1",
                      due_on: "2026-10-01",
                      credit_applied_cents: 100,
                      tax_cents: 0,
                      tax_rate_bps: 0,
                      tax_label: null,
                    },
                  ]
                : [],
            error: null,
          }),
      };
      return query;
    },
  }),
}));

import * as portal from "@/lib/portal.functions";
import { usePortal } from "@/lib/portal-ui";

const token = "11111111-1111-4111-8111-111111111111";
const rawClient = { client_id: "client-1", organization_id: "org-1", display_name: "Pat" };
const parts = {
  client: portal.portalGetClient,
  visits: portal.portalListUpcomingVisits,
  invoices: portal.portalListInvoices,
  subs: portal.portalListPrepaidSubs,
  catalog: portal.portalListAddonCatalog,
  clientAddons: portal.portalListClientAddons,
  history: portal.portalListRecentVisits,
  dogs: portal.portalListDogs,
  referral: portal.portalGetReferral,
  stations: portal.portalListStations,
  requests: portal.portalListMyRequests,
};
const rpcRows: Record<string, unknown[]> = {
  portal_get_client: [rawClient],
  portal_list_upcoming_visits: [{ visit_id: "visit-1" }],
  portal_list_invoices: [{ invoice_id: "invoice-1", status: "open", total_cents: 1000 }],
  portal_list_prepaid_subscriptions: [{ subscription_id: "sub-1" }],
  portal_list_addon_catalog: [{ addon_service_id: "addon-1" }],
  portal_list_client_addons: [],
  portal_list_recent_visits: [],
  portal_list_dogs: [{ dog_id: "dog-1", name: "Buddy" }],
  portal_get_referral: [{ referral_code: "PAT" }],
  portal_list_stations: [],
  portal_list_my_requests: [{ ticket_id: "ticket-1" }],
};
const clients: QueryClient[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SUPABASE_URL", "https://supabase.test");
  vi.stubEnv("SERVICE_ROLE_KEY", "test-key");
  Object.assign(state, {
    cookie: "secret",
    contact: true,
    active: true,
    locked: false,
    sessionReads: 0,
  });
  state.session = {
    id: "session-1",
    client_id: "client-1",
    organization_id: "org-1",
    revoked_at: null,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    preview_by: null,
  };
  state.rpc.mockImplementation(async (name: string) => ({
    data: rpcRows[name] ?? [],
    error: null,
  }));
});

afterEach(() => {
  for (const qc of clients.splice(0)) qc.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function mountPortal(
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  value = token,
) {
  if (!clients.includes(qc)) clients.push(qc);
  let hook: ReturnType<typeof usePortal>;
  function Portal() {
    hook = usePortal(value);
    return null;
  }
  renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(Portal)));
  return { qc, hook: hook! };
}

async function fetchContext(qc: QueryClient, value = token) {
  const query = qc.getQueryCache().find({ queryKey: ["portal", value, "context"], exact: true })!;
  return qc.fetchQuery(query.options);
}

function observeParts(qc: QueryClient) {
  return Object.keys(parts).map((part) => {
    const query = qc.getQueryCache().find({ queryKey: ["portal", token, part], exact: true })!;
    const observer = new QueryObserver(qc, query.options);
    const unsubscribe = observer.subscribe(() => {});
    return { observer, unsubscribe };
  });
}

describe("portalContext home", () => {
  it("uses one session check and returns exactly the individual read answers", async () => {
    const answer = await portal.portalContext({ data: { token, withHome: true } });
    expect(state.sessionReads).toBe(1);
    expect(answer).toMatchObject({ verified: true, client: rawClient });
    const home = "home" in answer ? answer.home : undefined;
    expect(Object.keys(home ?? {})).toHaveLength(11);
    expect(home?.client).toEqual({
      ...rawClient,
      skip_billable_pct: 25,
      reclean_window_hours: 48,
      mobile_grooming: false,
      // Which "Report a concern" list the portal offers (#560).
      pet_waste: true,
      // Grooming is customer requestable since #549; the portal offers the
      // request only to a business that also runs it (mobile_grooming).
      groom_requests: true,
      // The tab bar shows Training to a business that trains (#603).
      training: false,
    });
    expect(state.rpc.mock.calls.filter(([name]) => name === "portal_get_client")).toHaveLength(2);
    for (const [name, read] of Object.entries(parts)) {
      expect(await read({ data: { token } }), name).toEqual(home?.[name as keyof typeof home]);
    }
    expect(state.sessionReads).toBe(12);
  });

  it("starts the other reads while one part is still pending", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.rpc.mockImplementation(async (name: string) => {
      if (name === "portal_list_dogs") await waiting;
      return { data: rpcRows[name] ?? [], error: null };
    });
    const loading = portal.portalContext({ data: { token, withHome: true } });
    try {
      await vi.waitFor(() => {
        const names = new Set(state.rpc.mock.calls.map(([name]) => name));
        // Eleven parts, twelve reads: the visits part also reads each visit's
        // change terms, portal_visit_change_terms (#730).
        expect(names.size).toBe(12);
        expect(names.has("portal_visit_change_terms")).toBe(true);
      });
    } finally {
      release();
    }
    expect(await loading).toHaveProperty("home.dogs", rpcRows.portal_list_dogs);
  });

  it("leaves out a part that is not back within the budget", async () => {
    state.rpc.mockImplementation(async (name: string) => {
      if (name === "portal_list_dogs") return new Promise(() => {});
      return { data: rpcRows[name] ?? [], error: null };
    });
    const started = Date.now();
    const answer = await portal.portalContext({ data: { token, withHome: true } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(portal.PORTAL_HOME_BUDGET_MS - 50);
    const home = "home" in answer ? answer.home : undefined;
    expect(home).not.toHaveProperty("dogs");
    expect(home?.visits).toEqual(rpcRows.portal_list_upcoming_visits);
    expect(Object.keys(home ?? {})).toHaveLength(10);
  });

  it("does not load home when it was not requested", async () => {
    const answer = await portal.portalContext({ data: { token } });
    expect(answer).not.toHaveProperty("home");
    expect(state.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    "missing cookie",
    "missing session",
    "expired",
    "revoked",
    "rotated",
    "inactive",
    "locked",
  ])("refuses home and every individual read for %s", async (reason) => {
    if (reason === "missing cookie") state.cookie = null;
    if (reason === "missing session") state.session = null;
    if (reason === "expired") state.session!.expires_at = "2020-01-01T00:00:00Z";
    if (reason === "revoked") state.session!.revoked_at = "2026-10-01T00:00:00Z";
    if (reason === "rotated") state.session!.client_id = "other-client";
    if (reason === "inactive") state.active = false;
    if (reason === "locked") state.locked = true;
    const answer = await portal.portalContext({ data: { token, withHome: true } });
    expect(answer.verified).toBe(false);
    expect(answer).not.toHaveProperty("home");
    expect(answer).not.toHaveProperty("client");
    for (const read of Object.values(parts))
      await expect(read({ data: { token } })).rejects.toThrow();
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("keeps invalid links and missing client rows free of home", async () => {
    state.contact = false;
    expect(await portal.portalContext({ data: { token, withHome: true } })).toEqual({
      verified: false,
      valid: false,
      channels: [],
      branding: null,
    });
    state.contact = true;
    state.rpc.mockResolvedValue({ data: [], error: null });
    expect(await portal.portalContext({ data: { token, withHome: true } })).toEqual({
      verified: false,
      valid: false,
      channels: [],
      branding: null,
    });
  });

  it("allows a staff preview to read home", async () => {
    state.session!.preview_by = "staff-1";
    const answer = await portal.portalContext({ data: { token, withHome: true } });
    expect(answer).toMatchObject({ verified: true, preview: true });
    expect(Object.keys("home" in answer ? answer.home! : {})).toHaveLength(11);
    for (const read of Object.values(parts))
      await expect(read({ data: { token } })).resolves.toBeDefined();
  });

  it("keeps token validation and validates withHome only on context", async () => {
    await expect(
      portal.portalContext({ data: { token: "bad", withHome: true } }),
    ).rejects.toThrow();
    await expect(
      portal.portalContext({ data: { token, withHome: "yes" as any } }),
    ).rejects.toThrow();
    expect(state.rpc).not.toHaveBeenCalled();
    await expect(
      portal.portalListDogs({ data: { token, withHome: "ignored" } as any }),
    ).resolves.toBeDefined();
  });
});

describe("portal home cache", () => {
  it("requests home on a first load, seeds fresh data before enabling queries, and strips home", async () => {
    const { qc } = mountPortal();
    const answer = await fetchContext(qc);
    expect(portal.portalContext).toHaveBeenLastCalledWith({ data: { token, withHome: true } });
    expect(answer).not.toHaveProperty("home");
    expect(qc.getQueryData(["portal", token, "context"])).not.toHaveProperty("home");
    for (const part of Object.keys(parts)) {
      expect(qc.getQueryData(["portal", token, part]), part).toBeDefined();
    }
    mountPortal(qc);
    const observed = observeParts(qc);
    for (const { observer, unsubscribe } of observed) {
      expect(observer.getCurrentResult().isStale).toBe(false);
      unsubscribe();
    }
    for (const read of Object.values(parts)) expect(read).not.toHaveBeenCalled();
    await qc.invalidateQueries({ queryKey: ["portal", token, "context"] });
    await fetchContext(qc);
    expect(portal.portalContext).toHaveBeenLastCalledWith({ data: { token } });
  });

  it("checks the client cache for this token when refreshing context", async () => {
    const { qc } = mountPortal();
    qc.setQueryData(["portal", "other-token", "client"], rawClient);
    await fetchContext(qc);
    expect(portal.portalContext).toHaveBeenLastCalledWith({ data: { token, withHome: true } });
    qc.removeQueries({ queryKey: ["portal", token, "client"], exact: true });
    await qc.invalidateQueries({ queryKey: ["portal", token, "context"] });
    await fetchContext(qc);
    expect(portal.portalContext).toHaveBeenLastCalledWith({ data: { token, withHome: true } });
  });

  it("leaves a failed part out, seeds the rest, and lets its own query fetch", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const original = state.rpc.getMockImplementation()!;
    state.rpc.mockImplementation(async (name: string) => {
      if (name === "portal_list_dogs") throw new Error("private client data");
      return original(name);
    });
    const { qc } = mountPortal();
    await fetchContext(qc);
    const answer = vi.mocked(portal.portalContext).mock.results[0];
    const context = await answer.value;
    expect(context.home).not.toHaveProperty("dogs");
    expect(qc.getQueryData(["portal", token, "dogs"])).toBeUndefined();
    for (const part of Object.keys(parts).filter((part) => part !== "dogs")) {
      expect(qc.getQueryData(["portal", token, part]), part).toEqual(context.home[part]);
    }
    expect(log).not.toHaveBeenCalled();
    state.rpc.mockImplementation(original);
    mountPortal(qc);
    const observed = observeParts(qc);
    await vi.waitFor(() =>
      expect(qc.getQueryData(["portal", token, "dogs"])).toEqual(rpcRows.portal_list_dogs),
    );
    for (const [part, read] of Object.entries(parts))
      expect(read).toHaveBeenCalledTimes(part === "dogs" ? 1 : 0);
    for (const { unsubscribe } of observed) unsubscribe();
  });

  it("keeps invalidation and explicit refetches working without another bundle", async () => {
    const { qc } = mountPortal();
    await fetchContext(qc);
    const { hook } = mountPortal(qc);
    const observed = observeParts(qc);
    await hook.invalidatePortal();
    for (const read of Object.values(parts)) expect(read).toHaveBeenCalledTimes(1);
    await hook.clientQ.refetch();
    expect(portal.portalGetClient).toHaveBeenCalledTimes(2);
    await fetchContext(qc);
    expect(portal.portalContext).toHaveBeenLastCalledWith({ data: { token } });
    for (const { unsubscribe } of observed) unsubscribe();
  });

  it("seeds no client queries while unverified", async () => {
    state.cookie = null;
    const { qc } = mountPortal();
    expect(await fetchContext(qc)).toMatchObject({ verified: false, valid: true });
    mountPortal(qc);
    for (const part of Object.keys(parts)) {
      const query = qc.getQueryCache().find({ queryKey: ["portal", token, part], exact: true })!;
      expect(query.state.data).toBeUndefined();
      expect(query.options.enabled).toBe(false);
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });
});
