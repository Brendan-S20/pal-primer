// #617: a 1,000-row client import took 19 min 47 s.
//
// Two causes. Without a Geocodio key every address was one Nominatim request
// a second (about 17 minutes for 1,000), and every row then made about five
// round trips one after another: the client insert, its import_rows update, a
// fresh read of every zone, the property insert, and a skip's own update.
//
// Now the geocoder has a budget, the zones are read once, clients and
// properties go in 200 at a time, and the rows' results are written twenty at
// once. Here every request takes 10 ms: the old shape would be well over 40 s
// of waiting for 1,000 rows; this asserts it is a few seconds at most.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const chain = {
      middleware: () => chain,
      inputValidator: () => chain,
      handler: (handler: unknown) => handler,
    };
    return chain;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/authz.server", () => ({
  requirePermission: vi.fn(async () => ({ orgId: "org" })),
  resolveCaller: vi.fn(async () => ({ orgId: "org", role: "owner" })),
}));
const geocodeCalls = vi.hoisted(() => [] as { n: number; budget: unknown }[]);
vi.mock("@/lib/geocode.server", () => ({
  geocodeAddresses: vi.fn(async (list: unknown[], opts: { nominatimBudgetMs?: number }) => {
    geocodeCalls.push({ n: list.length, budget: opts?.nominatimBudgetMs });
    return list.map((_, i) => (i % 2 ? { latitude: 41.9, longitude: -87.6, precision: "house" } : null));
  }),
  geocodeAddress: vi.fn(async () => {
    throw new Error("an import must not geocode row by row");
  }),
}));

import { commitImport } from "@/lib/imports.functions";
import { geocodeAddresses } from "@/lib/geocode.server";

const LATENCY = 10;
const N = 1_000;

let batch: Record<string, unknown>;
let requests: { table: string; op: string; size: number }[];
let clientRows: Record<string, unknown>[];
let propertyRows: Record<string, unknown>[];
let rowUpdates: Record<string, unknown>[];
let failInsertFor: string | null;
let zonesFail: boolean;
let maxInFlight: number;
let inFlight: number;

function importRows() {
  return Array.from({ length: N }, (_, i) => ({
    id: `row-${i}`,
    action: "create",
    target_id: null,
    mapped: {
      display_name: `Client ${i}`,
      account_type: "residential",
      // Row 999 names the same person as row 0: still created once.
      primary_email: i === 999 ? "client0@example.test" : `client${i}@example.test`,
      external_id: i === 999 ? "ext-0" : `ext-${i}`,
      street: `${100 + i} Oak St`,
      city: "Chicago",
      postal_code: "60610",
    },
  }));
}

function backend() {
  const rows = importRows();
  return {
    rpc: async () => ({ data: true, error: null }),
    from(table: string) {
      let op = "select";
      let payload: any = {};
      let from = 0;
      const filters: [string, string, unknown][] = [];
      const run = async () => {
        const size = Array.isArray(payload) ? payload.length : 1;
        requests.push({ table, op, size });
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, LATENCY));
        inFlight -= 1;
        if (table === "import_batches") {
          if (op === "update") {
            const matches = filters.every(([o, k, v]) =>
              o === "eq" || o === "is" ? batch[k] === v : true,
            );
            if (!matches) return { data: null, error: null };
            Object.assign(batch, payload);
            return { data: { id: batch.id }, error: null };
          }
          if (filters.some(([o, k]) => o === "neq" && k === "id")) return { data: [], error: null };
          return { data: { ...batch }, error: null };
        }
        if (table === "import_rows") {
          if (op === "update") {
            rowUpdates.push({ ...payload, id: filters.find(([, k]) => k === "id")?.[2] });
            return { data: null, error: null };
          }
          return { data: rows.slice(from, from + 1000), error: null };
        }
        if (table === "zones" && zonesFail) {
          return { data: null, error: { message: "canceling statement due to statement timeout" } };
        }
        if (table === "clients" && op === "insert") {
          const list = Array.isArray(payload) ? payload : [payload];
          if (failInsertFor && list.some((c) => c.display_name === failInsertFor)) {
            return { data: null, error: { message: "new row violates a check" } };
          }
          clientRows.push(...list);
          return { data: null, error: null };
        }
        if (table === "properties" && op === "insert") {
          propertyRows.push(...(Array.isArray(payload) ? payload : [payload]));
          return { data: null, error: null };
        }
        return { data: [], error: null };
      };
      const q: any = {
        select: () => q,
        order: () => q,
        range: (a: number) => {
          from = a;
          return q;
        },
        limit: () => q,
        in: () => q,
        not: () => q,
        like: () => q,
        update: (v: unknown) => {
          op = "update";
          payload = v;
          return q;
        },
        insert: (v: unknown) => {
          op = "insert";
          payload = v;
          return q;
        },
        single: () => run(),
        maybeSingle: () => run(),
        then: (res: any, rej: any) => run().then(res, rej),
      };
      for (const o of ["eq", "neq", "is", "gte"]) {
        q[o] = (k: string, v: unknown) => {
          filters.push([o, k, v]);
          return q;
        };
      }
      return q;
    },
  };
}

