// A service area fills its ZIPs on save (#858, part 1).
//
// Brendan, 2026-11-10: "Yes, and have it auto fill". Until this, the only
// save that filled a drawn area's ZIPs on the server was Setup step 2's
// (#778, `fillZipsFromShape`); the Zones drawer filled in the browser as the
// shape moved, and any other client -- the native apps, a script, a lookup
// that failed mid-edit -- saved an area listing nothing. The fourth empty
// area in the #822 inventory (org dafc2d33, a 1609 m circle) had no ZIP
// center inside it at all, so no fill could ever have given it one.
//
// Now createZone and updateZone fill from the shape as it is written:
//   * every ZIP whose Census center is inside, the drawer's own rule;
//   * failing that, the ZIP the shape's middle sits in, so a one-mile circle
//     in a city lists the one ZIP it is in rather than nothing;
//   * ZIPs the caller typed are kept, chips the owner removed are not put
//     back, and editing the shape refills;
//   * a lookup that fails still saves, marks the area pending, and the next
//     read of the zone list runs the fill again.
//
// The handlers run against a fake database; the ZIP centers are the real
// Census rows, read out of the data migration.

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
  resolveCaller: async () => ({ orgId: "org-1", role: state.role }),
  requirePermission: async () => ({ orgId: "org-1", role: state.role }),
}));
vi.mock("@/lib/zones-redetect.server", () => ({
  redetectZonesForOrg: async () => {
    state.redetects++;
    return 0;
  },
}));
vi.mock("@/lib/supabase-paging.server", () => ({ fetchAllPages: async () => [] }));

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
const ONE_MILE_M = 1609;
const ZONE_1 = "00000000-0000-4000-8000-000000000001";

/** The zones table and the one RPC these paths use. Every filter is kept so
 *  a read scoped to the wrong business or the wrong row would show. */
function fakeDb(opts: { zones?: Record<string, any>[]; rpcFails?: boolean } = {}) {
  const rows: Record<string, any>[] = (opts.zones ?? []).map((z) => ({ ...z }));
  const inserted: Record<string, any>[] = [];
  const updates: Array<{ id: string | null; org: string | null; patch: Record<string, any> }> =
    [];
  const rpcCalls: Array<{ name: string; args: any }> = [];
  const result = (data: unknown) => ({ data, error: null });
  const db = {
    rows,
    inserted,
    updates,
    rpcCalls,
    rpc: async (name: string, args: any) => {
      rpcCalls.push({ name, args });
      if (name === "reorder_zones") {
        // The migration's one-statement reorder: top of the list gets N.
        const ids: string[] = args._ids;
        ids.forEach((id, i) => {
          const r = rows.find((x) => x.id === id);
          if (r) r.priority = ids.length - i;
        });
        return result(ids.length);
      }
      if (name !== "zip_centroids_in_box") throw new Error(`unexpected rpc ${name}`);
      if (opts.rpcFails) return { data: null, error: { message: "boom" } };
      const found = CENSUS.filter(
        (c) =>
          c.lat >= args._south &&
          c.lat <= args._north &&
          c.lng >= args._west &&
          c.lng <= args._east,
      )
        .slice(0, args._limit)
        .map((c) => ({ zip: c.zip, lat: c.lat, lng: c.lng, radius_m: c.radiusM }));
      return result(found);
    },
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      let patch: Record<string, any> | null = null;
      let insert: Record<string, any> | null = null;
      const matching = () =>
        table === "zones"
          ? rows.filter((r) => filters.every(([k, v]) => r[k] === v))
          : ([] as Record<string, any>[]);
      const finish = () => {
        if (insert) {
          inserted.push(insert);
          return result({ id: "zone-new" });
        }
        if (patch) {
          const id = (filters.find(([k]) => k === "id")?.[1] as string) ?? null;
          const org = (filters.find(([k]) => k === "organization_id")?.[1] as string) ?? null;
          updates.push({ id, org, patch });
          for (const r of matching()) Object.assign(r, patch);
          return result(null);
        }
        return result(matching());
      };
      const chain: any = {
        select: () => chain,
        eq: (k: string, v: unknown) => {
          filters.push([k, v]);
          return chain;
        },
        order: () => chain,
        insert: (row: Record<string, any>) => {
          insert = row;
          return chain;
        },
        update: (p: Record<string, any>) => {
          patch = p;
          return chain;
        },
        single: async () => {
          const r = finish();
          return Array.isArray(r.data) ? result(r.data[0] ?? null) : r;
        },
        maybeSingle: async () => {
          const r = finish();
          return Array.isArray(r.data) ? result(r.data[0] ?? null) : r;
        },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(finish()).then(resolve, reject),
      };
      return chain;
    },
  };
  return db;
}

