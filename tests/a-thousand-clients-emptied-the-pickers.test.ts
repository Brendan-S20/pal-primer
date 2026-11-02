// #617: /clients failed at about a thousand clients.
//
// The roster read every client, then fetched their properties, services and
// open invoices with `.in("client_id", ids)`: every client id in one GET query
// string. At about a thousand clients that URL was refused as "URI too long",
// and everything built on the read went empty: the list, the New invoice and
// One-off visit pickers. A 1,000-row import took 19 min 47 s.
//
// The acceptance this pins:
//   * at 1,000 and 5,000 clients /clients answers in under 2 s, which is
//     asserted as round trips counted, not as time on the test machine;
//   * the pickers find clients (not empty);
//   * no request URL is over 2 KB;
//   * a 1,000-row import is minutes at most, not twenty.
//
// The roster and search half runs the REAL supabase-js client against a fetch
// that answers like PostgREST, so the URLs measured are the URLs production
// sends, not a reconstruction of them.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  resolveCaller: async () => ({ orgId: "org", role: state.role }),
  requirePermission: async () => ({ orgId: "org", role: state.role }),
}));
// The directory is read with the service role once the gate above has passed
// (directoryReader in clients.functions.ts says why that is RLS's own
// answer). Here the user's client and the service role are the same fake.
vi.mock("@/integrations/supabase/client.server", () => ({
  // A plain value, as the other mocks of this module are, forwarding to
  // whichever fake the test set up last.
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, key) => (state.supabase as any)[key as any] },
  ),
}));

const state = vi.hoisted(() => ({ supabase: null as any, role: "owner" }));

import { listClients, listClientsPage, listClientsSummary, searchClients } from "@/lib/clients.functions";
import { fakePostgrest, roundTrips, type Seen } from "./support/fake-postgrest";
import {
  accentPattern,
  clientMatchesQuery,
  clientSearchOrFilter,
  fold,
} from "@/lib/client-search";
import { filterRoster, rosterStats, rosterTags } from "@/lib/client-roster";
import { fetchAllPagesConcurrently, idChunks } from "@/lib/supabase-paging.server";

const root = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

// ── A PostgREST that holds a book of N clients ────────────────────────────

const LATENCY_MS = 60;
/** A real Supabase project URL is this long (a 20-character project ref).
 *  The URL limit is about the whole request line, so the host counts. */
const SUPABASE_URL = "https://abcdefghijklmnopqrst.supabase.co";
const TODAY = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

function book(n: number) {
  const clients = Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    organization_id: "org",
    display_name: i === 7 ? "José Núñez" : `Client ${i}`,
    company: i === 9 ? "Ravenswood Property Group" : null,
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
    // Two spellings of one tag, as an import and a person typing make them.
    tags: i % 2 ? [i % 6 === 1 ? "weekly" : "Weekly"] : [],
  }));
  const properties = clients.flatMap((c, i) => [
    {
      id: `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      organization_id: "org",
      client_id: c.id,
      street: i === 7 ? "4400 N Ravenswood Ave" : `${100 + i} Oak Street`,
      created_at: c.created_at,
      archived_at: null,
    },
    // A second address on some, so a search by it has to find the client.
    ...(i % 50 === 3
      ? [
          {
            id: `11000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
            organization_id: "org",
            client_id: c.id,
            street: `${i} Second Lot Road`,
            created_at: new Date(2026, 5, 1).toISOString(),
            archived_at: null,
          },
        ]
      : []),
  ]);
  const dogs = properties
    .filter((p) => p.id.startsWith("1000"))
    .map((p, i) => ({ id: `d${i}`, property_id: p.id, active: true, species: "dog" }));
  const subscriptions = clients.flatMap((c, i) =>
    i % 3
      ? [
          {
            id: `s${i}`,
            organization_id: "org",
            client_id: c.id,
            property_id: properties.find((p) => p.client_id === c.id)!.id,
            // Ended two ways, which "No service plan" has to agree on.
            status: i % 11 === 0 ? "canceled" : "active",
            frequency: "weekly",
            ends_on: i % 13 === 0 ? "2020-01-01" : i % 17 === 0 ? "2999-01-01" : null,
            account_type: "residential",
            dog_count: 1,
            stay_id: null,
          },
        ]
      : [],
  );
  const invoices = clients.flatMap((c, i) =>
    i % 5 === 0
      ? [
          {
            id: `i${i}`,
            organization_id: "org",
            client_id: c.id,
            total_cents: 5000,
            credit_applied_cents: 0,
            // Open, but paid in full: not a balance.
            amount_paid_cents: i % 25 === 0 ? 5000 : 0,
            status: "open",
          },
        ]
      : [],
  );
  return { clients, properties, dogs, subscriptions, invoices } as Record<string, any[]>;
}

