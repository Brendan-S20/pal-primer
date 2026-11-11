// An area saved before setup filled it still quotes (#793).
//
// #778 made Setup step 2 write a new radius zone WITH the ZIPs it holds. Every
// area saved before that -- a pilot's 10-mile circle on Detroit -- still has
// `zip_codes = '{}'`, and public_quote matches a visitor on the signup page by
// ZIP alone (`_zip = ANY(z.zip_codes)` or a prefix), because a form has a ZIP
// and no point. So 48226, the ZIP the circle is centred on, is answered
// "No service in that ZIP code yet."
//
// The fix is data, not a second matcher: fill those zones' lists with the ZIPs
// inside their shape, by the same rule "Fill ZIPs from the area" and #778 use.
// Two ways to run it, both pinned here:
//
//   * fillEmptyZoneZips -- the owner's one click on Zones, in their session;
//   * scripts/backfill/793-zones-with-a-shape-and-no-zips.sql -- a READ-ONLY
//     inventory that prints the same proposal for every tenant. A production
//     run of its UPDATEs needs Brendan's explicit approval; nothing here runs
//     it, and nothing here touches a real organization.
//
// The ZIP centers are the real Census rows, read out of the data migration;
// the zones are fixtures.

import { readdirSync, readFileSync } from "node:fs";
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
  requirePermission: async (_db: unknown, _u: unknown, perm: string) => {
    state.permissionsAsked.push(perm);
    return { orgId: "org-1", role: "owner" };
  },
}));
vi.mock("@/lib/zones-redetect.server", () => ({
  redetectZonesForOrg: async () => {
    state.redetects++;
    return 3;
  },
}));

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

/** A pre-#778 setup area, as it sits in the database today. */
const legacyCircle = (over: Record<string, unknown> = {}) => ({
  id: "zone-legacy",
  name: "Main service area",
  priority: 0,
  account_type: null,
  postal_prefix: null,
  zip_codes: [] as string[],
  geo_match_mode: "radius",
  boundary: null,
  center_latitude: DETROIT.lat,
  center_longitude: DETROIT.lng,
  radius_meters: TEN_MILES_M,
  drive_time_minutes: null,
  enabled: true,
  ...over,
});

/** public_quote's zone pick, as written in the latest migration that defines
 *  it: an exact ZIP first, then a prefix, then priority. No geometry. */
function publicQuoteZone(zones: Array<Record<string, any>>, zip: string) {
  return (
    zones
      .filter(
        (z) =>
          (z.zip_codes ?? []).includes(zip) ||
          (z.postal_prefix != null && zip.startsWith(z.postal_prefix)),
      )
      .sort(
        (a, b) =>
          Number(!(a.zip_codes ?? []).includes(zip)) - Number(!(b.zip_codes ?? []).includes(zip)) ||
          (b.priority ?? 0) - (a.priority ?? 0) ||
          String(a.id).localeCompare(String(b.id)),
      )[0] ?? null
  );
}

const lookupFromCensus = (shape: any) => {
  // What zip_centroids_in_box returns for a shape's search box.
  return import("@/lib/zone-zip-fill").then(({ searchBox }) => {
    const box = searchBox(shape)!;
    return CENSUS.filter(
      (c) => c.lat >= box.south && c.lat <= box.north && c.lng >= box.west && c.lng <= box.east,
    );
  });
};

async function lookupsFor(zones: Array<Record<string, any>>) {
  const { zoneShape } = await import("@/lib/lead-service-area");
  const { zoneNeedsZipBackfill } = await import("@/lib/zone-zip-backfill");
  const out = new Map<string, any>();
  for (const z of zones) {
    if (!zoneNeedsZipBackfill(z as any)) continue;
    out.set(z.id, {
      status: "ok",
      centroids: await lookupFromCensus(zoneShape(z as any)),
      capped: false,
    });
  }
  return out;
}

const state = vi.hoisted(() => ({
  db: null as any,
  permissionsAsked: [] as string[],
  redetects: 0,
}));