const state = vi.hoisted(() => ({ db: null as any, redetects: 0, role: "owner" as string }));

const { createZone, updateZone, listZones } = await import("@/lib/zones.functions");

/** The Zones drawer's save for a 10-mile circle on downtown Detroit. No
 *  `fillZipsFromShape`: the drawer never sent it. */
const drawnCircle = (extra: Record<string, unknown> = {}) => ({
  name: "Detroit core",
  geoMatchMode: "radius",
  centerLatitude: DETROIT.lat,
  centerLongitude: DETROIT.lng,
  radiusMeters: TEN_MILES_M,
  basePriceCents: 2000,
  perDogAddlCents: 0,
  ...extra,
});

const savedZone = (over: Record<string, unknown> = {}) => ({
  id: ZONE_1,
  organization_id: "org-1",
  name: "Detroit core",
  priority: 1,
  zip_codes: [] as string[],
  zip_fill_pending_since: null as string | null,
  zip_fill_last_tried_at: null as string | null,
  postal_prefix: null,
  pricing_mode: "flat",
  area_max_charge_cents: null,
  geo_match_mode: "radius",
  boundary: null,
  center_latitude: DETROIT.lat,
  center_longitude: DETROIT.lng,
  radius_meters: TEN_MILES_M,
  drive_time_minutes: null,
  enabled: true,
  ...over,
});

/** A spot in Detroit with no ZIP center within a mile of it, found rather
 *  than assumed: the first point stepping north-east from 48226's center
 *  whose one-mile circle the fill puts no ZIP inside. */
const LONELY_MILE: { lat: number; lng: number } = await (async () => {
  const { classifyZipCentroids } = await import("@/lib/zone-zip-fill");
  for (let i = 1; i < 200; i++) {
    const lat = DETROIT.lat + i * 0.004;
    const lng = DETROIT.lng + i * 0.003;
    const shape = { mode: "radius", centerLat: lat, centerLng: lng, radiusMeters: ONE_MILE_M };
    if (classifyZipCentroids(shape, CENSUS).inside.length === 0) return { lat, lng };
  }
  throw new Error("no lonely mile found near Detroit");
})();

beforeEach(() => {
  state.db = fakeDb();
  state.redetects = 0;
  state.role = "owner";
});

