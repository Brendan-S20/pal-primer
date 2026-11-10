// #783 — an address is saved as typed, or as picked. Never half of each.
//
// Onboarding QA on 2026-11-09, a new business at 100 Test St, Lansing, MI:
//
//   - typing `200 Test Ave` into the first client's address offered Richmond
//     IN, York PA, Bellefonte PA, Waynesville NC, Council Bluffs IA — nothing
//     near Lansing;
//   - `200 Test Ave, Lansing, MI 48933` was saved as `200 Test Road,
//     Richmond 48933` — a far-away suggestion's street and city on the
//     typed ZIP;
//   - setup step 1's Business address box offered nothing at all for a
//     whole typed address.
//
// The four groups below are the issue's acceptance (a)–(d). Pure functions
// and a stubbed `fetch`, because vitest runs in node here with no jsdom (see
// an-address-field-that-only-works-when-google-does.test.ts for the same
// constraint). The component itself takes every decision through these
// functions, and the last group pins that it does.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enterPicks,
  isCompletePick,
  partsFromPick,
  pickOutcome,
  searchQuery,
} from "@/lib/address/pick";
import {
  nearBusinessFirst,
  serviceAreaCenter,
  SERVICE_RADIUS_METERS,
} from "@/lib/address/near-business";
import { googlePlacesProvider, looksLikeFullAddress } from "@/lib/address/google-places.server";
import { workspaceBias } from "@/lib/address.functions";
import type { AddressDetails } from "@/lib/address/provider.server";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** The parts of a Places autocomplete request body these tests read. */
interface PlacesBody {
  origin?: unknown;
  locationBias?: { circle: { center: unknown } };
  includedPrimaryTypes?: string[];
  includedRegionCodes?: string[];
}

const LANSING = { latitude: 42.7325, longitude: -84.5555 };

/** The suggestion QA was shown, resolved. */
const RICHMOND: AddressDetails = {
  street: "200 Test Road",
  unit: null,
  city: "Richmond",
  region: "IN",
  postalCode: "47374",
  latitude: 39.8289,
  longitude: -84.8902,
  formatted: "200 Test Rd, Richmond, IN 47374, USA",
};

