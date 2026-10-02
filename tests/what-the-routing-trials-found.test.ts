// What the routing trials found, pinned where it can be pinned without a
// database. scripts/routing-trials plans synthetic businesses with the real
// planner and measures the result; tests/routing-trials.test.ts holds the
// database half. This file is the TypeScript half of the same findings:
//
//   * a day that does not fit the workday was planned and never mentioned;
//   * the first leg from the business location was never measured;
//   * one impossible coordinate sent the whole day to straight-line estimates;
//   * the geocoder was never told which country to search;
//   * the New Client wizard threw away the pin it had already shown.
//
// The other two TypeScript findings live beside the code they fix:
// tests/route-window.test.ts (DST) and tests/route-plausibility.test.ts (the
// "Re-optimize this route" warning on freshly optimized first stops).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type Admin = { from: (table: string) => unknown; rpc: (...a: unknown[]) => unknown };
const h = vi.hoisted(() => ({ admin: null as unknown as Admin }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => h.admin.from(table),
    rpc: (...a: unknown[]) => h.admin.rpc(...a),
  },
}));

import { measureDayFit } from "@/lib/route-day-fit";
import { refreshRoadLegs } from "@/lib/road-legs.server";
import { geocodeAddress } from "@/lib/geocode.server";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

// ── A day that does not fit ─────────────────────────────────────────────────

describe("measureDayFit says when a route runs past the day", () => {
  const TZ = "America/Chicago";
  const base = { travelMin: 10, serviceMin: 15, latitude: 33, longitude: -96.7 };

  it("finds a route that finishes after the workday ends, on the org's clock", () => {
    // 19:09 CDT is 00:09 UTC the NEXT day: measured on UTC it would read as
    // a few minutes past midnight and look early, not two hours late.
    const fit = measureDayFit(
      [
        { ...base, staffId: "cara", day: "2026-10-14", etaEnd: "2026-10-14T15:00:00Z" },
        { ...base, staffId: "cara", day: "2026-10-14", etaEnd: "2026-10-15T00:09:00Z" },
        { ...base, staffId: "dev", day: "2026-10-14", etaEnd: "2026-10-14T20:30:00Z" },
      ],
      { timezone: TZ, workdayEnd: "17:00:00" },
    );
    expect(fit.overruns.map((o) => [o.staffId, o.minutesPastEnd])).toEqual([["cara", 129]]);
  });

  it("counts a route that runs past midnight as past the end, not early", () => {
    // What the trials actually planned: 40 stops, last finish 02:51 next day.
    const fit = measureDayFit(
      [{ ...base, staffId: "solo", day: "2026-10-14", etaEnd: "2026-10-15T07:51:00Z" }],
      { timezone: TZ, workdayEnd: "17:00" },
    );
    expect(fit.overruns[0].minutesPastEnd).toBe(591);
  });

  it("finds a part-timer planned past their capacity even inside the workday", () => {
    const visits = Array.from({ length: 6 }, (_, i) => ({
      ...base,
      staffId: "ned",
      day: "2026-10-14",
      etaEnd: `2026-10-14T1${5 + Math.floor(i / 3)}:0${i}:00Z`,
    }));
    const fit = measureDayFit(visits, {
      timezone: TZ,
      workdayEnd: "17:00",
      capacityByStaff: { ned: 120 },
    });
    expect(fit.overruns).toHaveLength(1);
    expect(fit.overruns[0]).toMatchObject({
      staffId: "ned",
      minutesPastEnd: 0,
      plannedMin: 150,
      capacityMin: 120,
    });
  });

  it("says nothing about a day that fits", () => {
    const fit = measureDayFit(
      [{ ...base, staffId: "cara", day: "2026-10-14", etaEnd: "2026-10-14T21:59:00Z" }],
      { timezone: TZ, workdayEnd: "17:00" },
    );
    expect(fit.overruns).toEqual([]);
  });

  it("counts the stops that have no location, per day", () => {
    const fit = measureDayFit(
      [
        {
          ...base,
          staffId: "kim",
          day: "2026-10-14",
          etaEnd: null,
          latitude: null,
          longitude: null,
        },
        { ...base, staffId: "kim", day: "2026-10-14", etaEnd: null },
      ],
      { timezone: TZ, workdayEnd: "17:00" },
    );
    expect(fit.unlocated).toEqual([{ day: "2026-10-14", count: 1 }]);
  });

  it("is what applyOptimize returns and the panel reads", () => {
    const visits = read("src/lib/visits.functions.ts");
    expect(visits).toMatch(/fit = measureDayFit\(/);
    expect(visits).toMatch(/workday_end/);
    const panel = read("src/components/routes/AutoRoutingPanel.tsx");
    expect(panel).toMatch(/r\.fit\?\.overruns/);
    expect(panel).toMatch(/r\.fit\?\.unlocated/);
    expect(panel).toMatch(/after the workday ends/);
  });
});

// ── refreshRoadLegs: what the router is asked ───────────────────────────────

function adminFor(rows: {
  visits?: Array<[number | null, number | null]>;
  staff?: Array<[number | null, number | null]>;
  business?: [number, number] | null;
}) {
  const q = (data: unknown[]) => {
    const o: {
      select: () => typeof o;
      eq: () => typeof o;
      maybeSingle: () => Promise<{ data: unknown; error: null }>;
      then: <T>(
        ok: (v: { data: unknown[]; error: null }) => T,
        no?: (e: unknown) => T,
      ) => Promise<T>;
    } = {
      select: () => o,
      eq: () => o,
      maybeSingle: () => Promise.resolve({ data: data[0] ?? null, error: null }),
      then: (ok, no) => Promise.resolve({ data, error: null }).then(ok, no),
    };
    return o;
  };
  return {
    from(t: string) {
      if (t === "visits")
        return q(
          (rows.visits ?? []).map(([latitude, longitude]) => ({
            properties: { latitude, longitude },
          })),
        );
      if (t === "staff")
        return q((rows.staff ?? []).map(([a, b]) => ({ start_latitude: a, start_longitude: b })));
      if (t === "waste_disposal_facilities") return q([]);
      if (t === "organizations")
        return q([{ latitude: rows.business?.[0] ?? null, longitude: rows.business?.[1] ?? null }]);
      if (t === "road_legs") return { upsert: async () => ({ error: null }) };
      throw new Error(t);
    },
    rpc: async () => ({ error: null }),
  };
}

/** Answer like OSRM for however many points were asked, and record the URL. */
function osrm(urls: string[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const n = url.split("/table/v1/driving/")[1].split("?")[0].split(";").length;
    const m = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => (i === j ? 0 : 600)),
    );
    return new Response(
      JSON.stringify({
        code: "Ok",
        durations: m,
        distances: m,
        sources: Array.from({ length: n }, () => ({ distance: 5 })),
        destinations: Array.from({ length: n }, () => ({ distance: 5 })),
      }),
      { status: 200 },
    );
  });
}