/** The caller's own key, for the calls the fill makes. */
function fakeDb(zones: Array<Record<string, any>>, opts: { rpcFails?: boolean } = {}) {
  const rows = zones.map((z) => ({ ...z, zip_codes: [...(z.zip_codes ?? [])] }));
  const updates: Array<{ id: string; org: string; patch: any; guard: [string, string, string] }> =
    [];
  const rpcCalls: Array<{ name: string; args: any }> = [];
  const db = {
    rows,
    updates,
    rpcCalls,
    rpc: async (name: string, args: any) => {
      rpcCalls.push({ name, args });
      if (name !== "zip_centroids_in_box") throw new Error(`unexpected rpc ${name}`);
      if (opts.rpcFails) return { data: null, error: { message: "boom" } };
      const data = CENSUS.filter(
        (c) =>
          c.lat >= args._south &&
          c.lat <= args._north &&
          c.lng >= args._west &&
          c.lng <= args._east,
      )
        .slice(0, args._limit)
        .map((c) => ({ zip: c.zip, lat: c.lat, lng: c.lng, radius_m: c.radiusM }));
      return { data, error: null };
    },
    from: (table: string) => {
      if (table !== "zones") throw new Error(`unexpected table ${table}`);
      const q: any = { patch: null, eqs: {} as Record<string, string>, guard: null };
      const chain: any = {
        select: () => chain,
        eq: (col: string, v: string) => {
          q.eqs[col] = v;
          return chain;
        },
        update: (patch: any) => {
          q.patch = patch;
          return chain;
        },
        filter: (col: string, op: string, v: string) => {
          q.guard = [col, op, v];
          return chain;
        },
        then: (resolve: (v: unknown) => unknown) => {
          if (!q.patch) return resolve({ data: rows, error: null });
          const row = rows.find((r) => r.id === q.eqs.id && q.eqs.organization_id === "org-1");
          updates.push({
            id: q.eqs.id,
            org: q.eqs.organization_id,
            patch: q.patch,
            guard: q.guard,
          });
          const guardHolds =
            q.guard?.[0] === "zip_codes" && q.guard?.[2] === "{}" && row?.zip_codes.length === 0;
          if (!row || !guardHolds) return resolve({ data: [], error: null });
          row.zip_codes = q.patch.zip_codes;
          return resolve({ data: [{ id: row.id }], error: null });
        },
      };
      return chain;
    },
  };
  return db;
}

beforeEach(() => {
  state.permissionsAsked = [];
  state.redetects = 0;
});

