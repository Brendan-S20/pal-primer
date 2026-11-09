// A provider is a setting, not a rewrite (#529).
//
// Routing, geocoding and the fallback map tiles ran on free public services,
// each with a usage policy a commercial app can outgrow. The owner's decision
// (2026-11-09): Google Maps Platform for geocoding and routing for now, OSRM
// later -- so each service has an adapter registry and one variable that
// picks from it (src/lib/providers/config.ts), and a Google server key selects
// Google. Weather was dropped from #529 and is not here.
//
// Two things are pinned here, by BEHAVIOUR (fetch is faked, nothing reaches a
// network, no key exists anywhere):
//
//   1. With NO KEY and nothing set, every service asks exactly whom it asked
//      before: the OSRM demo, Geocodio-then-Nominatim (or Nominatim alone),
//      OpenStreetMap tiles. With GOOGLE_MAPS_API_KEY set, Google, counted.
//   2. SET, the variable moves the request -- to a registered adapter, with
//      the generic key and URL handed to it -- and a name nobody registered is
//      an error, never a quiet fall back to the free public service.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Admin = { from: (table: string) => unknown; rpc: (...a: unknown[]) => unknown };
const h = vi.hoisted(() => ({ admin: null as unknown as Admin }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => h.admin.from(table),
    rpc: (...a: unknown[]) => h.admin.rpc(...a),
  },
}));

import {
  ProviderConfigError,
  pickProvider,
  providerContext,
  PROVIDER_VARIABLE,
} from "@/lib/providers/config";
import {
  refreshRoadLegs,
  registerRoutingProvider,
  routingProvider,
  setRoadLegTiming,
  unregisterRoutingProvider,
  type RoutingAdapter,
} from "@/lib/road-legs.server";
import {
  GEOCODER_FAILED,
  geocodeAddress,
  geocodeAddresses,
  geocodingProviders,
  registerGeocodingProvider,
  unregisterGeocodingProvider,
  type GeocodingAdapter,
} from "@/lib/geocode.server";
import {
  googleMapsUsage,
  recordGoogleMapsUsage,
  resetGoogleMapsUsage,
} from "@/lib/providers/google-usage.server";
import { resolveStreetTiles } from "@/lib/map-tiles";

// ── The world, faked ────────────────────────────────────────────────────────

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
let reply: (c: Call) => Response;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Every variable this change reads, cleared, so the host's env cannot leak in. */
const VARS = [
  "ROUTING_PROVIDER",
  "ROUTING_API_KEY",
  "ROUTING_URL",
  "OSRM_URL",
  "OSRM_ENDPOINTS",
  "GEOCODING_PROVIDER",
  "GEOCODING_FALLBACK",
  "GEOCODING_API_KEY",
  "GEOCODING_URL",
  "GEOCODIO_API_KEY",
  "GOOGLE_MAPS_API_KEY",
];

beforeEach(() => {
  for (const v of VARS) vi.stubEnv(v, "");
  calls = [];
  reply = () => json({}, 404);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), init };
      calls.push(call);
      return reply(call);
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const host = (url: string) => new URL(url).hostname;

// ── The shared resolver ─────────────────────────────────────────────────────

describe("the provider setting", () => {
  const registry = new Map([
    ["free", { id: "free" }],
    ["paid", { id: "paid" }],
  ]);

  it("picks the default when the variable is unset or blank", () => {
    expect(pickProvider("routing", {}, registry, "free").id).toBe("free");
    expect(pickProvider("routing", { ROUTING_PROVIDER: "  " }, registry, "free").id).toBe("free");
  });

  it("picks what the variable names, whatever its case", () => {
    expect(pickProvider("routing", { ROUTING_PROVIDER: "Paid" }, registry, "free").id).toBe("paid");
  });

  it("refuses a name nobody registered, naming the variable and the choices", () => {
    let err: unknown;
    try {
      pickProvider("routing", { ROUTING_PROVIDER: "paid-typo" }, registry, "free");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderConfigError);
    expect(String((err as Error).message)).toContain('ROUTING_PROVIDER="paid-typo"');
    expect(String((err as Error).message)).toContain("free, paid");
  });

  it("hands each adapter its service's key and base URL, and nothing of another's", () => {
    const env = {
      ROUTING_API_KEY: "r-key",
      ROUTING_URL: "https://r.example",
      VITE_MAP_TILES_KEY: "t",
    };
    expect(providerContext("routing", env)).toMatchObject({
      key: "r-key",
      url: "https://r.example",
    });
    expect(providerContext("geocoding", env)).toMatchObject({ key: null, url: null });
  });

  it("is one variable per service", () => {
    expect(PROVIDER_VARIABLE).toEqual({
      routing: "ROUTING_PROVIDER",
      geocoding: "GEOCODING_PROVIDER",
      "map-tiles": "VITE_MAP_TILES_PROVIDER",
    });
  });
});

