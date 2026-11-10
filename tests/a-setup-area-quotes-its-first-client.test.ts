// A setup area quotes its first client.
//
// Onboarding audit, 2026-11-09 (D1, blocker), confirmed again by Product the
// same afternoon: an owner finishes Setup step 2, "Your service area and
// price", with a 10-mile circle around Detroit, goes straight to Add client,
// types a 48226 address, and the Plan step says
//
//     No zone matches ZIP 48226. Set price manually below.
//
// and /zones says of the area it just made "No ZIPs listed, so the signup page
// and lead form can't quote this area."
//
// Two faults, both fixed and both pinned here:
//
//   1. Setup created a radius zone with no ZIPs. The Zones drawer fills a
//      drawn shape's ZIPs (zone-zip-fill.ts); setup never asked. createZone
//      now does the same fill when asked (`fillZipsFromShape`), on the
//      server, before the row is written -- and setup asks.
//   2. The Plan step quoted by ZIP alone. The wizard had the address's pin and
//      did not send it, and a ZIP with no pin never reached a drawn shape. The
//      quote now carries the pin, and with no pin it places the ZIP at its
//      Census center (the same centers the fill uses) and asks the matcher
//      again -- so a circle that lists no ZIPs still quotes an address in it.
//
// Nothing here depends on what the business runs: a dog walker's area fills
// and quotes exactly like a scooper's.
//
// The handlers run against fakes; the ZIP centers are the real Census rows,
// read straight out of the data migration.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (data: unknown) => unknown = (data) => data;
    const builder = {
      middleware: () => builder,
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return builder;
      },
      handler:
        (fn: (args: { data: unknown; context: unknown }) => unknown) =>
        async (args?: { data: unknown }) =>
          fn({ data: validate(args?.data), context: { supabase: state.db, userId: "user-1" } }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/authz.server", () => ({
  resolveCaller: async () => ({ orgId: "org-1", role: "owner" }),
  requirePermission: async () => ({ orgId: "org-1", role: "owner" }),
}));
vi.mock("@/lib/zones-redetect.server", () => ({ redetectZonesForOrg: async () => 0 }));

const ROOT = join(import.meta.dirname, "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

type Centroid = { zip: string; lat: number; lng: number; radiusM: number };
const CENSUS: Centroid[] = (() => {
  const sql = read("supabase/migrations/20261001120100_the-zip-centers-a-zone-is-filled-from.sql");
  const body = sql.slice(sql.indexOf("$zcta$") + 6, sql.lastIndexOf("$zcta$"));
  return body
    .trim()
    .split("\n")
    .map((l) => {
      const [zip, lat, lng, r] = l.split(",");
      return { zip, lat: Number(lat), lng: Number(lng), radiusM: Number(r) };
    });
})();
const center = (zip: string) => {
  const c = CENSUS.find((x) => x.zip === zip)!;
  return { lat: c.lat, lng: c.lng };
};

const DETROIT = center("48226");
const TEN_MILES_M = Math.round(10 * 1609.344);

/** What the browser's own key can reach, for the calls these paths make. */
function fakeDb(opts: { zones?: Record<string, unknown>[]; rpcFails?: boolean } = {}) {
  const inserted: Record<string, unknown>[] = [];
  const rpcCalls: Array<{ name: string; args: any }> = [];
  const tablesRead: string[] = [];
  const result = (data: unknown) => ({ data, error: null });
  const db = {
    inserted,
    rpcCalls,
    tablesRead,
    rpc: async (name: string, args: any) => {
      rpcCalls.push({ name, args });
      if (name !== "zip_centroids_in_box") throw new Error(`unexpected rpc ${name}`);
      if (opts.rpcFails) return { data: null, error: { message: "boom" } };
      const rows = CENSUS.filter(
        (c) =>
          c.lat >= args._south &&
          c.lat <= args._north &&
          c.lng >= args._west &&
          c.lng <= args._east,
      )
        .slice(0, args._limit)
        .map((c) => ({ zip: c.zip, lat: c.lat, lng: c.lng, radius_m: c.radiusM }));
      return result(rows);
    },
    from: (table: string) => {
      tablesRead.push(table);
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        insert: (row: Record<string, unknown>) => {
          inserted.push(row);
          return chain;
        },
        single: async () =>
          table === "organizations"
            ? result({ currency: "usd", frequency_multipliers: null })
            : result({ id: "zone-new" }),
        then: (resolve: (v: unknown) => unknown) =>
          resolve(result(table === "zones" ? (opts.zones ?? []) : [])),
      };
      return chain;
    },
  };
  return db;
}