describe("#793 as found: a pre-#778 circle on Detroit quotes nobody on the signup page", () => {
  it("public_quote matches by ZIP or prefix only -- so an empty list is unreachable", () => {
    // The latest definition, so this follows any rewrite of public_quote.
    const dir = join(ROOT, "supabase/migrations");
    const latest = readdirSync(dir)
      .filter((f) => /FUNCTION public\.public_quote\(/i.test(read(`supabase/migrations/${f}`)))
      .sort()
      .pop()!;
    const sql = read(`supabase/migrations/${latest}`);
    const fn = sql.slice(sql.search(/CREATE OR REPLACE FUNCTION public\.public_quote\(/i));
    const at = fn.indexOf("SELECT z.* INTO _zone");
    expect(at, `${latest} no longer picks a zone the way this test reads`).toBeGreaterThan(-1);
    const pick = fn.slice(at, fn.indexOf("LIMIT 1;", at));
    expect(pick).toMatch(/_zip = ANY\(z\.zip_codes\)/);
    expect(pick).toMatch(/postal_prefix/);
    // No point, no radius, no boundary: the visitor has only a ZIP.
    expect(pick).not.toMatch(/radius_meters|center_latitude|boundary/);
  });

  it("48226 inside the circle, empty list: no zone", () => {
    expect(publicQuoteZone([legacyCircle()], "48226")).toBeNull();
  });
});

describe("the plan: the ZIPs inside each empty drawn zone, and nothing it should not take", () => {
  it("a pre-#778 10-mile circle on Detroit is planned with 48226 and its neighbours", async () => {
    const { planZoneZipBackfill } = await import("@/lib/zone-zip-backfill");
    const zones = [legacyCircle()];
    const plan = planZoneZipBackfill(zones as any, await lookupsFor(zones));
    expect(plan.fillCount).toBe(1);
    const e = plan.entries[0];
    expect(e.status).toBe("fill");
    expect(e.zips).toContain("48226");
    expect(e.zips).toContain("48201");
    expect(e.zips).not.toContain("10001");
  });

  it("and after it is written, the signup page's rule quotes 48226 from that zone", async () => {
    const { planZoneZipBackfill } = await import("@/lib/zone-zip-backfill");
    const zones = [legacyCircle()];
    const plan = planZoneZipBackfill(zones as any, await lookupsFor(zones));
    const filled = [{ ...zones[0], zip_codes: plan.entries[0].zips }];
    expect(publicQuoteZone(filled, "48226")?.id).toBe("zone-legacy");
    // Still nothing outside it.
    expect(publicQuoteZone(filled, "10001")).toBeNull();
  });

  it("is exactly #778's fill for the same circle -- one notion of inside", async () => {
    const { planZoneZipBackfill } = await import("@/lib/zone-zip-backfill");
    const { classifyZipCentroids } = await import("@/lib/zone-zip-fill");
    const zones = [legacyCircle()];
    const plan = planZoneZipBackfill(zones as any, await lookupsFor(zones));
    const expected = classifyZipCentroids(
      { mode: "radius", centerLat: DETROIT.lat, centerLng: DETROIT.lng, radiusMeters: TEN_MILES_M },
      CENSUS,
    ).inside;
    expect([...plan.entries[0].zips].sort()).toEqual([...expected].sort());
  });

  it("a drive-time area is filled like a radius one", async () => {
    const { planZoneZipBackfill } = await import("@/lib/zone-zip-backfill");
    const zones = [
      legacyCircle({ geo_match_mode: "drive_time", radius_meters: null, drive_time_minutes: 20 }),
    ];
    const plan = planZoneZipBackfill(zones as any, await lookupsFor(zones));
    expect(plan.entries[0].zips).toContain("48226");
  });

  it("a ZIP another zone already lists stays with that zone", async () => {
    const { planZoneZipBackfill } = await import("@/lib/zone-zip-backfill");
    const zones = [
      legacyCircle(),
      {
        ...legacyCircle(),
        id: "zone-downtown",
        name: "Downtown",
        geo_match_mode: "zip",
        zip_codes: ["48226"],
      },
    ];
    const plan = planZoneZipBackfill(zones as any, await lookupsFor(zones));
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].zips).not.toContain("48226");
    expect(plan.entries[0].claimedElsewhere).toContain("48226");
    // So the zone quoting it today still does after the fill.
    const after = [{ ...zones[0], zip_codes: plan.entries[0].zips }, zones[1]];
    expect(publicQuoteZone(after, "48226")?.id).toBe("zone-downtown");
  });

  it("a ZIP another zone's prefix covers is not stolen by an exact listing", async () => {
    const { planZoneZipBackfill } = await import("@/lib/zone-zip-backfill");
    const zones = [
      legacyCircle(),
      {
        ...legacyCircle(),
        id: "zone-482",
        name: "482xx",
        geo_match_mode: "zip",
        postal_prefix: "482",
      },
    ];
    const plan = planZoneZipBackfill(zones as any, await lookupsFor(zones));
    expect(plan.entries[0].zips.some((z) => z.startsWith("482"))).toBe(false);
    const after = [{ ...zones[0], zip_codes: plan.entries[0].zips }, zones[1]];
    expect(publicQuoteZone(after, "48226")?.id).toBe("zone-482");
  });

  it("a zone that lists even one ZIP, a prefix zone, and a ZIP-only zone are never touched", async () => {
    const { planZoneZipBackfill, zoneNeedsZipBackfill } = await import("@/lib/zone-zip-backfill");
    const zones = [
      legacyCircle({ id: "a", zip_codes: ["48226"] }),
      legacyCircle({ id: "b", postal_prefix: "482" }),
      legacyCircle({ id: "c", geo_match_mode: "zip", center_latitude: null, radius_meters: null }),
      legacyCircle({ id: "d", radius_meters: null }), // half-drawn
    ];
    for (const z of zones) expect(zoneNeedsZipBackfill(z as any)).toBe(false);
    expect(planZoneZipBackfill(zones as any, new Map()).entries).toEqual([]);
  });

  it("two empty circles over the same ZIP: the matcher's pick (priority) gets it, not both", async () => {
    const { planZoneZipBackfill } = await import("@/lib/zone-zip-backfill");
    const zones = [
      legacyCircle({ id: "zone-a", name: "Wide", radius_meters: TEN_MILES_M * 2, priority: 0 }),
      legacyCircle({ id: "zone-b", name: "Core", priority: 5 }),
    ];
    const plan = planZoneZipBackfill(zones as any, await lookupsFor(zones));
    const a = plan.entries.find((e) => e.zoneId === "zone-a")!;
    const b = plan.entries.find((e) => e.zoneId === "zone-b")!;
    expect(b.zips).toContain("48226");
    expect(a.zips).not.toContain("48226");
    expect(a.wonByAnotherArea).toContain("48226");
    // The wide circle keeps what only it holds.
    expect(a.zips.length).toBeGreaterThan(0);
    expect(a.zips.filter((z) => b.zips.includes(z))).toEqual([]);
  });

  it("a turned-off area is filled too, so turning it back on does not bring the gap back", async () => {
    const { planZoneZipBackfill } = await import("@/lib/zone-zip-backfill");
    const zones = [legacyCircle({ enabled: false })];
    const plan = planZoneZipBackfill(zones as any, await lookupsFor(zones));
    expect(plan.entries[0].zips).toContain("48226");
  });

  it("a failed lookup plans nothing and says so", async () => {
    const { planZoneZipBackfill, backfillSummary } = await import("@/lib/zone-zip-backfill");
    const plan = planZoneZipBackfill(
      [legacyCircle()] as any,
      new Map([["zone-legacy", { status: "failed", message: "boom" }]]),
    );
    expect(plan.entries[0]).toMatchObject({ status: "lookup_failed", zips: [] });
    expect(plan.fillCount).toBe(0);
    expect(backfillSummary(plan, [])).toMatch(/Could not look up/);
  });
});