// ── Routing ─────────────────────────────────────────────────────────────────

const STOPS: Array<[number, number]> = [
  [42.3314, -83.0458],
  [42.3601, -83.0702],
  [42.3398, -83.1101],
];

type World = { written: Array<Record<string, unknown>> };
let world: World;

function adminFor(w: World): Admin {
  const rows = (data: unknown[]) => {
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: () => Promise.resolve({ data: data[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, no?: (e: unknown) => unknown) =>
        Promise.resolve({ data, error: null }).then(ok, no),
    };
    return q;
  };
  return {
    from(t: string) {
      if (t === "visits")
        return rows(
          STOPS.map(([latitude, longitude]) => ({ properties: { latitude, longitude } })),
        );
      if (t === "staff" || t === "waste_disposal_facilities") return rows([]);
      if (t === "organizations") return rows([{ latitude: null, longitude: null }]);
      if (t === "road_legs")
        return {
          upsert: async (r: Array<Record<string, unknown>>) => {
            w.written.push(...r);
            return { error: null };
          },
        };
      if (t === "road_leg_runs")
        return {
          insert: async () => ({ error: null }),
          delete: () => ({ eq: () => ({ lt: async () => ({ error: null }) }) }),
        };
      throw new Error(`unexpected table ${t}`);
    },
    async rpc(name: unknown) {
      if (name === "count_fresh_road_legs") return { data: 0, error: null };
      if (name === "refresh_road_profile") return { data: null, error: null };
      throw new Error(`unexpected rpc ${String(name)}`);
    },
  };
}

function table(n: number) {
  const m = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : 600)),
  );
  return {
    code: "Ok",
    durations: m,
    distances: m,
    sources: Array.from({ length: n }, () => ({ distance: 5 })),
    destinations: Array.from({ length: n }, () => ({ distance: 5 })),
  };
}

/** A stand-in for a paid matrix API: its own URL, a key in a header, and a
 *  reply that is NOT OSRM-shaped until the adapter says so. */
const fakeRouter: RoutingAdapter = {
  id: "paid-matrix",
  label: "PaidMatrix",
  maxPoints: () => 25,
  tableRequest(points, ctx) {
    return {
      url: `${ctx.url}/matrix?n=${points.length}`,
      headers: { Authorization: `Bearer ${ctx.key}` },
      endpoint: String(ctx.url),
    };
  },
  parseTable(body) {
    const b = body as { seconds: number[][]; metres: number[][]; snapped: number[] };
    return {
      code: "Ok",
      durations: b.seconds,
      distances: b.metres,
      sources: b.snapped.map((distance) => ({ distance })),
      destinations: b.snapped.map((distance) => ({ distance })),
    };
  },
};

describe("routing", () => {
  beforeEach(() => {
    world = { written: [] };
    h.admin = adminFor(world);
    setRoadLegTiming({ paceDemo: false, sleep: async () => {} });
  });
  afterEach(() => {
    setRoadLegTiming(null);
    unregisterRoutingProvider(fakeRouter.id);
  });

  it("unset, asks the OSRM demo exactly as before and records the legs as osrm", async () => {
    expect(routingProvider({}).id).toBe("osrm");
    reply = () => json(table(STOPS.length));
    const r = await refreshRoadLegs("org", "2026-11-10");
    expect(calls).toHaveLength(1);
    expect(host(calls[0].url)).toBe("router.project-osrm.org");
    expect(calls[0].url).toContain("/table/v1/driving/");
    expect(r.problem).toBeNull();
    expect(r.measured).toBe(6);
    expect(new Set(world.written.map((row) => row.source))).toEqual(new Set(["osrm"]));
  });

  it("ROUTING_PROVIDER moves the request to the registered adapter, with ROUTING_URL and ROUTING_API_KEY", async () => {
    registerRoutingProvider(fakeRouter);
    vi.stubEnv("ROUTING_PROVIDER", "paid-matrix");
    vi.stubEnv("ROUTING_URL", "https://matrix.example");
    vi.stubEnv("ROUTING_API_KEY", "test-key-not-real");
    const t = table(STOPS.length);
    reply = () => json({ seconds: t.durations, metres: t.distances, snapped: [5, 5, 5] });

    const r = await refreshRoadLegs("org", "2026-11-10");

    expect(calls.map((c) => c.url)).toEqual(["https://matrix.example/matrix?n=3"]);
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-key-not-real",
    );
    expect(r).toMatchObject({ measured: 6, problem: null });
    expect(new Set(world.written.map((row) => row.source))).toEqual(new Set(["paid-matrix"]));
  });

  it("an unknown ROUTING_PROVIDER plans on estimates and never reaches the demo server", async () => {
    vi.stubEnv("ROUTING_PROVIDER", "paid-matrx");
    const r = await refreshRoadLegs("org", "2026-11-10");
    expect(calls).toHaveLength(0);
    expect(r.problem).toBe("router_error");
  });
});

