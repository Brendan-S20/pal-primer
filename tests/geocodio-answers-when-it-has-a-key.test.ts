// Geocodio answers when it has a key, and Nominatim answers when it does not.
//
// No key exists yet. src/lib/geocode.server.ts is wired so that setting
// GEOCODIO_API_KEY is the whole change: single lookups go to Geocodio, imports
// and backfills go to its BATCH endpoint (one request for N rows instead of N
// throttled Nominatim requests), and any Geocodio error falls back to
// Nominatim. Because nobody can have watched that path run against the real
// service, everything here is pinned against hand-written responses in
// Geocodio's documented shape, and fetch is stubbed so that NOTHING here can
// reach the network -- an unexpected URL throws.
//
// What a regression would look like, and why each one matters:
//   * a house-level answer reported as street, or a street centroid reported
//     as a house -- the bug geocode.server.ts's precision exists to prevent;
//   * a non-US/Canada point stored -- one such point broke auto-routing for a
//     whole day in the routing trials;
//   * a Geocodio outage, a bad key or a 429 returning null instead of falling
//     back -- every signup and import would lose its pin;
//   * a batch whose answers land on the wrong rows -- a pin on the wrong
//     customer's house, which looks completely plausible;
//   * the API key in a log line -- it travels in the URL, so it is one careless
//     `console.error(url)` from being in every log drain.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { geocodeAddress, geocodeAddresses } from "@/lib/geocode.server";

const KEY = "test-geocodio-key-7f3a9c";

// ── Fixtures, in Geocodio's documented response shape ───────────────────────

type Hit = {
  lat: number;
  lng: number;
  accuracy: number;
  accuracy_type: string;
  country?: string;
  formatted_address?: string;
};

function result(h: Hit) {
  return {
    address_components: {
      number: "1109",
      predirectional: "N",
      street: "Highland",
      suffix: "St",
      formatted_street: "N Highland St",
      city: "Arlington",
      county: "Arlington County",
      state: "VA",
      zip: "22201",
      country: h.country ?? "US",
    },
    formatted_address: h.formatted_address ?? "1109 N Highland St, Arlington, VA 22201",
    location: { lat: h.lat, lng: h.lng },
    accuracy: h.accuracy,
    accuracy_type: h.accuracy_type,
    source: "Arlington",
  };
}

function single(...hits: Hit[]) {
  return {
    input: {
      address_components: {
        number: "1109",
        street: "Highland",
        city: "Arlington",
        state: "VA",
        zip: "22201",
        country: "US",
      },
      formatted_address: "1109 Highland, Arlington, VA 22201",
    },
    results: hits.map(result),
  };
}

const ROOFTOP: Hit = { lat: 38.886672, lng: -77.094735, accuracy: 1, accuracy_type: "rooftop" };

// A Nominatim house-level reply: what the module asked for with addressdetails=1.
const NOMINATIM_HOUSE = [
  {
    lat: "40.0001",
    lon: "-75.0001",
    display_name: "12, Oak Street, Springfield",
    address: { house_number: "12", road: "Oak Street", city: "Springfield", country_code: "us" },
  },
];

// ── The fetch stub: records every request, answers from a script ────────────

type Call = { url: string; method: string; body: string | null };
let calls: Call[] = [];
let geocodio: (call: Call) => Response;
let nominatim: (call: Call) => Response;
let logged: string[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const isGeocodio = (c: Call) => c.url.startsWith("https://api.geocod.io/");
const isNominatim = (c: Call) => c.url.startsWith("https://nominatim.openstreetmap.org/");

beforeEach(() => {
  calls = [];
  logged = [];
  geocodio = () => {
    throw new Error("this test did not expect Geocodio to be called");
  };
  nominatim = () => json(NOMINATIM_HOUSE);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : null,
      };
      calls.push(call);
      if (isGeocodio(call)) return geocodio(call);
      if (isNominatim(call)) return nominatim(call);
      throw new Error(`unexpected network request to ${call.url}`);
    }),
  );
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(
        args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(" "),
      );
    });
  }
  // Nominatim is throttled to 1/s with setTimeout; fake time keeps the
  // fallback tests from sleeping for real.
  vi.useFakeTimers();
});