describe("a drawn area lists its ZIPs the moment it is saved", () => {
  it("the drawer's own save fills a 10-mile circle, with no flag asked for", async () => {
    const out = await createZone({ data: drawnCircle() } as any);
    const row = state.db.inserted[0];
    expect(row.zip_codes).toContain("48226");
    expect(row.zip_codes).toContain("48201");
    expect(row.zip_codes).not.toContain("10001");
    expect(row.zip_fill_pending_since).toBeNull();
    expect(out.zipsFilled).toBe(row.zip_codes.length);
    expect(out.zipFillPending).toBe(false);
    expect(out.zipAtCenterOnly).toBe(false);
  });

  it("is the drawer's own notion of inside: classifyZipCentroids over the same centers", async () => {
    const { classifyZipCentroids } = await import("@/lib/zone-zip-fill");
    await createZone({ data: drawnCircle() } as any);
    const expected = classifyZipCentroids(
      { mode: "radius", centerLat: DETROIT.lat, centerLng: DETROIT.lng, radiusMeters: TEN_MILES_M },
      CENSUS,
    ).inside;
    expect([...state.db.inserted[0].zip_codes].sort()).toEqual([...expected].sort());
  });

  it("a polygon fills the same way", async () => {
    const d = 0.05;
    const ring = [
      [DETROIT.lng - d, DETROIT.lat - d],
      [DETROIT.lng + d, DETROIT.lat - d],
      [DETROIT.lng + d, DETROIT.lat + d],
      [DETROIT.lng - d, DETROIT.lat + d],
      [DETROIT.lng - d, DETROIT.lat - d],
    ];
    await createZone({
      data: {
        name: "Downtown square",
        geoMatchMode: "polygon",
        boundary: { type: "Polygon", coordinates: [ring] },
      },
    } as any);
    expect(state.db.inserted[0].zip_codes).toContain("48226");
  });

  it("ZIPs the owner typed are kept beside the fill", async () => {
    await createZone({ data: drawnCircle({ zipCodes: ["48001"] }) } as any);
    const zips = state.db.inserted[0].zip_codes as string[];
    expect(zips[0]).toBe("48001");
    expect(zips).toContain("48226");
  });

  it("a chip the owner removed is not put back", async () => {
    const out = await createZone({ data: drawnCircle({ zipCodesRemoved: ["48226"] }) } as any);
    const zips = state.db.inserted[0].zip_codes as string[];
    expect(zips).not.toContain("48226");
    expect(zips).toContain("48201");
    expect(out.zipsFilled).toBe(zips.length);
  });

  it("the #822 case: a one-mile circle with no ZIP center inside lists the ZIP it sits in", async () => {
    const { nearestZipToMiddle } = await import("@/lib/zone-zip-fill");
    const out = await createZone({
      data: drawnCircle({
        name: "Small circle",
        centerLatitude: LONELY_MILE.lat,
        centerLongitude: LONELY_MILE.lng,
        radiusMeters: ONE_MILE_M,
      }),
    } as any);
    const zips = state.db.inserted[0].zip_codes as string[];
    expect(zips).toHaveLength(1);
    expect(zips[0]).toBe(
      nearestZipToMiddle(
        { mode: "radius", centerLat: LONELY_MILE.lat, centerLng: LONELY_MILE.lng, radiusMeters: ONE_MILE_M },
        CENSUS,
      ),
    );
    expect(out.zipAtCenterOnly).toBe(true);
    // And it is a Detroit ZIP, not the nearest one anywhere.
    expect(zips[0].startsWith("48")).toBe(true);
  });

  it("a ZIP-list zone with no shape is written as sent, with no lookup", async () => {
    await createZone({
      data: { name: "List only", geoMatchMode: "radius", zipCodes: ["48226"] },
    } as any).catch(() => {});
    // Coverage is required, so that one was refused; the fill never ran.
    expect(state.db.rpcCalls).toHaveLength(0);
  });

  it("nothing here asks what the business runs", () => {
    for (const f of ["src/lib/zone-zip-fill.server.ts", "src/lib/zone-zip-fill.ts"]) {
      expect(read(f)).not.toMatch(/service_lines|petWaste|pet_waste/);
    }
  });
});

