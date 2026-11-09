// A provider is a setting, not a rewrite (#529).
//
// Routing, geocoding, weather and the fallback map tiles all run on free
// public services today, and each of those services has a usage policy a
// commercial app can outgrow. Moving off one has to be a variable and a key in
// the hosting secrets -- so each service has an adapter registry and one
// variable that picks from it (src/lib/providers/config.ts).
//
// Two things are pinned here, by BEHAVIOUR (fetch is faked, nothing reaches a
// network, no key exists anywhere):
//
//   1. UNSET, every service asks exactly whom it asked before: the OSRM demo,
//      Geocodio-then-Nominatim (or Nominatim alone with no key), public
//      Open-Meteo with no key, OpenStreetMap tiles.
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
  fetchForecast,
  registerWeatherProvider,
  unregisterWeatherProvider,
  weatherProvider,
  type WeatherAdapter,
} from "@/lib/weather.functions";
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
  "WEATHER_PROVIDER",
  "WEATHER_API_KEY",
  "WEATHER_URL",
  "SUPABASE_URL",
  "SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
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
    expect(pickProvider("weather", {}, registry, "free").id).toBe("free");
    expect(pickProvider("weather", { WEATHER_PROVIDER: "  " }, registry, "free").id).toBe("free");
  });

  it("picks what the variable names, whatever its case", () => {
    expect(pickProvider("weather", { WEATHER_PROVIDER: "Paid" }, registry, "free").id).toBe("paid");
  });

  it("refuses a name nobody registered, naming the variable and the choices", () => {
    let err: unknown;
    try {
      pickProvider("weather", { WEATHER_PROVIDER: "paid-typo" }, registry, "free");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderConfigError);
    expect(String((err as Error).message)).toContain('WEATHER_PROVIDER="paid-typo"');
    expect(String((err as Error).message)).toContain("free, paid");
  });

  it("hands each adapter its service's key and base URL, and nothing of another's", () => {
    const env = {
      WEATHER_API_KEY: "w-key",
      WEATHER_URL: "https://w.example",
      ROUTING_API_KEY: "r",
    };
    expect(providerContext("weather", env)).toMatchObject({
      key: "w-key",
      url: "https://w.example",
    });
    expect(providerContext("geocoding", env)).toMatchObject({ key: null, url: null });
  });

  it("is one variable per service", () => {
    expect(PROVIDER_VARIABLE).toEqual({
      routing: "ROUTING_PROVIDER",
      geocoding: "GEOCODING_PROVIDER",
      weather: "WEATHER_PROVIDER",
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

// ── Weather ─────────────────────────────────────────────────────────────────

const OPEN_METEO_DAY = {
  daily: {
    time: ["2026-11-10"],
    precipitation_sum: [0.3],
    precipitation_probability_max: [80],
    wind_speed_10m_max: [12],
    temperature_2m_max: [48],
    temperature_2m_min: [35],
    weather_code: [61],
  },
};

const fakeWeather: WeatherAdapter = {
  id: "paid-wx",
  request: ({ lat, lon, from, to }, ctx) => ({
    url: `${ctx.url}/daily?lat=${lat}&lon=${lon}&from=${from}&to=${to}`,
    headers: { "X-Api-Key": String(ctx.key) },
  }),
  parse: (body) =>
    (body as { days: Array<{ d: string; hi: number }> }).days.map((x) => ({
      date: x.d,
      precip_in: 0,
      precip_prob: 0,
      wind_max: 0,
      temp_max: x.hi,
      temp_min: x.hi - 10,
      weathercode: 0,
    })),
};

describe("weather", () => {
  afterEach(() => unregisterWeatherProvider(fakeWeather.id));

  it("unset, asks public Open-Meteo with no key, in imperial units, as before", async () => {
    expect(weatherProvider({}).id).toBe("open-meteo");
    reply = () => json(OPEN_METEO_DAY);
    const days = await fetchForecast(42.33, -83.04, "2026-11-10", "2026-11-10");
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0].url);
    expect(u.hostname).toBe("api.open-meteo.com");
    expect(u.pathname).toBe("/v1/forecast");
    expect(u.searchParams.get("temperature_unit")).toBe("fahrenheit");
    expect(u.searchParams.has("apikey")).toBe(false);
    expect(days[0]).toMatchObject({ date: "2026-11-10", precip_in: 0.3, risky: true });
  });

  it("WEATHER_URL and WEATHER_API_KEY point the open-meteo adapter at another host, keyed", async () => {
    vi.stubEnv("WEATHER_URL", "https://weather-host.example/");
    vi.stubEnv("WEATHER_API_KEY", "wx-test-key");
    reply = () => json(OPEN_METEO_DAY);
    await fetchForecast(42.33, -83.04, "2026-11-10", "2026-11-10");
    const u = new URL(calls[0].url);
    expect(u.origin + u.pathname).toBe("https://weather-host.example/v1/forecast");
    expect(u.searchParams.get("apikey")).toBe("wx-test-key");
  });

  it("an error never carries the key", async () => {
    vi.stubEnv("WEATHER_API_KEY", "wx-test-key");
    reply = () => json({ reason: "bad apikey wx-test-key" }, 401);
    const err = await fetchForecast(42.33, -83.04, "2026-11-10", "2026-11-10").catch((e) => e);
    expect(String(err.message)).toContain("401");
    expect(String(err.message)).not.toContain("wx-test-key");
  });

  it("WEATHER_PROVIDER moves the request to the registered adapter, and the risk rules still apply", async () => {
    registerWeatherProvider(fakeWeather);
    vi.stubEnv("WEATHER_PROVIDER", "paid-wx");
    vi.stubEnv("WEATHER_URL", "https://wx.example");
    vi.stubEnv("WEATHER_API_KEY", "wx-test-key");
    reply = () => json({ days: [{ d: "2026-11-10", hi: 20 }] });
    const days = await fetchForecast(42.33, -83.04, "2026-11-10", "2026-11-10");
    expect(calls).toHaveLength(1);
    expect(host(calls[0].url)).toBe("wx.example");
    expect((calls[0].init?.headers as Record<string, string>)["X-Api-Key"]).toBe("wx-test-key");
    expect(days).toEqual([
      expect.objectContaining({
        date: "2026-11-10",
        temp_max: 20,
        risky: true,
        reasons: ["hard freeze"],
      }),
    ]);
  });

  it("a provider the relay does not mirror is never relayed through the Open-Meteo function", async () => {
    registerWeatherProvider(fakeWeather);
    vi.stubEnv("WEATHER_PROVIDER", "paid-wx");
    vi.stubEnv("WEATHER_URL", "https://wx.example");
    vi.stubEnv("SUPABASE_URL", "https://project.example");
    vi.stubEnv("SERVICE_ROLE_KEY", "service-test");
    reply = () => json({}, 503);
    await expect(fetchForecast(42.33, -83.04, "2026-11-10", "2026-11-10")).rejects.toThrow("503");
    expect(calls.map((c) => host(c.url))).toEqual(["wx.example"]);
  });

  it("an unknown WEATHER_PROVIDER is an error, not public Open-Meteo", async () => {
    vi.stubEnv("WEATHER_PROVIDER", "open-meteo-comercial");
    await expect(fetchForecast(42.33, -83.04, "2026-11-10", "2026-11-10")).rejects.toBeInstanceOf(
      ProviderConfigError,
    );
    expect(calls).toHaveLength(0);
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