// ── Google routing (the decision of 2026-11-09) ─────────────────────────────

/** What Compute Route Matrix streams back: one element per pair, indexes
 *  omitted when 0 (proto3), durations as "123s". */
function googleMatrix(n: number) {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const el: Record<string, unknown> = {
        duration: i === j ? "0s" : `${600 + i}s`,
        condition: "ROUTE_EXISTS",
        status: {},
      };
      if (i) el.originIndex = i;
      if (j) el.destinationIndex = j;
      if (i !== j) el.distanceMeters = 5000 + j;
      out.push(el);
    }
  return out;
}

describe("routing on Google", () => {
  beforeEach(() => {
    world = { written: [] };
    h.admin = adminFor(world);
    setRoadLegTiming({ paceDemo: false, sleep: async () => {} });
    resetGoogleMapsUsage();
  });
  afterEach(() => setRoadLegTiming(null));

  it("a Google server key selects Google; ROUTING_PROVIDER=osrm still overrides it", () => {
    expect(routingProvider({ GOOGLE_MAPS_API_KEY: "k" }).id).toBe("google");
    expect(routingProvider({ GOOGLE_MAPS_API_KEY: "k", ROUTING_PROVIDER: "osrm" }).id).toBe("osrm");
    expect(routingProvider({}).id).toBe("osrm");
  });

  it("asks Compute Route Matrix once, key in a header and not the URL, and records Google legs", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "google-test-key");
    reply = () => json(googleMatrix(STOPS.length));
    const r = await refreshRoadLegs("org", "2026-11-10");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix");
    expect(calls[0].url).not.toContain("google-test-key");
    expect(calls[0].init?.method).toBe("POST");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe("google-test-key");
    expect(headers["X-Goog-FieldMask"]).toContain("duration");
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.routingPreference).toBe("TRAFFIC_UNAWARE");
    expect(body.origins).toHaveLength(3);
    expect(body.origins[0].waypoint.location.latLng).toEqual({
      latitude: STOPS[0][0],
      longitude: STOPS[0][1],
    });

    expect(r).toMatchObject({ measured: 6, problem: null });
    expect(new Set(world.written.map((row) => row.source))).toEqual(new Set(["google"]));
    const leg = world.written.find(
      (row) => row.from_lat === STOPS[0][0] && row.to_lat === STOPS[1][0],
    );
    expect(leg).toMatchObject({ seconds: 600, meters: 5001 });
    // 3 points is 9 billed elements.
    expect(googleMapsUsage()["route-matrix-elements"]).toBe(9);
  });

  it("a pair Google cannot route stays on the estimate; the rest are measured", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "google-test-key");
    const m = googleMatrix(STOPS.length).map((el) =>
      el.originIndex === 1 && el.destinationIndex === 2
        ? { ...el, condition: "ROUTE_NOT_FOUND" }
        : el,
    );
    reply = () => json(m);
    const r = await refreshRoadLegs("org", "2026-11-10");
    expect(r.measured).toBe(5);
  });

  it("a refused key leaves the day on estimates and never falls back to the OSRM demo", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "google-test-key");
    reply = () =>
      json(
        { error: { code: 403, status: "PERMISSION_DENIED", message: "Routes API not enabled" } },
        403,
      );
    const r = await refreshRoadLegs("org", "2026-11-10");
    expect(r.problem).toBe("router_error");
    expect(calls.map((c) => host(c.url))).toEqual(["routes.googleapis.com"]);
  });

  it("a day of more than 25 points (625 elements) is not sent to Google", () => {
    expect(
      routingProvider({ GOOGLE_MAPS_API_KEY: "k" }).maxPoints(providerContext("routing", {})),
    ).toBe(25);
  });

  it("ROUTING_PROVIDER=google with no key is an estimate, not a request", async () => {
    vi.stubEnv("ROUTING_PROVIDER", "google");
    const r = await refreshRoadLegs("org", "2026-11-10");
    expect(r.problem).toBe("router_error");
    expect(calls).toHaveLength(0);
  });
});