afterEach(() => {
  // The key must never reach a log line, in ANY test.
  for (const line of logged) expect(line).not.toContain(KEY);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Drive a promise to completion across the Nominatim throttle's timers. */
async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  let value!: T;
  let error: unknown;
  let failed = false;
  p.then(
    (v) => {
      value = v;
      done = true;
    },
    (e) => {
      error = e;
      failed = true;
      done = true;
    },
  );
  for (let i = 0; i < 1000 && !done; i++) await vi.advanceTimersByTimeAsync(1000);
  if (!done) throw new Error("geocode never settled");
  if (failed) throw error;
  return value;
}

const OAK = { street: "12 Oak St", city: "Springfield", region: "IL", postal_code: "62704" };

// ── No key: unchanged ────────────────────────────────────────────────────────

describe("with no GEOCODIO_API_KEY, Nominatim answers exactly as before", () => {
  beforeEach(() => vi.stubEnv("GEOCODIO_API_KEY", ""));

  it("a single lookup goes to Nominatim, US and Canada only, and never to Geocodio", async () => {
    const geo = await settle(geocodeAddress(OAK));
    expect(geo).toEqual({ latitude: 40.0001, longitude: -75.0001, precision: "house" });
    expect(calls).toHaveLength(1);
    expect(isNominatim(calls[0])).toBe(true);
    expect(calls[0].url).toMatch(/[?&]countrycodes=us,ca(&|$)/);
    expect(calls.some(isGeocodio)).toBe(false);
  });

  it("the bulk path is one Nominatim request per row, in order, and never Geocodio", async () => {
    const geos = await settle(geocodeAddresses([OAK, { street: "" }, OAK]));
    expect(geos).toHaveLength(3);
    expect(geos[1]).toBeNull(); // an empty address is not sent anywhere
    expect(geos[0]?.precision).toBe("house");
    expect(geos[2]?.precision).toBe("house");
    expect(calls.filter(isNominatim)).toHaveLength(2);
    expect(calls.some(isGeocodio)).toBe(false);
  });
});

// ── With a key: Geocodio, single lookups ─────────────────────────────────────

describe("with GEOCODIO_API_KEY set, a single lookup goes to Geocodio", () => {
  beforeEach(() => vi.stubEnv("GEOCODIO_API_KEY", KEY));

  it("asks Geocodio, not Nominatim, with the key and the address", async () => {
    geocodio = () => json(single(ROOFTOP));
    const geo = await settle(geocodeAddress(OAK));
    expect(geo).toEqual({ latitude: 38.886672, longitude: -77.094735, precision: "house" });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe("https://api.geocod.io/v1.7/geocode");
    expect(calls[0].method).toBe("GET");
    expect(url.searchParams.get("api_key")).toBe(KEY);
    expect(url.searchParams.get("q")).toBe("12 Oak St, Springfield, IL, 62704");
    expect(calls.some(isNominatim)).toBe(false);
  });

  it("names the country when the address says which, and never another one", async () => {
    geocodio = () => json(single(ROOFTOP));
    await settle(geocodeAddress({ ...OAK, country: "United States" }));
    await settle(
      geocodeAddress({
        street: "100 Queen St W",
        city: "Toronto",
        region: "ON",
        postal_code: "M5H 2N2",
      }),
    );
    await settle(geocodeAddress(OAK));
    const country = calls.map((c) => new URL(c.url).searchParams.get("country"));
    expect(country).toEqual(["US", "CA", null]);
  });

  it.each([
    ["rooftop", 1, "house"],
    ["point", 0.95, "house"],
    ["range_interpolation", 0.9, "house"],
    ["nearest_rooftop_match", 0.9, "street"],
    ["intersection", 0.8, "street"],
    ["street_center", 0.9, "street"],
    ["place", 0.9, "area"],
    ["county", 0.8, "area"],
    ["state", 0.8, "area"],
    // House-level type, but Geocodio is not confident it is THIS house.
    ["rooftop", 0.5, "street"],
    ["range_interpolation", 0.6, "street"],
  ] as const)("maps accuracy_type %s at accuracy %s to %s", async (type, accuracy, precision) => {
    geocodio = () => json(single({ lat: 41.5, lng: -87.5, accuracy, accuracy_type: type }));
    const geo = await settle(geocodeAddress(OAK));
    expect(geo).toEqual({ latitude: 41.5, longitude: -87.5, precision });
    if (precision !== "house") {
      // Imprecise is used, not refused -- but it is visible.
      expect(logged.some((l) => l.includes(`${precision}-level match only`))).toBe(true);
    }
  });

  it("rejects a result outside the US and Canada, and takes the next one that is inside", async () => {
    geocodio = () =>
      json(
        single(
          { lat: 48.8566, lng: 2.3522, accuracy: 1, accuracy_type: "rooftop", country: "FR" },
          {
            lat: 33.6609,
            lng: -95.5555,
            accuracy: 0.9,
            accuracy_type: "street_center",
            country: "US",
          },
        ),
      );
    const geo = await settle(geocodeAddress({ street: "12 Oak St", city: "Paris" }));
    expect(geo).toEqual({ latitude: 33.6609, longitude: -95.5555, precision: "street" });
  });

  it("returns null when every result is outside the US and Canada", async () => {
    geocodio = () =>
      json(
        single({ lat: 48.8566, lng: 2.3522, accuracy: 1, accuracy_type: "rooftop", country: "FR" }),
      );
    const geo = await settle(geocodeAddress({ street: "12 Oak St", city: "Paris" }));
    expect(geo).toBeNull();
    // A definite "nothing usable" from Geocodio is an answer, not an error.
    expect(calls.some(isNominatim)).toBe(false);
  });

  it.each([
    [403, { error: `Invalid API key ${KEY}` }],
    [422, { error: "Could not parse address" }],
    [429, { error: "Rate limit exceeded" }],
    [500, { error: "Internal server error" }],
    [503, "<html>Service Unavailable</html>"],
  ])("falls back to Nominatim on a Geocodio %s", async (status, body) => {
    geocodio = () =>
      typeof body === "string" ? new Response(body, { status }) : json(body, status);
    const geo = await settle(geocodeAddress(OAK));
    expect(geo).toEqual({ latitude: 40.0001, longitude: -75.0001, precision: "house" });
    expect(calls.map((c) => (isGeocodio(c) ? "geocodio" : "nominatim"))).toEqual([
      "geocodio",
      "nominatim",
    ]);
    expect(logged.some((l) => l.includes(`geocodio ${status}`))).toBe(true);
  });

  it("falls back to Nominatim when Geocodio cannot be reached at all", async () => {
    geocodio = (c) => {
      throw new TypeError(`fetch failed: ${c.url}`);
    };
    const geo = await settle(geocodeAddress(OAK));
    expect(geo?.precision).toBe("house");
    expect(calls.filter(isNominatim)).toHaveLength(1);
  });
});

// ── With a key: the bulk path ───────────────────────────────────────────────

describe("with GEOCODIO_API_KEY set, the bulk path is one batch request", () => {
  beforeEach(() => vi.stubEnv("GEOCODIO_API_KEY", KEY));

  const ROWS = [
    { street: "1 First St", city: "Austin", region: "TX", postal_code: "78701" },
    { street: "2 Second St", city: "Austin", region: "TX", postal_code: "78702" },
    { street: "", city: "" }, // no address: skipped, not sent
    { street: "3 Third St", city: "Austin", region: "TX", postal_code: "78703" },
    { street: "4 Fourth St", city: "Austin", region: "TX", postal_code: "78704" },
    { street: "5 Fifth St", city: "Austin", region: "TX", postal_code: "78705" },
  ];

  // Each sent address answered with a point that encodes which address it
  // was, so a misaligned mapping is visible in the coordinates.
  const TYPES = ["rooftop", "range_interpolation", "street_center", "place", "rooftop"];
  function batchAnswer(sent: string[]) {
    return {
      results: sent.map((query, i) => ({
        query,
        response: single({ lat: 30 + i, lng: -97 - i, accuracy: 0.95, accuracy_type: TYPES[i] }),
      })),
    };
  }

  it("sends every address in ONE POST and maps the answers back to the right rows", async () => {
    geocodio = (c) => json(batchAnswer(JSON.parse(c.body ?? "[]")));
    const geos = await settle(geocodeAddresses(ROWS));

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe("https://api.geocod.io/v1.7/geocode");
    expect(url.searchParams.get("api_key")).toBe(KEY);
    expect(JSON.parse(calls[0].body ?? "")).toEqual([
      "1 First St, Austin, TX, 78701",
      "2 Second St, Austin, TX, 78702",
      "3 Third St, Austin, TX, 78703",
      "4 Fourth St, Austin, TX, 78704",
      "5 Fifth St, Austin, TX, 78705",
    ]);

    expect(geos).toEqual([
      { latitude: 30, longitude: -97, precision: "house" },
      { latitude: 31, longitude: -98, precision: "house" },
      null,
      { latitude: 32, longitude: -99, precision: "street" },
      { latitude: 33, longitude: -100, precision: "area" },
      { latitude: 34, longitude: -101, precision: "house" },
    ]);
    expect(calls.some(isNominatim)).toBe(false);
  });

  it("a row Geocodio errors on falls back to Nominatim; a non-US/CA row is rejected", async () => {
    geocodio = (c) => {
      const sent: string[] = JSON.parse(c.body ?? "[]");
      const body = batchAnswer(sent);
      body.results[1].response = { error: "Could not parse address" } as never;
      body.results[3].response = single({
        lat: 19.4326,
        lng: -99.1332,
        accuracy: 1,
        accuracy_type: "rooftop",
        country: "MX",
      });
      return json(body);
    };
    const geos = await settle(geocodeAddresses(ROWS));
    expect(geos[0]).toEqual({ latitude: 30, longitude: -97, precision: "house" });
    expect(geos[1]).toEqual({ latitude: 40.0001, longitude: -75.0001, precision: "house" }); // Nominatim
    expect(geos[2]).toBeNull();
    expect(geos[3]).toEqual({ latitude: 32, longitude: -99, precision: "street" });
    expect(geos[4]).toBeNull(); // the MX answer, rejected
    expect(geos[5]).toEqual({ latitude: 34, longitude: -101, precision: "house" });

    expect(calls.filter(isGeocodio)).toHaveLength(1);
    const nominatimCalls = calls.filter(isNominatim);
    expect(nominatimCalls).toHaveLength(1);
    expect(new URL(nominatimCalls[0].url).searchParams.get("q")).toBe(
      "2 Second St, Austin, TX, 78702",
    );
  });

  it("a whole batch that fails falls back to Nominatim row by row, without the key in the log", async () => {
    geocodio = () => json({ error: `Invalid API key: ${KEY}` }, 403);
    const geos = await settle(geocodeAddresses(ROWS));
    expect(geos.map((g) => g?.precision ?? null)).toEqual([
      "house",
      "house",
      null,
      "house",
      "house",
      "house",
    ]);
    expect(calls.filter(isGeocodio)).toHaveLength(1);
    expect(calls.filter(isNominatim)).toHaveLength(5);
    expect(logged.some((l) => l.includes("403") && l.includes("[redacted]"))).toBe(true);
  });

  it("a batch that answers a different row count is not trusted", async () => {
    geocodio = (c) => {
      const body = batchAnswer(JSON.parse(c.body ?? "[]"));
      body.results.pop();
      return json(body);
    };
    const geos = await settle(geocodeAddresses(ROWS));
    expect(calls.filter(isNominatim)).toHaveLength(5);
    expect(geos.every((g, i) => (i === 2 ? g === null : g?.latitude === 40.0001))).toBe(true);
  });

  it("a batch row whose query is not the address sent is not attached to that row", async () => {
    geocodio = (c) => {
      const body = batchAnswer(JSON.parse(c.body ?? "[]"));
      // Rows 0 and 1 swapped in the reply.
      [body.results[0], body.results[1]] = [body.results[1], body.results[0]];
      return json(body);
    };
    const geos = await settle(geocodeAddresses(ROWS));
    expect(geos[0]?.latitude).toBe(40.0001); // Nominatim, not row 1's point
    expect(geos[1]?.latitude).toBe(40.0001);
    expect(geos[3]).toEqual({ latitude: 32, longitude: -99, precision: "street" });
  });
});