const coordsIn = (url: string) => url.split("/table/v1/driving/")[1].split("?")[0].split(";");

describe("refreshRoadLegs asks the router about every point a route starts from", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("includes the business location, where a technician with no address starts", () => {
    h.admin = adminFor({
      visits: [
        [33.0496, -96.8468],
        [33.0532, -96.6789],
      ],
      staff: [[null, null]],
      business: [33.0198, -96.6989],
    });
    const urls: string[] = [];
    vi.stubGlobal("fetch", osrm(urls));
    return refreshRoadLegs("org", "2026-10-14").then((r) => {
      expect(r.problem).toBeNull();
      expect(coordsIn(urls[0])).toContain("-96.6989,33.0198");
    });
  });

  it("leaves an impossible coordinate out instead of losing the whole day", async () => {
    // OSRM rejects the ENTIRE table request when one point is out of range:
    // checked against router.project-osrm.org on 2026-10-01, a single
    // "33.0705,-96.7005" (lat and lon swapped) answered
    // {"message":"Coordinates are invalid","code":"InvalidOptions"} for the
    // whole day. And 0,0 is nobody's house.
    h.admin = adminFor({
      visits: [
        [33.0496, -96.8468],
        [33.0532, -96.6789],
        [-96.7005, 33.0705],
        [0, 0],
      ],
      staff: [[33.0198, -96.6989]],
    });
    const urls: string[] = [];
    vi.stubGlobal("fetch", osrm(urls));
    const r = await refreshRoadLegs("org", "2026-10-14");
    expect(r.problem).toBeNull();
    const asked = coordsIn(urls[0]);
    expect(asked).toHaveLength(3);
    expect(asked).not.toContain("33.0705,-96.7005");
    expect(asked).not.toContain("0,0");
  });
});

// ── The geocoder is told which countries exist ──────────────────────────────

describe("geocodeAddress searches only where the customers are", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("restricts Nominatim to the US and Canada", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return new Response("[]", { status: 200 });
      }),
    );
    await geocodeAddress({ street: "12 Oak St", city: "Paris", region: "TX" });
    expect(urls[0]).toMatch(/[?&]countrycodes=us,ca(&|$)/);
  });
});

// ── The New Client wizard keeps the pin it showed ───────────────────────────

describe("onboardClient stores the wizard's pin instead of geocoding again", () => {
  const server = read("src/lib/clients.functions.ts");
  const handler = server.slice(server.indexOf("export const onboardClient"));
  const wizard = read("src/routes/_authenticated/clients.new.tsx");

  it("accepts the coordinates", () => {
    const schema = server.slice(
      server.indexOf("const onboardSchema"),
      server.indexOf("export const onboardClient"),
    );
    expect(schema).toMatch(/latitude: z\.number\(\)\.min\(-90\)\.max\(90\)\.optional\(\)/);
    expect(schema).toMatch(/longitude: z\.number\(\)\.min\(-180\)\.max\(180\)\.optional\(\)/);
  });

  it("only geocodes when it was not given a pin", () => {
    expect(handler).toMatch(/const pinned = data\.latitude != null && data\.longitude != null;/);
    const at = handler.indexOf("if (!pinned) {");
    expect(at, "the geocode is no longer conditional on there being no pin").toBeGreaterThan(-1);
    expect(handler.indexOf('await import("./geocode.server")')).toBeGreaterThan(at);
  });

  it("is sent the pin the screen showed", () => {
    expect(wizard).toMatch(/latitude: geo\?\.lat,\s*\n\s*longitude: geo\?\.lng,/);
  });
});