// ── Geocoding ───────────────────────────────────────────────────────────────

const NOMINATIM_HOUSE = [
  { lat: "42.33", lon: "-83.04", address: { house_number: "1", road: "Main", city: "Detroit" } },
];
const GEOCODIO_HOUSE = {
  results: [
    {
      address_components: { country: "US", city: "Detroit" },
      location: { lat: 42.1, lng: -83.1 },
      accuracy: 1,
      accuracy_type: "rooftop",
    },
  ],
};
const ADDRESS = { street: "1 Main St", city: "Detroit", region: "MI", country: "US" };

const fakeGeocoder: GeocodingAdapter = {
  id: "paid-geo",
  async single(address, _parts, ctx) {
    const res = await fetch(`${ctx.url}/lookup?q=${encodeURIComponent(address)}&key=${ctx.key}`);
    if (!res.ok) return GEOCODER_FAILED;
    const b = (await res.json()) as { lat: number; lon: number };
    return { latitude: b.lat, longitude: b.lon, precision: "house", place: null };
  },
};

describe("geocoding", () => {
  afterEach(() => unregisterGeocodingProvider(fakeGeocoder.id));

  it("unset with no Geocodio key, asks Nominatim, as before", async () => {
    expect(geocodingProviders({}).primary.id).toBe("nominatim");
    reply = () => json(NOMINATIM_HOUSE);
    const r = await geocodeAddress(ADDRESS);
    expect(calls.map((c) => host(c.url))).toEqual(["nominatim.openstreetmap.org"]);
    expect(r).toMatchObject({ latitude: 42.33, longitude: -83.04, precision: "house" });
  });

  it("unset with a Geocodio key, asks Geocodio and falls back to Nominatim when it fails, as before", async () => {
    vi.stubEnv("GEOCODIO_API_KEY", "geocodio-test-key");
    expect(geocodingProviders({ GEOCODIO_API_KEY: "x" })).toMatchObject({
      primary: { id: "geocodio" },
      fallback: { id: "nominatim" },
    });
    reply = (c) =>
      host(c.url) === "api.geocod.io" ? json({ error: "down" }, 503) : json(NOMINATIM_HOUSE);
    const r = await geocodeAddress(ADDRESS);
    expect(calls.map((c) => host(c.url))).toEqual(["api.geocod.io", "nominatim.openstreetmap.org"]);
    expect(r).toMatchObject({ latitude: 42.33 });
  });

  it("GEOCODING_PROVIDER moves the lookup to the registered adapter, with GEOCODING_URL and GEOCODING_API_KEY", async () => {
    registerGeocodingProvider(fakeGeocoder);
    vi.stubEnv("GEOCODING_PROVIDER", "paid-geo");
    vi.stubEnv("GEOCODING_URL", "https://geo.example");
    vi.stubEnv("GEOCODING_API_KEY", "geo-test-key");
    reply = () => json({ lat: 1.5, lon: 2.5 });
    const r = await geocodeAddress(ADDRESS);
    expect(calls).toHaveLength(1);
    expect(host(calls[0].url)).toBe("geo.example");
    expect(new URL(calls[0].url).searchParams.get("key")).toBe("geo-test-key");
    expect(r).toEqual({ latitude: 1.5, longitude: 2.5, precision: "house", place: null });
  });

  it("GEOCODING_FALLBACK=none means a failed provider costs the pin, not a trip to Nominatim", async () => {
    registerGeocodingProvider(fakeGeocoder);
    vi.stubEnv("GEOCODING_PROVIDER", "paid-geo");
    vi.stubEnv("GEOCODING_URL", "https://geo.example");
    vi.stubEnv("GEOCODING_FALLBACK", "none");
    reply = () => json({}, 503);
    expect(await geocodeAddress(ADDRESS)).toBeNull();
    expect(await geocodeAddresses([ADDRESS, ADDRESS])).toEqual([null, null]);
    expect(calls.every((c) => host(c.url) === "geo.example")).toBe(true);
  });

  it("a batch asks the configured adapter row by row and sends only its misses to the fallback", async () => {
    registerGeocodingProvider(fakeGeocoder);
    vi.stubEnv("GEOCODING_PROVIDER", "paid-geo");
    vi.stubEnv("GEOCODING_URL", "https://geo.example");
    reply = (c) =>
      host(c.url) === "nominatim.openstreetmap.org"
        ? json(NOMINATIM_HOUSE)
        : c.url.includes("Second")
          ? json({}, 500)
          : json({ lat: 1, lon: 2 });
    const out = await geocodeAddresses([
      { street: "1 First St", city: "Detroit" },
      { street: "2 Second St", city: "Detroit" },
    ]);
    expect(out[0]).toMatchObject({ latitude: 1, longitude: 2 });
    expect(out[1]).toMatchObject({ latitude: 42.33 });
    expect(calls.map((c) => host(c.url))).toEqual([
      "geo.example",
      "geo.example",
      "nominatim.openstreetmap.org",
    ]);
  }, 10_000);

  it("an unknown GEOCODING_PROVIDER returns no point and asks nobody", async () => {
    vi.stubEnv("GEOCODING_PROVIDER", "paid-gel");
    expect(() => geocodingProviders({ GEOCODING_PROVIDER: "paid-gel" })).toThrow(
      ProviderConfigError,
    );
    expect(await geocodeAddress(ADDRESS)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

// ── Google geocoding (the decision of 2026-11-09) ───────────────────────────

const GOOGLE_ROOFTOP = {
  status: "OK",
  results: [
    {
      address_components: [
        { long_name: "Detroit", short_name: "Detroit", types: ["locality", "political"] },
        { long_name: "United States", short_name: "US", types: ["country", "political"] },
      ],
      geometry: { location: { lat: 42.3314, lng: -83.0458 }, location_type: "ROOFTOP" },
      types: ["street_address"],
    },
  ],
};

describe("geocoding on Google", () => {
  beforeEach(() => resetGoogleMapsUsage());

  it("a Google server key selects Google ahead of Geocodio, with Nominatim still the fallback", () => {
    expect(geocodingProviders({ GOOGLE_MAPS_API_KEY: "k", GEOCODIO_API_KEY: "g" })).toMatchObject({
      primary: { id: "google" },
      fallback: { id: "nominatim" },
    });
    expect(
      geocodingProviders({ GOOGLE_MAPS_API_KEY: "k", GEOCODING_PROVIDER: "geocodio" }).primary.id,
    ).toBe("geocodio");
  });

  it("asks the Geocoding API, reads a rooftop as a house, and counts the request", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "google-test-key");
    reply = () => json(GOOGLE_ROOFTOP);
    const r = await geocodeAddress(ADDRESS);
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0].url);
    expect(u.origin + u.pathname).toBe("https://maps.googleapis.com/maps/api/geocode/json");
    expect(u.searchParams.get("address")).toBe("1 Main St, Detroit, MI, US");
    expect(r).toEqual({
      latitude: 42.3314,
      longitude: -83.0458,
      precision: "house",
      place: "Detroit",
    });
    expect(googleMapsUsage().geocoding).toBe(1);
  });

  it("a partial match is a street, a road centre is a street, an approximate point is an area", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "google-test-key");
    const variant = (geometry: object, extra: object = {}) => ({
      status: "OK",
      results: [{ ...GOOGLE_ROOFTOP.results[0], ...extra, geometry: { ...geometry } }],
    });
    const loc = { lat: 1, lng: 2 };
    for (const [body, want] of [
      [variant({ location: loc, location_type: "ROOFTOP" }, { partial_match: true }), "street"],
      [
        variant({ location: loc, location_type: "GEOMETRIC_CENTER" }, { types: ["route"] }),
        "street",
      ],
      [variant({ location: loc, location_type: "APPROXIMATE" }, { types: ["locality"] }), "area"],
    ] as const) {
      reply = () => json(body);
      expect((await geocodeAddress(ADDRESS))?.precision).toBe(want);
    }
  });

  it("ZERO_RESULTS is no point and asks nobody else; REQUEST_DENIED falls back, and the key is never logged", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "google-test-key");
    reply = () => json({ status: "ZERO_RESULTS", results: [] });
    expect(await geocodeAddress(ADDRESS)).toBeNull();
    expect(calls).toHaveLength(1);

    calls = [];
    reply = (c) =>
      host(c.url) === "maps.googleapis.com"
        ? json({ status: "REQUEST_DENIED", error_message: "key google-test-key not authorised" })
        : json(NOMINATIM_HOUSE);
    const r = await geocodeAddress(ADDRESS);
    expect(calls.map((c) => host(c.url))).toEqual([
      "maps.googleapis.com",
      "nominatim.openstreetmap.org",
    ]);
    expect(r).toMatchObject({ latitude: 42.33 });
    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).toContain("REQUEST_DENIED");
    expect(logged).not.toContain("google-test-key");
  });

  it("a batch is answered in input order", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "google-test-key");
    reply = (c) => {
      const n = Number(new URL(c.url).searchParams.get("address")!.split(" ")[0]);
      return json({
        status: "OK",
        results: [
          {
            ...GOOGLE_ROOFTOP.results[0],
            geometry: { location: { lat: n, lng: -n }, location_type: "ROOFTOP" },
          },
        ],
      });
    };
    const list = Array.from({ length: 20 }, (_, i) => ({
      street: `${i + 1} Main St`,
      city: "Detroit",
    }));
    const out = await geocodeAddresses(list);
    expect(out.map((r) => r?.latitude)).toEqual(list.map((_, i) => i + 1));
    expect(googleMapsUsage().geocoding).toBe(20);
  });
});

