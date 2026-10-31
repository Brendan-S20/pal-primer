// #617: /clients failed at about a thousand clients.
//
// The roster read every client, then fetched their properties, services and
// open invoices with `.in("client_id", ids)`: every client id in one GET query
// string. At about a thousand clients that URL was refused as "URI too long",
// and everything built on the read went empty: the list, the New invoice and
// One-off visit pickers. A 1,000-row import took 19 min 47 s.
//
// The acceptance this pins:
//   * at 1,000 and 5,000 clients /clients answers in under 2 s;
//   * the pickers find clients (not empty);
//   * no request URL is over 2 KB;
//   * a 1,000-row import is minutes at most, not twenty.
//
// The roster and search half runs the REAL supabase-js client against a fetch
// that answers like PostgREST, so the URLs measured are the URLs production
// sends, not a reconstruction of them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    const b: any = {
      middleware: () => b,
      inputValidator: (v: (d: unknown) => unknown) => {
        b.validate = v;
        return b;
      },
      handler: (h: any) => (input: any) =>
        h({
          data: b.validate ? b.validate(input?.data) : input?.data,
          context: { supabase: state.supabase, userId: "owner" },
        }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/authz.server", () => ({
  resolveCaller: async () => ({ orgId: "org", role: "owner" }),
  requirePermission: async () => ({ orgId: "org", role: "owner" }),
}));

const state = vi.hoisted(() => ({ supabase: null as any }));

import { listClients, listClientsPage, searchClients } from "@/lib/clients.functions";
import {
  accentPattern,
  clientMatchesQuery,
  clientSearchOrFilter,
  fold,
} from "@/lib/client-search";
import { filterRoster, rosterStats } from "@/lib/client-roster";
import { fetchAllPagesConcurrently, idChunks } from "@/lib/supabase-paging.server";

const root = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

// ── A PostgREST that holds a book of N clients ────────────────────────────

const LATENCY_MS = 60;
type Seen = { url: string; method: string };