const state = vi.hoisted(() => ({ db: null as any }));

const { createZone } = await import("@/lib/zones.functions");
const { internalQuote } = await import("@/lib/internal-quote.server");

/** Exactly what Setup step 2 sends, for a 10-mile circle on downtown Detroit. */
const setupZone = (extra: Record<string, unknown> = {}) => ({
  name: "Main service area",
  geoMatchMode: "radius",
  centerLatitude: DETROIT.lat,
  centerLongitude: DETROIT.lng,
  radiusMeters: TEN_MILES_M,
  basePriceCents: 2000,
  perDogAddlCents: 0,
  ...extra,
});

/** The zone row setup leaves behind, as the quote reads it. */
const radiusZone = (zipCodes: string[]) => ({
  id: "zone-1",
  name: "Main service area",
  priority: 0,
  account_type: null,
  postal_prefix: null,
  zip_codes: zipCodes,
  base_price_cents: 2000,
  per_dog_addl_cents: 0,
  initial_cleanup_cents: 0,
  pricing_mode: "flat",
  geo_match_mode: "radius",
  boundary: null,
  center_latitude: DETROIT.lat,
  center_longitude: DETROIT.lng,
  radius_meters: TEN_MILES_M,
  drive_time_minutes: null,
  enabled: true,
});

const quote = (extra: Record<string, unknown> = {}) => ({
  postalCode: "48226",
  accountType: "residential" as const,
  dogCount: 1,
  frequency: "weekly" as const,
  ...extra,
});

beforeEach(() => {
  state.db = fakeDb();
});

describe("setup's area is written with the ZIPs it holds", () => {
  it("a 10-mile circle on Detroit is saved listing 48226 and its neighbours", async () => {
    await createZone({ data: setupZone({ fillZipsFromShape: true }) } as any);
    const row = state.db.inserted[0];
    const zips = row.zip_codes as string[];
    expect(zips.length).toBeGreaterThan(10);
    expect(zips).toContain("48226");
    expect(zips).toContain("48201");
    // Inside means inside: nothing from New York.
    expect(zips).not.toContain("10001");
  });

  it("the same fill as the Zones drawer, not a second notion of inside", async () => {
    const { classifyZipCentroids } = await import("@/lib/zone-zip-fill");
    await createZone({ data: setupZone({ fillZipsFromShape: true }) } as any);
    const expected = classifyZipCentroids(
      {
        mode: "radius",
        centerLat: DETROIT.lat,
        centerLng: DETROIT.lng,
        radiusMeters: TEN_MILES_M,
      },
      CENSUS,
    ).inside;
    expect([...(state.db.inserted[0].zip_codes as string[])].sort()).toEqual([...expected].sort());
  });

  it("ZIPs the caller typed are kept alongside the fill", async () => {
    await createZone({ data: setupZone({ fillZipsFromShape: true, zipCodes: ["48001"] }) } as any);
    const zips = state.db.inserted[0].zip_codes as string[];
    expect(zips).toContain("48001");
    expect(zips).toContain("48226");
  });

  it("without the ask, a drawn zone is written as drawn (the drawer decides its own chips)", async () => {
    await createZone({ data: setupZone() } as any);
    expect(state.db.inserted[0].zip_codes).toEqual([]);
    expect(state.db.rpcCalls).toHaveLength(0);
  });

  it("a lookup that fails still saves the area; the quote's fallback covers it", async () => {
    state.db = fakeDb({ rpcFails: true });
    const out = await createZone({ data: setupZone({ fillZipsFromShape: true }) } as any);
    expect(out.id).toBe("zone-new");
    expect(state.db.inserted[0].zip_codes).toEqual([]);
  });

  it("Setup step 2 asks for the fill", () => {
    const src = read("src/routes/_authenticated/setup.tsx");
    // `await createFn({` since #795: the setup save also adopts the price
    // after the zone is made, so the call is no longer the return value.
    const at = src.indexOf("createFn({");
    expect(at, "setup.tsx no longer calls createFn").toBeGreaterThan(-1);
    const call = src.slice(at, at + 600);
    expect(call).toMatch(/geoMatchMode: "radius"/);
    expect(call).toMatch(/fillZipsFromShape: true/);
  });
});