describe("fillEmptyZoneZips: the owner's one click on Zones", () => {
  it("writes 48226 into the legacy circle, guarded on the list still being empty", async () => {
    state.db = fakeDb([legacyCircle()]);
    const { fillEmptyZoneZips } = await import("@/lib/zones.functions");
    const out = await fillEmptyZoneZips({ data: {} } as any);
    expect(state.permissionsAsked).toContain("manage_pricing");
    expect(state.db.rpcCalls[0]).toMatchObject({
      name: "zip_centroids_in_box",
      args: { _org_id: "org-1" },
    });
    expect(state.db.updates).toHaveLength(1);
    expect(state.db.updates[0]).toMatchObject({
      id: "zone-legacy",
      org: "org-1",
      guard: ["zip_codes", "eq", "{}"],
    });
    expect(out.written).toEqual(["zone-legacy"]);
    expect(state.db.rows[0].zip_codes).toContain("48226");
    expect(publicQuoteZone(state.db.rows, "48226")?.id).toBe("zone-legacy");
    // Existing properties re-detected against the new list.
    expect(state.redetects).toBe(1);
    expect(out.summary).toMatch(/^Added \d+ ZIPs to 1 area\.$/);
  });

  it("dryRun plans and writes nothing", async () => {
    state.db = fakeDb([legacyCircle()]);
    const { fillEmptyZoneZips } = await import("@/lib/zones.functions");
    const out = await fillEmptyZoneZips({ data: { dryRun: true } } as any);
    expect(out.plan.entries[0].zips).toContain("48226");
    expect(state.db.updates).toHaveLength(0);
    expect(state.redetects).toBe(0);
  });

  it("a zone the owner filled in another tab keeps what they saved", async () => {
    state.db = fakeDb([legacyCircle()]);
    const { planOrgZoneZipBackfill, applyZoneZipBackfill } =
      await import("@/lib/zone-zip-backfill.server");
    const plan = await planOrgZoneZipBackfill(state.db, "org-1");
    state.db.rows[0].zip_codes = ["48201"]; // saved meanwhile
    const written = await applyZoneZipBackfill(state.db, "org-1", plan);
    expect(written).toEqual([]);
    expect(state.db.rows[0].zip_codes).toEqual(["48201"]);
  });

  it("nothing to fill: no lookup, no write, no redetect", async () => {
    state.db = fakeDb([legacyCircle({ zip_codes: ["48226"] })]);
    const { fillEmptyZoneZips } = await import("@/lib/zones.functions");
    const out = await fillEmptyZoneZips({ data: {} } as any);
    expect(state.db.rpcCalls).toHaveLength(0);
    expect(state.db.updates).toHaveLength(0);
    expect(state.redetects).toBe(0);
    expect(out.summary).toBe("Every area already lists its ZIPs.");
  });

  it("a lookup that fails writes nothing and tells the owner", async () => {
    state.db = fakeDb([legacyCircle()], { rpcFails: true });
    const { fillEmptyZoneZips } = await import("@/lib/zones.functions");
    const out = await fillEmptyZoneZips({ data: {} } as any);
    expect(state.db.updates).toHaveLength(0);
    expect(out.written).toEqual([]);
    expect(out.summary).toMatch(/Could not look up/);
  });

  it("Zones offers it beside the warning it fixes", () => {
    const src = read("src/routes/_authenticated/zones.tsx");
    expect(src).toMatch(/fillEmptyZoneZips/);
    expect(src).toMatch(/zoneNeedsZipBackfill/);
    expect(src).toMatch(/Fill ZIPs for all/);
  });

  it("nothing here asks what the business runs", () => {
    for (const f of ["src/lib/zone-zip-backfill.ts", "src/lib/zone-zip-backfill.server.ts"]) {
      expect(read(f)).not.toMatch(/service_lines|petWaste|pet_waste/);
    }
  });
});