function book(n: number) {
  const clients = Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    display_name: i === 7 ? "José Núñez" : `Client ${i}`,
    company: null,
    first_name: null,
    last_name: null,
    account_type: i % 4 === 1 ? "commercial" : "residential",
    primary_email: `client${i}@example.test`,
    primary_phone: i === 7 ? "(312) 555-0199" : null,
    import_external_id: i === 7 ? "JOB-48213" : null,
    active: i % 10 !== 0,
    created_at: new Date(2026, 0, 1 + (i % 300)).toISOString(),
    credit_balance_cents: 0,
    churn_score: i % 7 === 0 ? 75 : 10,
    comms_paused: false,
    tags: i % 2 ? ["Weekly"] : [],
  }));
  const properties = clients.map((c, i) => ({
    id: `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    client_id: c.id,
    street: i === 7 ? "4400 N Ravenswood Ave" : `${100 + i} Oak Street`,
    created_at: c.created_at,
    archived_at: null,
    dogs: [{ id: `d${i}`, active: true, species: "dog" }],
  }));
  const subscriptions = clients
    .filter((_, i) => i % 3)
    .map((c, i) => ({
      client_id: c.id,
      property_id: properties[i].id,
      status: "active",
      frequency: "weekly",
      ends_on: null,
      account_type: "residential",
      dog_count: 1,
      stay_id: null,
    }));
  const invoices = clients
    .filter((_, i) => i % 5 === 0)
    .map((c) => ({
      client_id: c.id,
      total_cents: 5000,
      credit_applied_cents: 0,
      amount_paid_cents: 0,
      status: "open",
    }));
  return { clients, properties, subscriptions, invoices } as Record<string, any[]>;
}

function fakePostgrest(tables: Record<string, any[]>, seen: Seen[]) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    seen.push({ url: url.toString(), method: init?.method ?? "GET" });
    await new Promise((r) => setTimeout(r, LATENCY_MS));
    const table = url.pathname.split("/").pop()!;
    let rows = tables[table] ?? [];
    // Enough of PostgREST's filtering for these tests to mean something: a
    // search must narrow, and paging must page.
    const or = url.searchParams.get("or");
    if (or) {
      const terms = or.replace(/^\(|\)$/g, "").split(",");
      rows = rows.filter((r) =>
        terms.some((t) => {
          const [col, op, ...rest] = t.split(".");
          const v = rest.join(".");
          const cell = r[col];
          if (cell == null) return false;
          if (op === "imatch") return new RegExp(v, "i").test(String(cell));
          const rx = new RegExp(
            "^" + v.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/_/g, ".") + "$",
            op === "ilike" ? "i" : "",
          );
          return rx.test(String(cell));
        }),
      );
    }
    if (url.searchParams.get("active") === "eq.true") rows = rows.filter((r) => r.active);
    const street = url.searchParams.get("properties.street");
    if (street) {
      const needle = street.replace(/^ilike\./, "").replace(/[%*]/g, "").toLowerCase();
      const ids = new Set(
        tables.properties
          .filter((p) => String(p.street).toLowerCase().includes(needle))
          .map((p) => p.client_id),
      );
      rows = rows
        .filter((r) => ids.has(r.id))
        .map((r) => ({ ...r, properties: tables.properties.filter((p) => p.client_id === r.id) }));
    } else if ((url.searchParams.get("select") ?? "").includes("properties(")) {
      const byClient = new Map<string, any[]>();
      for (const p of tables.properties) {
        byClient.set(p.client_id, [...(byClient.get(p.client_id) ?? []), p]);
      }
      rows = rows.map((r) => ({ ...r, properties: byClient.get(r.id) ?? [] }));
    }
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 1000), 1000);
    const body = rows.slice(offset, offset + limit);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

let seen: Seen[];
function useBook(n: number) {
  seen = [];
  state.supabase = createClient("https://db.example.test", "anon-key", {
    global: { fetch: fakePostgrest(book(n), seen) as typeof fetch },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const longestUrl = () => Math.max(...seen.map((s) => s.url.length));

describe("/clients at 1,000 and 5,000 clients", () => {
  it.each([1_000, 5_000])("answers one page in under 2 s at %i clients", async (n) => {
    useBook(n);
    const started = Date.now();
    const page = await listClientsPage({ data: {} });
    const took = Date.now() - started;
    expect(page.rows).toHaveLength(50);
    expect(page.stats.total).toBe(n);
    expect(page.matched).toBe(n);
    // Every request takes 60 ms here. One after another, 5,000 clients is six
    // pages of each of four tables; side by side and several pages at once
    // it is three round trips.
    expect(took).toBeLessThan(2_000);
    expect(took).toBeLessThan(LATENCY_MS * 6);
  });

  it.each([1_000, 5_000])("sends no URL over 2 KB at %i clients", async (n) => {
    useBook(n);
    await listClientsPage({ data: { q: "José", status: "active", type: "residential" } });
    await listClients();
    expect(longestUrl()).toBeLessThan(2_048);
  });

  it("reads every row past PostgREST's thousand, and counts them right", async () => {
    useBook(5_000);
    const { clients } = await listClients();
    expect(clients).toHaveLength(5_000);
    expect(new Set(clients.map((c: any) => c.id)).size).toBe(5_000);
    const c7 = clients.find((c: any) => c.display_name === "José Núñez");
    expect(c7).toMatchObject({ active_subscription_count: 1, dog_count: 1, street: "4400 N Ravenswood Ave" });
    const c0 = clients.find((c: any) => c.display_name === "Client 0");
    expect(c0.outstanding_cents).toBe(5000);
  });

  it("filters and searches on the server, and pages what it found", async () => {
    useBook(1_000);
    const atRisk = await listClientsPage({ data: { status: "at_risk", limit: 10, offset: 10 } });
    expect(atRisk.matched).toBe(Math.ceil(1_000 / 7));
    expect(atRisk.rows).toHaveLength(10);
    expect(atRisk.offset).toBe(10);
    const byPhone = await listClientsPage({ data: { q: "555 0199" } });
    expect(byPhone.rows.map((r: any) => r.display_name)).toEqual(["José Núñez"]);
    const everything = await listClientsPage({ data: { all: true } });
    expect(everything.rows).toHaveLength(1_000);
  });

  it("never reads by a list of client ids", () => {
    const src = read("src/lib/clients.functions.ts");
    const roster = src.slice(src.indexOf("async function loadClientRoster"), src.indexOf("export const listClients"));
    expect(roster).not.toMatch(/\.in\(\s*"client_id"/);
    expect(roster.match(/\.eq\("organization_id", orgId\)/g)).toHaveLength(4);
  });
});

describe("the pickers and Cmd-K search on the server", () => {
  it("are not empty with nothing typed", async () => {
    useBook(5_000);
    const r = await searchClients({ data: { activeOnly: true } });
    expect(r.clients.length).toBe(20);
    expect(r.clients.every((c: any) => c.active)).toBe(true);
  });

  it.each([
    ["jose", "an accent typed without it"],
    ["NÚÑEZ", "an accent typed with it, in capitals"],
    ["555-0199", "a phone number with other punctuation"],
    ["3125550199", "a phone number as bare digits"],
    ["job-48213", "the id a Jobber import carried"],
    ["4400 ravenswood", "a street number and name"],
  ])("finds a client by %s (%s)", async (q) => {
    useBook(5_000);
    const r = await searchClients({ data: { q, limit: 6 } });
    expect(r.clients.map((c: any) => c.display_name)).toContain("José Núñez");
    expect(longestUrl()).toBeLessThan(2_048);
  });

  it("keeps the longest possible query under 2 KB", async () => {
    useBook(1_000);
    await searchClients({ data: { q: "aeiouaeiouaeiouaeiouaeiou ".repeat(7).slice(0, 200) } });
    await searchClients({ data: { q: "(312) 555-0199 555-0199 555-0199" } });
    expect(longestUrl()).toBeLessThan(2_048);
  });

  it("the two pickers and Cmd-K use it, not the whole roster", () => {
    for (const f of ["src/components/OneOffVisitDialog.tsx", "src/routes/_authenticated/invoices.index.tsx"]) {
      const src = read(f);
      expect(src, f).toContain("<ClientSearchPicker");
      expect(src, f).not.toContain("listClients");
    }
    const palette = read("src/components/CommandPalette.tsx");
    expect(palette).toMatch(/searchFn\(\{ data: \{ q, limit: 6 \} \}\)/);
    expect(palette).not.toMatch(/\.ilike\("display_name"/);
    expect(read("src/components/ClientSearchPicker.tsx")).toContain("useServerFn(searchClients)");
  });
});

describe("the search rule", () => {
  const jose = {
    display_name: "José Núñez",
    primary_email: "jn@example.test",
    primary_phone: "+1 (312) 555-0199",
    import_external_id: "JOB-48213",
    streets: ["4400 N Ravenswood"],
    tags: ["Tuesday"],
  };
  it.each(["jose", "josé nunez", "nuñ", "555-0199", "5550199", "job-482", "4400", "ravens", "tues"])(
    "matches %s",
    (q) => expect(clientMatchesQuery(jose, q)).toBe(true),
  );
  it.each(["maria", "5551234", "999", "jose smith"])("does not match %s", (q) =>
    expect(clientMatchesQuery(jose, q)).toBe(false),
  );
  it("folds accents and case", () => {
    expect(fold("José NÚÑEZ")).toBe("jose nunez");
    expect(new RegExp(accentPattern("jose"), "i").test("José")).toBe(true);
    expect(new RegExp(accentPattern("nunez"), "i").test("NÚÑEZ")).toBe(true);
  });
  it("builds a filter with no characters PostgREST would split on", () => {
    const or = clientSearchOrFilter("o'brien, (the) \"dog\" man")!;
    for (const term of or.split(",")) expect(term).toMatch(/^[a-z_]+\.(imatch|ilike|like)\./);
    expect(or).not.toMatch(/[()"]/);
  });
});

describe("the list's filters", () => {
  const rows = [
    { id: "a", display_name: "A", account_type: "residential", primary_email: null, primary_phone: null, active: true, churn_score: 80, tags: ["VIP"], outstanding_cents: 100, active_subscription_count: 0 },
    { id: "b", display_name: "B", account_type: "commercial", primary_email: null, primary_phone: null, active: false, churn_score: 0, tags: [], outstanding_cents: 0, active_subscription_count: 0 },
    { id: "c", display_name: "C", account_type: "residential", primary_email: null, primary_phone: null, active: true, churn_score: 10, tags: ["vip"], outstanding_cents: 0, active_subscription_count: 2 },
  ];
  it("each filter keeps what it says", () => {
    expect(filterRoster(rows, { status: "no_plan" }).map((r) => r.id)).toEqual(["a"]);
    expect(filterRoster(rows, { status: "inactive" }).map((r) => r.id)).toEqual(["b"]);
    expect(filterRoster(rows, { status: "outstanding" }).map((r) => r.id)).toEqual(["a"]);
    expect(filterRoster(rows, { status: "at_risk" }).map((r) => r.id)).toEqual(["a"]);
    expect(filterRoster(rows, { type: "commercial" }).map((r) => r.id)).toEqual(["b"]);
    expect(filterRoster(rows, { tag: "VIP" }).map((r) => r.id)).toEqual(["a", "c"]);
  });
  it("the tiles count the whole book", () => {
    expect(rosterStats(rows)).toEqual({ total: 3, active: 2, outstanding: 1, owedTotal: 100, atRisk: 1, noPlan: 1 });
  });
});

describe("paging helpers", () => {
  it("asks for one page when one page is all there is", async () => {
    const calls: number[] = [];
    const out = await fetchAllPagesConcurrently<number>(async (from) => {
      calls.push(from);
      return { data: [1, 2, 3], error: null };
    });
    expect(out).toEqual([1, 2, 3]);
    expect(calls).toEqual([0]);
  });
  it("reads 4,500 rows in three rounds, in order", async () => {
    const rows = Array.from({ length: 4_500 }, (_, i) => i);
    let inFlight = 0,
      most = 0;
    const out = await fetchAllPagesConcurrently<number>(async (from, to) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { data: rows.slice(from, to + 1), error: null };
    });
    expect(out).toEqual(rows);
    expect(most).toBe(4);
  });
  it("splits ids into GETs under 2 KB", () => {
    const ids = Array.from({ length: 500 }, () => crypto.randomUUID());
    const chunks = idChunks(ids);
    expect(chunks.flat()).toEqual(ids);
    for (const c of chunks) expect(`id=in.(${c.join(",")})`.length).toBeLessThan(1_600);
  });
  it("bulk tagging and the churn panel no longer put id lists in one GET", () => {
    const clients = read("src/lib/clients.functions.ts");
    const bulk = clients.slice(clients.indexOf("export const bulkTagClients"));
    expect(bulk).toMatch(/idChunks\(data\.ids\)/);
    const churn = read("src/lib/churn.functions.ts");
    const atRisk = churn.slice(churn.indexOf("export const listAtRiskClients"), churn.indexOf("function makePromoCode"));
    expect(atRisk).not.toMatch(/\.in\(\s*"client_id"/);
    expect(atRisk).toMatch(/visits\(completed_at\)/);
  });
});

afterEach(() => {
  state.supabase = null;
});
beforeEach(() => {
  seen = [];
});

describe("the geocoder's budget for an import", () => {
  it("stops asking Nominatim once the budget is spent, and says null for the rest", async () => {
    vi.stubEnv("GEOCODIO_API_KEY", "");
    const fetchSpy = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const { geocodeAddresses } = await import("@/lib/geocode.server");
      const list = Array.from({ length: 5 }, (_, i) => ({ street: `${i} Oak St`, city: "Chicago" }));
      expect(await geocodeAddresses(list, { nominatimBudgetMs: 0 })).toEqual([null, null, null, null, null]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