describe("the first client's Plan step finds the area", () => {
  it("D1 as found: a 48226 address, a zone setup made with no ZIPs, no pin -- quoted", async () => {
    state.db = fakeDb({ zones: [radiusZone([])] });
    const q = await internalQuote(state.db, "org-1", quote());
    expect(q.available).toBe(true);
    if (q.available) {
      expect(q.quote.zoneId).toBe("zone-1");
      expect(q.quote.recurringPriceCents).toBeGreaterThan(0);
    }
  });

  it("with the address's pin inside the circle, quoted without any lookup", async () => {
    state.db = fakeDb({ zones: [radiusZone([])] });
    const q = await internalQuote(
      state.db,
      "org-1",
      quote({ latitude: 42.335, longitude: -83.05 }),
    );
    expect(q.available).toBe(true);
    expect(state.db.rpcCalls).toHaveLength(0);
  });

  it("after setup's fill, quoted by ZIP alone, with no lookup", async () => {
    state.db = fakeDb({ zones: [radiusZone(["48226", "48201"])] });
    const q = await internalQuote(state.db, "org-1", quote());
    expect(q.available).toBe(true);
    expect(state.db.rpcCalls).toHaveLength(0);
  });

  it("a ZIP outside the circle is still not quoted", async () => {
    state.db = fakeDb({ zones: [radiusZone([])] });
    const q = await internalQuote(state.db, "org-1", quote({ postalCode: "10001" }));
    expect(q.available).toBe(false);
  });

  it("a pin outside the circle is believed over the ZIP", async () => {
    state.db = fakeDb({ zones: [radiusZone([])] });
    const nyc = center("10001");
    const q = await internalQuote(
      state.db,
      "org-1",
      quote({ latitude: nyc.lat, longitude: nyc.lng }),
    );
    expect(q.available).toBe(false);
  });

  it("a turned-off zone does not quote through the fallback either", async () => {
    state.db = fakeDb({ zones: [{ ...radiusZone([]), enabled: false }] });
    const q = await internalQuote(state.db, "org-1", quote());
    expect(q.available).toBe(false);
    expect(state.db.rpcCalls).toHaveLength(0);
  });

  it("neither path asks what the business runs: a walker's area works the same", async () => {
    await createZone({ data: setupZone({ fillZipsFromShape: true }) } as any);
    state.db = fakeDb({ zones: [radiusZone([])] });
    await internalQuote(state.db, "org-1", quote());
    expect(state.db.tablesRead).not.toContain("services");
    for (const src of [
      read("src/lib/zone-zip-fill.server.ts"),
      read("src/lib/internal-quote.server.ts"),
    ]) {
      expect(src).not.toMatch(/service_lines|petWaste|pet_waste/);
    }
  });

  it("the wizard sends the address's pin with the quote", () => {
    const src = read("src/routes/_authenticated/clients.new.tsx");
    const start = src.indexOf("const quoteKey = useMemo(");
    const key = src.slice(start, src.indexOf("const quoteQ =", start));
    expect(key).toMatch(/latitude: geo\?\.lat/);
    expect(key).toMatch(/longitude: geo\?\.lng/);
  });
});