// ── Counting Google calls ───────────────────────────────────────────────────

describe("Google usage counting", () => {
  beforeEach(() => resetGoogleMapsUsage());

  it("counts per API per UTC month, and logs the first call and every 500 units", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const nov = new Date("2026-11-09T12:00:00Z");
    recordGoogleMapsUsage("geocoding", 1, nov);
    for (let i = 0; i < 499; i++) recordGoogleMapsUsage("geocoding", 1, nov);
    recordGoogleMapsUsage("route-matrix-elements", 576, nov);
    recordGoogleMapsUsage("geocoding", 1, new Date("2026-12-01T00:00:00Z"));

    expect(googleMapsUsage("2026-11")).toEqual({ geocoding: 500, "route-matrix-elements": 576 });
    expect(googleMapsUsage("2026-12")).toEqual({ geocoding: 1 });
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual([
      expect.stringContaining("month=2026-11 api=geocoding units_this_process=1 "),
      expect.stringContaining("month=2026-11 api=geocoding units_this_process=500 "),
      expect.stringContaining("month=2026-11 api=route-matrix-elements units_this_process=576 "),
      expect.stringContaining("month=2026-12 api=geocoding units_this_process=1 "),
    ]);
  });
});

// ── Map tiles ───────────────────────────────────────────────────────────────