describe("the operator inventory writes nothing", () => {
  const sql = read("scripts/backfill/793-zones-with-a-shape-and-no-zips.sql");
  // Comments out, and every format('...') string: those are proposals, text.
  const code = sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .replace(/format\('(?:[^']|'')*'/g, "format(''");

  it("runs inside a READ ONLY transaction and rolls back", () => {
    expect(code).toMatch(/BEGIN READ ONLY;/);
    expect(code.trim()).toMatch(/ROLLBACK;$/);
  });

  it("executes no write and creates nothing (a READ ONLY transaction refuses CREATE)", () => {
    expect(code).not.toMatch(/^\s*(UPDATE|INSERT|DELETE|CREATE|ALTER|DROP|TRUNCATE|COMMIT)\b/im);
  });

  it("proposes each UPDATE as text, guarded on the list still being empty", () => {
    expect(sql).toMatch(
      /format\('UPDATE public\.zones SET zip_codes = %L::text\[\] WHERE id = %L AND zip_codes = ''\{\}'';'/,
    );
  });

  it("uses the matcher's numbers: R = 6371000, 800 m a minute, 1000 ZIPs at most", async () => {
    const { DRIVE_M_PER_MIN } = await import("@/lib/zone-match");
    const { MAX_AUTO_ZIPS } = await import("@/lib/zone-zip-fill");
    expect(sql).toMatch(/2 \* 6371000 \* asin/);
    expect(sql).toContain(`drive_time_minutes::float8 * ${DRIVE_M_PER_MIN}`);
    expect(sql).toContain(`r.n <= ${MAX_AUTO_ZIPS}`);
  });

  it("says a production run needs Brendan's approval", () => {
    expect(sql).toMatch(/needs Brendan's explicit approval/);
  });
});