beforeEach(() => {
  batch = {
    id: "batch",
    organization_id: "org",
    source: "jobber",
    entity: "clients",
    status: "previewing",
    created_at: new Date().toISOString(),
    content_hash: "hash",
    commit_started_at: null,
    superseded_by: null,
    stats: { total: N },
  };
  requests = [];
  clientRows = [];
  propertyRows = [];
  rowUpdates = [];
  failInsertFor = null;
  zonesFail = false;
  maxInFlight = 0;
  inFlight = 0;
  geocodeCalls.length = 0;
  vi.mocked(geocodeAddresses).mockClear();
});

const commit = () =>
  (commitImport as unknown as (i: unknown) => Promise<Record<string, number>>)({
    data: { batchId: "batch" },
    context: { userId: "owner", supabase: backend() },
  });

describe("a 1,000-row client import", () => {
  it("finishes in seconds, not twenty minutes", async () => {
    const started = Date.now();
    const stats = await commit();
    const took = Date.now() - started;
    expect(stats).toMatchObject({ created: 999, skipped: 1, failed: 0, updated: 0 });
    expect(clientRows).toHaveLength(999);
    expect(propertyRows).toHaveLength(999);
    expect(new Set(clientRows.map((c) => c.id)).size).toBe(999);
    // The old shape: about five requests per row, one at a time.
    expect(requests.length).toBeLessThan(N * 1.2);
    expect(took).toBeLessThan(5_000);
  });

  it("writes clients and properties a chunk at a time, and reads zones once", async () => {
    await commit();
    const inserts = requests.filter((r) => r.op === "insert");
    expect(inserts.filter((r) => r.table === "clients").map((r) => r.size)).toEqual([200, 200, 200, 200, 199]);
    expect(inserts.filter((r) => r.table === "properties").map((r) => r.size)).toEqual([200, 200, 200, 200, 199]);
    expect(requests.filter((r) => r.table === "zones")).toHaveLength(1);
    expect(maxInFlight).toBe(20);
  });

  it("points every row at the client it made, and the duplicate at the first", async () => {
    await commit();
    const byRow = new Map(rowUpdates.map((u) => [u.id, u]));
    const first = byRow.get("row-0")!;
    expect(first.target_id).toBe(clientRows[0].id);
    expect(byRow.get("row-999")).toMatchObject({ action: "skip", target_id: first.target_id });
    // The property belongs to the client the row made, with its pin when the
    // geocoder found one.
    expect(propertyRows[1]).toMatchObject({ client_id: clientRows[1].id, latitude: 41.9 });
    expect(propertyRows[0]).toMatchObject({ client_id: clientRows[0].id, latitude: null });
  });

  it("geocodes once, on a budget, and never row by row", async () => {
    await commit();
    expect(geocodeAddresses).toHaveBeenCalledTimes(1);
    expect(geocodeCalls).toEqual([{ n: N, budget: 60_000 }]);
  });

  it("a row that cannot go in fails alone, and its duplicate with it", async () => {
    failInsertFor = "Client 0";
    const stats = await commit();
    expect(stats).toMatchObject({ created: 998, failed: 2, skipped: 0 });
    expect(clientRows.some((c) => c.display_name === "Client 0")).toBe(false);
    expect(clientRows.some((c) => c.display_name === "Client 1")).toBe(true);
    const failedRows = rowUpdates.filter((u) => u.action === "error").map((u) => u.id);
    expect(failedRows.sort()).toEqual(["row-0", "row-999"]);
  });

  it("a zone read that fails is said, not taken for 'no zones'", async () => {
    zonesFail = true;
    const stats = await commit();
    // Asked twice, then the import goes on without zones and says so.
    expect(requests.filter((r) => r.table === "zones")).toHaveLength(2);
    expect(stats).toMatchObject({ created: 999, zone_lookup_failed: true, unzoned: 999 });
    expect((batch.stats as Record<string, unknown>).zone_lookup_failed).toBe(true);
    expect(propertyRows.every((p) => p.zone_id === null)).toBe(true);
  });

  it("a business with no zones is told its properties have none, without a failure", async () => {
    const stats = await commit();
    expect(stats).toMatchObject({ unzoned: 999, unpinned: 500 });
    expect(stats).not.toHaveProperty("zone_lookup_failed");
  });

  it("every client it writes carries the batch, so a crashed import cannot be committed twice", async () => {
    // retryRefusal refuses a re-run once any client with this
    // import_batch_id exists; the chunked insert must still set it.
    await commit();
    expect(clientRows.every((c) => c.import_batch_id === "batch")).toBe(true);
  });
});