const RELATIONS = {
  clients: { properties: "client_id", subscriptions: "client_id", invoices: "client_id" },
  properties: { dogs: "property_id" },
};

let seen: Seen[];
function useBook(n: number, tables: Record<string, any[]> = book(n)) {
  seen = [];
  state.supabase = createClient(SUPABASE_URL, "anon-key", {
    global: {
      fetch: fakePostgrest(tables, RELATIONS, seen, { latencyMs: LATENCY_MS }) as typeof fetch,
    },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const longestUrl = () => Math.max(...seen.map((s) => s.url.length));
const rowsRead = () => seen.reduce((n, s) => n + s.rows, 0);
const tablesRead = () => [...new Set(seen.map((s) => s.table))].sort();

/** What the browser does on opening /clients: the page and the tiles, at once. */
async function firstLoad() {
  const [page, summary] = await Promise.all([listClientsPage({ data: {} }), listClientsSummary()]);
  return { page, summary };
}

const timings: string[] = [];

// Every handler here loads its helpers with `await import(...)` before its
// first request. Cold, on a loaded runner, one of those can take longer than
// the fake's latency, so the summary's first request went out after the
// page's had been answered and roundTrips read 2 where production makes 1
// (#683: "expected 2 to be 1" at 1,000 clients, the first case in the file,
// cleared by re-running). A server process loads these once, so the
// question is about a warm one. Loaded here, once, on a small book; after
// this nothing between a handler starting and its requests leaving waits on
// a timer, so which requests go out side by side is decided by the code
// alone and not by how fast the machine is.
beforeAll(async () => {
  useBook(60);
  await firstLoad();
  await listClientsPage({ data: { q: "client 4", status: "outstanding" } });
  await listClients();
  await searchClients({ data: {} });
  await searchClients({ data: { q: "street 4" } });
});

describe("/clients at 1,000 and 5,000 clients", () => {

  it.each([1_000, 5_000])("opens in under 2 s at %i clients", async (n) => {
    useBook(n);
    const started = Date.now();
    const { page, summary } = await firstLoad();
    const took = Date.now() - started;
    timings.push(`first load at ${n}: ${took} ms, ${seen.length} requests, ${rowsRead()} rows`);
    expect(page.rows).toHaveLength(50);
    expect(page.matched).toBe(n);
    expect(summary.stats.total).toBe(n);
    // The page, the four counts, the open invoices and the tags all go out
    // side by side: one round trip, and a second only when the tags run past
    // a thousand rows. Counted, not timed: a wall-clock ceiling near the
    // fake's latency failed on a loaded CI runner (609 ms against 480) with
    // the same requests, because it also measured this fake's own CPU. The
    // 2 s is what this count buys in production; the time is logged below.
    expect(roundTrips(seen)).toBe(n > 1_000 ? 2 : 1);
    expect(seen.filter((r) => r.url.includes("limit=50"))).toHaveLength(1);
    expect(tablesRead()).toEqual(["clients", "invoices"]);
  });

  it("a page turn is ONE request for 50 rows, not the book again", async () => {
    useBook(5_000);
    const started = Date.now();
    const page = await listClientsPage({ data: { offset: 50 } });
    timings.push(`page 2 at 5000: ${Date.now() - started} ms, ${seen.length} request, ${rowsRead()} rows`);
    expect(page.rows).toHaveLength(50);
    expect(page.matched).toBe(5_000);
    expect(seen).toHaveLength(1);
    expect(seen[0].table).toBe("clients");
    expect(seen[0].url).toContain("offset=50");
    expect(seen[0].url).toContain("limit=50");
    expect(rowsRead()).toBe(50);
  });

  it.each([
    ["active", { status: "active" }],
    ["inactive", { status: "inactive" }],
    ["at churn risk", { status: "at_risk" }],
    ["no service plan", { status: "no_plan" }],
    ["commercial", { type: "commercial" }],
    ["a tag", { tag: "Weekly", tagSpellings: ["Weekly", "weekly"] }],
  ] as const)("the %s filter is ONE request for one page", async (_label, f) => {
    useBook(5_000);
    const page = await listClientsPage({ data: { ...f } });
    expect(seen).toHaveLength(1);
    expect(tablesRead()).toEqual(["clients"]);
    expect(rowsRead()).toBeLessThanOrEqual(50);
    expect(page.rows.length).toBeGreaterThan(0);
  });

  it("a search reads the clients it could match, not the book", async () => {
    useBook(5_000);
    const started = Date.now();
    const page = await listClientsPage({ data: { q: "José" } });
    timings.push(`search "José" at 5000: ${Date.now() - started} ms, ${seen.length} requests, ${rowsRead()} rows`);
    expect(page.rows.map((r: any) => r.display_name)).toEqual(["José Núñez"]);
    expect(tablesRead()).toEqual(["clients"]);
    expect(rowsRead()).toBeLessThan(50);
    // Two round trips: the candidates (by name and by street, side by side),
    // then the page's rows.
    expect(seen).toHaveLength(3);
    expect(roundTrips(seen)).toBe(2);
  });

  it("'Has balance' reads the clients with an open invoice, not the book", async () => {
    useBook(5_000);
    const page = await listClientsPage({ data: { status: "outstanding" } });
    // Every fifth client has an open invoice; one in five of those is paid.
    expect(page.matched).toBe(800);
    expect(tablesRead()).toEqual(["clients"]);
    // The 1,000 with an open invoice, then the page's 50.
    expect(rowsRead()).toBeLessThanOrEqual(1_000 + 50);
  });

  it("agrees with the whole-book roster on every filter, count and row", async () => {
    useBook(1_000);
    const { clients: roster } = await listClients();
    const cases: Array<Record<string, unknown>> = [
      {},
      { status: "active" },
      { status: "inactive" },
      { status: "outstanding" },
      { status: "at_risk" },
      { status: "no_plan" },
      { type: "commercial" },
      { tag: "weekly", tagSpellings: ["Weekly", "weekly"] },
      { q: "oak 12" },
      { q: "second lot" },
      { q: "ravenswood" },
      { q: "555-0199" },
      { status: "no_plan", type: "residential", q: "oak" },
    ];
    for (const f of cases) {
      const want = filterRoster(roster, f as any);
      for (const offset of [0, 50]) {
        const got = await listClientsPage({ data: { ...f, offset } });
        expect(got.matched, JSON.stringify(f)).toBe(want.length);
        const slice = want.slice(offset, offset + 50);
        expect(got.rows.map((r: any) => r.id), JSON.stringify(f)).toEqual(slice.map((r: any) => r.id));
        const { streets: _s, ...first } = (slice[0] ?? {}) as any;
        if (slice.length) expect(got.rows[0], JSON.stringify(f)).toEqual(first);
      }
    }
  });

  it("the tiles count the whole book, the same as the roster", async () => {
    useBook(1_000);
    const { clients: roster } = await listClients();
    const summary = await listClientsSummary();
    expect(summary.stats).toEqual(rosterStats(roster));
    expect(summary.tags).toEqual(rosterTags(roster));
    expect(summary.tagSpellings.weekly.sort()).toEqual(["Weekly", "weekly"]);
  });

  it.each([1_000, 5_000])("sends no URL over 2 KB at %i clients, on a real project's host", async (n) => {
    useBook(n);
    await listClientsPage({ data: { q: "José", status: "active", type: "residential" } });
    await listClientsPage({ data: { q: "aeiouaeiouaeiouaeiouaeiou ".repeat(7).slice(0, 200), status: "outstanding" } });
    await listClientsPage({ data: { status: "no_plan", tag: "Weekly", tagSpellings: ["Weekly", "weekly"] } });
    await listClientsSummary();
    await listClients();
    expect(seen.every((s) => s.url.startsWith(SUPABASE_URL))).toBe(true);
    expect(longestUrl()).toBeLessThan(2_048);
  });

  it("reads every row past PostgREST's thousand, and counts them right", async () => {
    useBook(5_000);
    const started = Date.now();
    const { clients } = await listClients();
    // What every page turn, filter and keystroke used to cost.
    timings.push(`whole book at 5000 (each page before this change): ${Date.now() - started} ms, ${seen.length} requests, ${rowsRead()} rows`);
    expect(clients).toHaveLength(5_000);
    expect(new Set(clients.map((c: any) => c.id)).size).toBe(5_000);
    const c7 = clients.find((c: any) => c.display_name === "José Núñez");
    expect(c7).toMatchObject({ dog_count: 1, street: "4400 N Ravenswood Ave" });
    const c0 = clients.find((c: any) => c.display_name === "Client 0");
    expect(c0.outstanding_cents).toBe(0);
    const c5 = clients.find((c: any) => c.display_name === "Client 5");
    expect(c5.outstanding_cents).toBe(5000);
  });

  it("export still gets every matching row", async () => {
    useBook(1_000);
    const everything = await listClientsPage({ data: { all: true } });
    expect(everything.rows).toHaveLength(1_000);
    const atRisk = await listClientsPage({ data: { status: "at_risk", all: true } });
    expect(atRisk.matched).toBe(Math.ceil(1_000 / 7));
  });

  it("a dispatcher reads no invoices and sees no balances, as RLS gave it none", async () => {
    useBook(1_000);
    state.role = "dispatcher";
    try {
      const owing = await listClientsPage({ data: { status: "outstanding" } });
      expect(owing).toMatchObject({ rows: [], matched: 0 });
      const page = await listClientsPage({ data: {} });
      expect(page.rows.every((r: any) => r.outstanding_cents === 0)).toBe(true);
      const summary = await listClientsSummary();
      expect(summary.stats).toMatchObject({ outstanding: 0, owedTotal: 0 });
      expect(seen.some((x) => x.table === "invoices")).toBe(false);
      // Not even embedded: no request this role makes asks for invoices.
      for (const x of seen) {
        expect(new URL(x.url).searchParams.get("select") ?? "", x.url).not.toMatch(/invoices/);
      }
      const search = await listClientsPage({ data: { q: "client 4" } });
      expect(search.rows.every((r: any) => r.outstanding_cents === 0)).toBe(true);
      const all = await listClientsPage({ data: { all: true } });
      expect(all.rows.every((r: any) => r.outstanding_cents === 0)).toBe(true);
      for (const x of seen) {
        expect(new URL(x.url).searchParams.get("select") ?? "", x.url).not.toMatch(/invoices/);
      }
    } finally {
      state.role = "owner";
    }
  });

  it("never returns a client of another business, on any path", async () => {
    // A second business whose clients would match every query below, with
    // its own properties, services and invoices.
    const mine = book(1_000);
    const theirs = book(1_000);
    const other = (id: string) => `99${id.slice(2)}`;
    for (const t of Object.values(theirs)) {
      for (const r of t) {
        if (r.organization_id) r.organization_id = "other-org";
        r.id = other(String(r.id));
        if (r.client_id) r.client_id = other(r.client_id);
        if (r.property_id) r.property_id = other(r.property_id);
      }
    }
    for (const c of theirs.clients) c.display_name = `${c.display_name} (other business)`;
    const tables = Object.fromEntries(
      Object.keys(mine).map((k) => [k, [...mine[k], ...theirs[k]]]),
    );
    useBook(1_000, tables);
    const leaked = (rows: any[]) => rows.filter((r) => String(r.id).startsWith("99"));

    const reads = [
      (await listClientsPage({ data: {} })).rows,
      (await listClientsPage({ data: { q: "jose" } })).rows,
      (await listClientsPage({ data: { q: "4400 ravenswood" } })).rows,
      (await listClientsPage({ data: { status: "outstanding" } })).rows,
      (await listClientsPage({ data: { status: "no_plan" } })).rows,
      (await listClientsPage({ data: { all: true } })).rows,
      (await listClients()).clients,
      (await searchClients({ data: {} })).clients,
      (await searchClients({ data: { q: "jose" } })).clients,
      (await searchClients({ data: { q: "555-0199" } })).clients,
      (await searchClients({ data: { q: "4400 ravenswood" } })).clients,
    ];
    for (const rows of reads) expect(leaked(rows)).toEqual([]);
    expect(reads[0].length).toBeGreaterThan(0);
    expect(reads[5]).toHaveLength(1_000);
    const summary = await listClientsSummary();
    expect(summary.stats.total).toBe(1_000);
    const mineOwed = rosterStats(
      (await listClientsPage({ data: { all: true } })).rows as any[],
    ).owedTotal;
    expect(summary.stats.owedTotal).toBe(mineOwed);
  });

  it("never reads by a list of client ids", () => {
    const src = read("src/lib/clients.functions.ts");
    const roster = src.slice(src.indexOf("async function loadClientRoster"), src.indexOf("function rosterToday"));
    expect(roster).not.toMatch(/\.in\(\s*"client_id"/);
    expect(roster.match(/\.eq\("organization_id", orgId\)/g)).toHaveLength(4);
  });

  afterAll(() => {
    // The numbers the PR quotes: a fake database at 60 ms a request, which
    // shows the SHAPE (how many round trips, how many rows), not a live time.
    console.log(["/clients against 60 ms per request:", ...timings].join("\n  "));
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

  it("does not stop at a first batch of near misses", async () => {
    useBook(5_000);
    // "street" (the longest word, so the one the database filters on) is on
    // every address. "4999" is on one: client 4899's, far down the list by
    // name. A fixed first batch of 80 never reached it.
    const r = await searchClients({ data: { q: "street 4999", limit: 6 } });
    expect(r.clients.map((c: any) => c.street)).toContain("4999 Oak Street");
    // Batches that double: a handful of round trips, not one per 80 rows.
    // Counted, so a slow machine cannot fail it (it read 9 sequential trips
    // when this was written, about 1.1 s against a 60 ms database).
    expect(seen.length).toBeLessThanOrEqual(12);
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

  it("Cmd-K says a search failed rather than that nothing matched", () => {
    const palette = read("src/components/CommandPalette.tsx");
    const failure = palette.slice(palette.indexOf("} catch {"), palette.indexOf("}, 150);"));
    // The catch records the failure; it does not just empty the list, which
    // drew "No results." for a client that exists.
    expect(failure).toMatch(/setSearchFailed\(true\)/);
    // A typed query clears it, and a success clears it.
    expect(palette.match(/setSearchFailed\(false\)/g)?.length).toBeGreaterThanOrEqual(2);
    // The row is drawn with the query as a keyword, so cmdk's own filter
    // keeps it on screen whatever was typed.
    const row = palette.slice(palette.indexOf("{searchFailed && ("));
    expect(row).toMatch(/keywords=\{\[query\]\}/);
    expect(row.slice(0, 600)).toContain("Search failed");
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