describe("a lookup that fails saves the area and marks the fill pending", () => {
  it("createZone: saved as sent, pending set, said in the result", async () => {
    state.db = fakeDb({ rpcFails: true });
    const out = await createZone({ data: drawnCircle({ zipCodes: ["48001"] }) } as any);
    expect(out.id).toBe("zone-new");
    const row = state.db.inserted[0];
    expect(row.zip_codes).toEqual(["48001"]);
    expect(typeof row.zip_fill_pending_since).toBe("string");
    expect(out.zipFillPending).toBe(true);
  });

  it("listZones retries the fill, writes it, clears the mark and re-detects", async () => {
    state.db = fakeDb({
      zones: [savedZone({ zip_fill_pending_since: "2026-11-11T20:00:00Z" })],
    });
    const out = await listZones();
    const mine = state.db.updates.filter((u: any) => u.id === ZONE_1);
    // The attempt is stamped first, then the fill is written.
    expect(mine).toHaveLength(2);
    expect(typeof mine[0].patch.zip_fill_last_tried_at).toBe("string");
    expect(mine[1].org).toBe("org-1");
    expect(mine[1].patch.zip_codes).toContain("48226");
    expect(mine[1].patch.zip_fill_pending_since).toBeNull();
    expect(out.zones[0].zip_codes).toContain("48226");
    expect(out.zones[0].zip_fill_pending_since).toBeNull();
    expect(state.redetects).toBe(1);
  });

  it("a retry that fails again leaves the mark, stamps the attempt, and the list still comes back", async () => {
    state.db = fakeDb({
      zones: [savedZone({ zip_fill_pending_since: "2026-11-11T20:00:00Z" })],
      rpcFails: true,
    });
    const out = await listZones();
    expect(state.db.updates).toHaveLength(1);
    expect(typeof state.db.updates[0].patch.zip_fill_last_tried_at).toBe("string");
    expect(out.zones[0].zip_fill_pending_since).toBe("2026-11-11T20:00:00Z");
    expect(typeof out.zones[0].zip_fill_last_tried_at).toBe("string");
    expect(state.redetects).toBe(0);
  });

  it("not on every read: an area tried in the last ten minutes is left alone", async () => {
    const { ZIP_FILL_RETRY_MS, zipFillRetryDue } = await import("@/lib/zones.functions");
    const justTried = new Date(Date.now() - 60_000).toISOString();
    state.db = fakeDb({
      zones: [savedZone({ zip_fill_pending_since: "2026-11-11T20:00:00Z", zip_fill_last_tried_at: justTried })],
    });
    await listZones();
    expect(state.db.rpcCalls).toHaveLength(0);
    expect(state.db.updates).toHaveLength(0);
    // And one tried longer ago than the window is due again.
    const longAgo = new Date(Date.now() - ZIP_FILL_RETRY_MS - 1000).toISOString();
    expect(zipFillRetryDue({ zip_fill_pending_since: "x", zip_fill_last_tried_at: longAgo })).toBe(true);
    expect(zipFillRetryDue({ zip_fill_pending_since: "x", zip_fill_last_tried_at: justTried })).toBe(false);
    expect(zipFillRetryDue({ zip_fill_pending_since: null, zip_fill_last_tried_at: null })).toBe(false);
    expect(ZIP_FILL_RETRY_MS).toBe(10 * 60 * 1000);
  });

  it("a reader who may not edit zones never looks anything up", async () => {
    state.role = "tech";
    state.db = fakeDb({
      zones: [savedZone({ zip_fill_pending_since: "2026-11-11T20:00:00Z" })],
    });
    const out = await listZones();
    expect(state.db.rpcCalls).toHaveLength(0);
    expect(state.db.updates).toHaveLength(0);
    expect(out.zones[0].zip_fill_pending_since).toBe("2026-11-11T20:00:00Z");
  });

  it("an area that is not pending is not looked up by the list", async () => {
    state.db = fakeDb({ zones: [savedZone({ zip_codes: ["48226"] })] });
    await listZones();
    expect(state.db.rpcCalls).toHaveLength(0);
  });
});

describe("editing the shape refills", () => {
  it("a moved circle adds the ZIPs the new shape holds and keeps what the owner typed", async () => {
    state.db = fakeDb({ zones: [savedZone({ zip_codes: ["48001"] })] });
    const out = await updateZone({
      data: {
        id: ZONE_1,
        zipCodes: ["48001"],
        geoMatchMode: "radius",
        centerLatitude: DETROIT.lat,
        centerLongitude: DETROIT.lng,
        radiusMeters: TEN_MILES_M,
      },
    } as any);
    const u = state.db.updates.find((x: any) => x.id === ZONE_1);
    expect(u.patch.zip_codes).toContain("48001");
    expect(u.patch.zip_codes).toContain("48226");
    expect(u.patch.zip_fill_pending_since).toBeNull();
    expect(out.zipFillPending).toBe(false);
  });

  it("a chip removed during the edit stays out", async () => {
    state.db = fakeDb({ zones: [savedZone({ zip_codes: ["48201"] })] });
    await updateZone({
      data: {
        id: ZONE_1,
        zipCodes: ["48201"],
        zipCodesRemoved: ["48226"],
        radiusMeters: TEN_MILES_M + 10,
      },
    } as any);
    const u = state.db.updates.find((x: any) => x.id === ZONE_1);
    expect(u.patch.zip_codes).not.toContain("48226");
    expect(u.patch.zip_codes).toContain("48201");
  });

  it("a price edit that leaves the shape alone does not look anything up", async () => {
    state.db = fakeDb({ zones: [savedZone({ zip_codes: ["48226"] })] });
    await updateZone({ data: { id: ZONE_1, basePriceCents: 3000 } } as any);
    expect(state.db.rpcCalls).toHaveLength(0);
    const u = state.db.updates.find((x: any) => x.id === ZONE_1);
    expect(u.patch.zip_codes).toBeUndefined();
  });

  it("an area still listing nothing is filled on any save, shape change or not", async () => {
    state.db = fakeDb({ zones: [savedZone({ zip_codes: [] })] });
    await updateZone({ data: { id: ZONE_1, basePriceCents: 3000 } } as any);
    const u = state.db.updates.find((x: any) => x.id === ZONE_1);
    expect(u.patch.zip_codes).toContain("48226");
  });

  it("a pending area is filled on its next save too", async () => {
    state.db = fakeDb({
      zones: [savedZone({ zip_codes: ["48001"], zip_fill_pending_since: "2026-11-11T20:00:00Z" })],
    });
    await updateZone({ data: { id: ZONE_1, name: "Renamed" } } as any);
    const u = state.db.updates.find((x: any) => x.id === ZONE_1);
    expect(u.patch.zip_codes).toContain("48226");
    expect(u.patch.zip_fill_pending_since).toBeNull();
  });

  it("a shape edit whose lookup fails keeps the list sent and marks it pending", async () => {
    state.db = fakeDb({ zones: [savedZone({ zip_codes: ["48226"] })], rpcFails: true });
    const out = await updateZone({
      data: { id: ZONE_1, zipCodes: ["48226"], radiusMeters: TEN_MILES_M + 10 },
    } as any);
    const u = state.db.updates.find((x: any) => x.id === ZONE_1);
    expect(u.patch.zip_codes).toEqual(["48226"]);
    expect(typeof u.patch.zip_fill_pending_since).toBe("string");
    expect(out.zipFillPending).toBe(true);
  });
});