describe("(a) picking a suggestion replaces EVERY address part", () => {
  it("street, unit, city, state, ZIP and the pin all come from the pick", () => {
    expect(partsFromPick({ ...RICHMOND, unit: "Apt 2" })).toEqual({
      street: "200 Test Road",
      unit: "Apt 2",
      city: "Richmond",
      region: "IN",
      postalCode: "47374",
      latitude: 39.8289,
      longitude: -84.8902,
    });
  });

  it("a part the pick does not carry is cleared, not left as typed", () => {
    const parts = partsFromPick({ ...RICHMOND, unit: null, latitude: null, longitude: null });
    expect(parts.unit).toBe("");
    expect(parts.latitude).toBeNull();
    expect(parts.longitude).toBeNull();
  });

  it("a complete pick, resolved while the field still says what it said, replaces", () => {
    const out = pickOutcome({
      details: RICHMOND,
      textAtPick: "200 Test Ave",
      textNow: "200 Test Ave",
    });
    expect(out).toEqual({ kind: "replace", parts: partsFromPick(RICHMOND) });
  });

  it("a pick missing ANY part is not applied — it would have to borrow that part from what was typed", () => {
    for (const missing of ["street", "city", "region", "postalCode"] as const) {
      const partial = { ...RICHMOND, [missing]: missing === "region" ? null : "" };
      expect(isCompletePick(partial), missing).toBe(false);
      expect(
        pickOutcome({ details: partial, textAtPick: "200 Test Ave", textNow: "200 Test Ave" }),
        missing,
      ).toEqual({ kind: "keep-typed", reason: "incomplete" });
    }
  });

  it("the Google provider refuses an incomplete match at the source", async () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", "test-key");
    const fetchMock = vi.fn(async () =>
      Response.json({
        addressComponents: [
          { longText: "200", types: ["street_number"] },
          { longText: "Test Road", types: ["route"] },
          { longText: "Richmond", types: ["locality"] },
          { longText: "47374", types: ["postal_code"] },
          // no administrative_area_level_1: no state
        ],
        location: { latitude: 39.8, longitude: -84.9 },
        formattedAddress: "200 Test Rd, Richmond 47374",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await googlePlacesProvider.details("place-1")).toBeNull();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("both forms that hold an address as parts take them from the one helper", () => {
    const wizard = read("src/routes/_authenticated/clients.new.tsx");
    const fn = wizard.slice(wizard.indexOf("function applyResolvedAddress"));
    const body = fn.slice(0, fn.indexOf("\n  }\n"));
    expect(body).toMatch(/partsFromPick\(r\.address\)/);
    // The line that kept a typed state under a suggestion's city.
    expect(body).not.toMatch(/if \(r\.address\.region\)/);
    expect(body).toMatch(/setRegion\(parts\.region\)/);

    const drawer = read("src/components/client-detail/PropertyDrawer.tsx");
    expect(drawer).toMatch(/partsFromPick\(r\.address\)/);
  });
});

describe("(b) a fully typed address with no pick is saved as typed", () => {
  it("a failed lookup keeps the typed text — no suggestion street written over it", () => {
    expect(
      pickOutcome({ details: null, textAtPick: "200 Test Ave", textNow: "200 Test Ave" }),
    ).toEqual({ kind: "keep-typed", reason: "failed" });
  });

  it("a pick that lands after the person kept typing loses to the typing", () => {
    expect(
      pickOutcome({
        details: RICHMOND,
        textAtPick: "200 Test Ave",
        textNow: "200 Test Ave, Lansing, MI 48933",
      }),
    ).toEqual({ kind: "keep-typed", reason: "typed-since" });
  });

  it("Enter does not pick a row that only a resting mouse pointer lit", () => {
    expect(enterPicks({ active: 0, activeByKeyboard: false })).toBe(false);
    expect(enterPicks({ active: -1, activeByKeyboard: true })).toBe(false);
    expect(enterPicks({ active: 2, activeByKeyboard: true })).toBe(true);
  });

  it("the control applies a pick only through pickOutcome, and never writes a suggestion's text on failure", () => {
    const src = read("src/components/AddressAutocomplete.tsx");
    const select = src.slice(
      src.indexOf("async function select("),
      src.indexOf("function onKeyDown("),
    );
    // The old failure branch: `onChangeText(s.mainText)` put the suggestion's
    // street line in the box and left the typed city and ZIP beside it.
    expect(select).not.toMatch(/onChangeText\(/);
    expect(select).toMatch(/pickOutcome\(/);
    expect(select).toMatch(/outcome\.kind === "replace"[^\n]*onResolved\(/);
    // Exactly one call to onResolved in the whole file, and it is that one.
    expect(src.match(/onResolved\(/g)?.length).toBe(1);
  });

  it("the list closes when focus leaves, so it cannot sit over City/State/ZIP", () => {
    const src = read("src/components/AddressAutocomplete.tsx");
    const blur = src.slice(src.indexOf("onBlur={() => {"));
    expect(blur.slice(0, blur.indexOf("}}"))).toMatch(/setOpen\(false\)/);
    expect(src).toMatch(/setOpen\(focused\.current && /);
  });

  it("Enter goes through enterPicks", () => {
    const src = read("src/components/AddressAutocomplete.tsx");
    expect(src).toMatch(/e\.key === "Enter"\) \{\s*if \(enterPicks\(/);
  });
});

describe("(c) suggestions are biased and fenced to the business's area", () => {
  it("the business's own location leads, ahead of properties and zones", () => {
    expect(
      serviceAreaCenter({
        business: LANSING,
        properties: [{ latitude: 10, longitude: 10 }],
        zones: [{ center_latitude: 20, center_longitude: 20 }],
      }),
    ).toEqual(LANSING);
  });

  it("a NEW business — no properties, a zone with no centre — still has a centre", () => {
    expect(
      serviceAreaCenter({
        business: { latitude: "42.7325", longitude: "-84.5555" },
        properties: [],
        zones: [{ center_latitude: null, center_longitude: null }],
      }),
    ).toEqual(LANSING);
  });

  it("falls back to properties, then zones, and to null when nothing is known", () => {
    expect(
      serviceAreaCenter({
        business: { latitude: null, longitude: null },
        properties: [
          { latitude: 42, longitude: -84 },
          { latitude: 44, longitude: -86 },
        ],
      }),
    ).toEqual({ latitude: 43, longitude: -85 });
    expect(
      serviceAreaCenter({ zones: [{ center_latitude: 42.7, center_longitude: -84.5 }] }),
    ).toEqual({ latitude: 42.7, longitude: -84.5 });
    expect(serviceAreaCenter({ business: { latitude: 0, longitude: 0 } })).toBeNull();
  });

  it("workspaceBias asks the organization row first", async () => {
    const asked: string[] = [];
    const supabase = {
      from(table: string) {
        asked.push(table);
        const rows: Record<string, unknown> = {
          organizations: { latitude: LANSING.latitude, longitude: LANSING.longitude },
          properties: [],
          zones: [],
        };
        const q: Record<string, unknown> = {
          select: () => q,
          eq: () => q,
          not: () => q,
          limit: async () => ({ data: rows[table] }),
          maybeSingle: async () => ({ data: rows[table] }),
        };
        return q;
      },
    };
    expect(await workspaceBias(supabase, `org-${Math.random()}`)).toEqual(LANSING);
    expect(asked).toEqual(["organizations"]);
  });

  it("QA's list for `200 Test Ave`: every far-away hit is dropped, the near one leads", () => {
    const qa = [
      { id: "richmond", distanceMeters: 300_000 },
      { id: "york", distanceMeters: 700_000 },
      { id: "bellefonte", distanceMeters: 560_000 },
      { id: "waynesville", distanceMeters: 900_000 },
      { id: "council-bluffs", distanceMeters: 950_000 },
      { id: "east-lansing", distanceMeters: 6_000 },
      { id: "okemos", distanceMeters: 2_000 },
    ];
    expect(nearBusinessFirst(qa, { centerKnown: true }).map((s) => s.id)).toEqual([
      "okemos",
      "east-lansing",
    ]);
  });

  it("the edge of the radius is in, a metre past it is out; unmeasured rows are kept, last", () => {
    const out = nearBusinessFirst(
      [
        { id: "unknown", distanceMeters: null },
        { id: "edge", distanceMeters: SERVICE_RADIUS_METERS },
        { id: "past", distanceMeters: SERVICE_RADIUS_METERS + 1 },
      ],
      { centerKnown: true },
    );
    expect(out.map((s) => s.id)).toEqual(["edge", "unknown"]);
  });

  it("with no centre known, the provider's order stands untouched", () => {
    const list = [{ id: "a", distanceMeters: 900_000 }, { id: "b" }];
    expect(nearBusinessFirst(list, { centerKnown: false })).toBe(list);
  });

  describe("the Google request carries the centre", () => {
    beforeEach(() => vi.stubEnv("GOOGLE_PLACES_API_KEY", "test-key"));
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    it("as a location bias AND an origin, and reads back each distance", async () => {
      const bodies: PlacesBody[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit) => {
          bodies.push(JSON.parse(String(init.body)));
          return Response.json({
            suggestions: [
              {
                placePrediction: {
                  placeId: "p1",
                  distanceMeters: 1234,
                  types: ["street_address", "geocode"],
                  structuredFormat: {
                    mainText: { text: "200 Test Ave" },
                    secondaryText: { text: "Lansing, MI, USA" },
                  },
                },
              },
            ],
          });
        }),
      );
      const out = await googlePlacesProvider.autocomplete("200 Test Ave", { bias: LANSING });
      expect(bodies[0].origin).toEqual(LANSING);
      expect(bodies[0].locationBias.circle.center).toEqual(LANSING);
      expect(out[0]).toMatchObject({ id: "p1", distanceMeters: 1234 });
    });
  });

  it("the server function ranks and fences before answering, and sends no distance to the browser", () => {
    const src = read("src/lib/address.functions.ts");
    const fn = src.slice(src.indexOf("export const autocompleteAddress"));
    const body = fn.slice(0, fn.indexOf("export const resolveAddress"));
    expect(body).toMatch(/nearBusinessFirst\(raw, \{ centerKnown: !!bias \}\)/);
    expect(body).toMatch(
      /\(\{ id, mainText, secondaryText \}\) => \(\{ id, mainText, secondaryText \}\)/,
    );
  });
});

describe("(d) setup step 1: a whole typed business address gets suggestions", () => {
  const FULL = "100 Test St, Lansing, MI 48933";

  beforeEach(() => vi.stubEnv("GOOGLE_PLACES_API_KEY", "test-key"));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("knows a whole address from a street line", () => {
    expect(looksLikeFullAddress(FULL)).toBe(true);
    expect(looksLikeFullAddress("100 Test St 48933")).toBe(true);
    expect(looksLikeFullAddress("200 Test Ave")).toBe(false);
    expect(looksLikeFullAddress("Lansing, MI")).toBe(false);
  });

  it("an empty answer under the address-type restriction is asked again without it", async () => {
    const bodies: PlacesBody[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        if (body.includedPrimaryTypes) return Response.json({});
        return Response.json({
          suggestions: [
            {
              placePrediction: {
                placeId: "addr",
                types: ["geocode"],
                structuredFormat: {
                  mainText: { text: "100 Test St" },
                  secondaryText: { text: "Lansing, MI 48933, USA" },
                },
              },
            },
            {
              // A business is not an address a form can be filled from.
              placePrediction: {
                placeId: "biz",
                types: ["establishment", "point_of_interest"],
                structuredFormat: {
                  mainText: { text: "Test Kitchen" },
                  secondaryText: { text: "Test St, Lansing, MI" },
                },
              },
            },
            {
              placePrediction: {
                placeId: "premise",
                types: ["premise"],
                structuredFormat: {
                  mainText: { text: "Capitol Building" },
                  secondaryText: { text: "Lansing, MI" },
                },
              },
            },
          ],
        });
      }),
    );
    const out = await googlePlacesProvider.autocomplete(FULL, {});
    expect(bodies).toHaveLength(2);
    expect(bodies[0].includedPrimaryTypes).toEqual(["street_address", "premise", "subpremise"]);
    expect(bodies[1].includedPrimaryTypes).toBeUndefined();
    expect(bodies[1].includedRegionCodes).toEqual(["us"]);
    expect(out.map((s) => s.id)).toEqual(["addr", "premise"]);
  });

  it("a partial street line is NOT retried loosely — that is how the far-away list grows", async () => {
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    expect(await googlePlacesProvider.autocomplete("200 Test Ave", {})).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a strict answer is used as it is, with no second call", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        suggestions: [
          {
            placePrediction: {
              placeId: "p",
              types: ["street_address"],
              structuredFormat: { mainText: { text: "100 Test St" } },
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect((await googlePlacesProvider.autocomplete(FULL, {})).map((s) => s.id)).toEqual(["p"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a long pasted address is clipped to what the server accepts, not rejected into an empty list", () => {
    const long = `${FULL}, ${"x".repeat(250)}`;
    expect(searchQuery(long).length).toBeLessThanOrEqual(200);
    expect(searchQuery(`  ${FULL}  `)).toBe(FULL);
    const src = read("src/lib/address.functions.ts");
    expect(src).toMatch(/query: z\.string\(\)\.min\(3\)\.max\(200\)/);
  });

  it("the setup step's business address is still the shared combobox", () => {
    const setup = read("src/routes/_authenticated/setup.tsx");
    expect(setup).toMatch(/<AddressAutocomplete\s+id="setup-address"/);
  });
});