describe("fallback map tiles", () => {
  it("unset, draws OpenStreetMap with its attribution, as before", () => {
    const t = resolveStreetTiles({});
    expect(t.url).toBe("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png");
    expect(t.attribution).toContain("OpenStreetMap contributors");
    expect(t.maxZoom).toBe(19);
  });

  it("VITE_MAP_TILES_PROVIDER=xyz draws any keyed {z}/{x}/{y} service from the URL, key and attribution", () => {
    const t = resolveStreetTiles({
      VITE_MAP_TILES_PROVIDER: "xyz",
      VITE_MAP_TILES_URL: "https://tiles.example/{z}/{x}/{y}.png?key={key}",
      VITE_MAP_TILES_KEY: "tile-test-key",
      VITE_MAP_TILES_ATTRIBUTION: "© Example",
      VITE_MAP_TILES_MAX_ZOOM: "20",
    });
    expect(t).toEqual({
      url: "https://tiles.example/{z}/{x}/{y}.png?key=tile-test-key",
      attribution: "© Example",
      maxZoom: 20,
    });
  });

  it("a misconfigured tile provider still draws a map -- OSM, with the reason logged", () => {
    const errors = vi.mocked(console.error);
    expect(resolveStreetTiles({ VITE_MAP_TILES_PROVIDER: "xyz" }).url).toContain("openstreetmap");
    expect(
      resolveStreetTiles({
        VITE_MAP_TILES_PROVIDER: "xyz",
        VITE_MAP_TILES_URL: "https://tiles.example/{z}/{x}/{y}.png?key={key}",
      }).url,
    ).toContain("openstreetmap");
    expect(resolveStreetTiles({ VITE_MAP_TILES_PROVIDER: "nope" }).url).toContain("openstreetmap");
    expect(errors).toHaveBeenCalledTimes(3);
  });
});