describe("a new area goes to the bottom of the ranking", () => {
  it("under every area the business has", async () => {
    state.db = fakeDb({
      zones: [savedZone({ id: "a", priority: 3 }), savedZone({ id: "b", priority: 1 })],
    });
    await createZone({ data: drawnCircle() } as any);
    expect(state.db.inserted[0].priority).toBe(0);
  });

  it("the first area is 0; the next under a 0 is -1", async () => {
    await createZone({ data: drawnCircle() } as any);
    expect(state.db.inserted[0].priority).toBe(0);
    state.db = fakeDb({ zones: [savedZone({ id: "a", priority: 0 })] });
    await createZone({ data: drawnCircle() } as any);
    expect(state.db.inserted[0].priority).toBe(-1);
  });

  it("a caller that places the area is honoured (setup's first area, an import)", async () => {
    state.db = fakeDb({ zones: [savedZone({ id: "a", priority: 3 })] });
    await createZone({ data: drawnCircle({ priority: 7 }) } as any);
    expect(state.db.inserted[0].priority).toBe(7);
  });

  it("at the floor, the business is renumbered first, in one statement, and the new area goes under it", async () => {
    state.db = fakeDb({
      zones: [savedZone({ id: "a", priority: -998 }), savedZone({ id: "b", priority: -999 })],
    });
    await createZone({ data: drawnCircle() } as any);
    expect(state.db.inserted[0].priority).toBe(0);
    expect(state.db.rpcCalls.filter((c: any) => c.name === "reorder_zones")).toEqual([
      { name: "reorder_zones", args: { _org_id: "org-1", _ids: ["a", "b"] } },
    ]);
    expect(state.db.rows.find((r: any) => r.id === "a").priority).toBe(2);
    expect(state.db.rows.find((r: any) => r.id === "b").priority).toBe(1);
  });
});

describe("the drawer and setup", () => {
  const drawer = read("src/components/ZoneDrawer.tsx");

  it("the drawer no longer types a priority and sends the chips it removed", () => {
    expect(drawer).not.toMatch(/id="zone-priority"/);
    expect(drawer).not.toMatch(/priority: parseInt/);
    expect(drawer).toMatch(/zipCodesRemoved: zipState\.dismissed/);
  });

  it("the drawer says where the ranking lives", () => {
    expect(drawer).toMatch(/A new zone starts at the bottom of the ranking/);
  });

  it("setup's flag is still accepted, so the first area saves as before", async () => {
    await createZone({ data: drawnCircle({ fillZipsFromShape: true }) } as any);
    expect(state.db.inserted[0].zip_codes).toContain("48226");
  });
});
