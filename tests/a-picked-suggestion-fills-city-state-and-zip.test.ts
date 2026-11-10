// #805 — picking an address suggestion left City, State and ZIP blank.
//
// Live on 2026-11-09 (app.houndstack.com, a22d9e06): on /clients/new, typing
// `2000 Brush St` offered `2000 Brush Street Detroit, MI, USA`. Picking it
// left the Street field as typed and City / State / ZIP empty, and the owner
// was stuck at "Please fill in Street, City, State, and ZIP to continue."
//
// The pick was REFUSED: the provider read Google's address components with no
// second source, so a place missing one component (the house number, for an
// address Google interpolates; or the postal_code) failed the #783
// all-or-nothing gate and nothing was applied. These tests drive the real
// provider with mocked Places payloads — vitest runs in node here, with no
// jsdom — and then the real pickOutcome, which is the one decision the
// component makes about a resolved pick.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googlePlacesProvider } from "@/lib/address/google-places.server";
import {
  addressFromPlace,
  formatAddressLine,
  normalizeStreetName,
  parseFormattedAddress,
} from "@/lib/address/from-place";
import { pickOutcome } from "@/lib/address/pick";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** The row QA picked. */
const BRUSH_ROW = { mainText: "2000 Brush Street", secondaryText: "Detroit, MI, USA" };

function stubDetails(body: unknown) {
  const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => Response.json(body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Resolve through the provider, then apply through the same gate the
 *  component uses. Returns the parts the form ends up holding. */
async function pickThroughProvider(
  body: unknown,
  suggestion: { mainText: string; secondaryText: string } = BRUSH_ROW,
) {
  stubDetails(body);
  const details = await googlePlacesProvider.details("place-brush", {
    sessionToken: "session-token-1",
    suggestion,
  });
  const outcome = pickOutcome({ details, textAtPick: "2000 Brush St", textNow: "2000 Brush St" });
  return { details, outcome };
}

beforeEach(() => {
  vi.stubEnv("GOOGLE_PLACES_API_KEY", "test-key");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("(a) normal components fill street, city, state and ZIP", () => {
  it("2000 Brush St, Detroit, MI 48226", async () => {
    const { outcome } = await pickThroughProvider({
      addressComponents: [
        { longText: "2000", shortText: "2000", types: ["street_number"] },
        { longText: "Brush Street", shortText: "Brush St", types: ["route"] },
        { longText: "Downtown", shortText: "Downtown", types: ["neighborhood", "political"] },
        { longText: "Detroit", shortText: "Detroit", types: ["locality", "political"] },
        {
          longText: "Wayne County",
          shortText: "Wayne County",
          types: ["administrative_area_level_2", "political"],
        },
        {
          longText: "Michigan",
          shortText: "MI",
          types: ["administrative_area_level_1", "political"],
        },
        { longText: "United States", shortText: "US", types: ["country", "political"] },
        { longText: "48226", shortText: "48226", types: ["postal_code"] },
      ],
      location: { latitude: 42.34, longitude: -83.045 },
      formattedAddress: "2000 Brush St, Detroit, MI 48226, USA",
    });
    expect(outcome).toEqual({
      kind: "replace",
      parts: {
        street: "2000 Brush Street",
        unit: "",
        city: "Detroit",
        region: "MI",
        postalCode: "48226",
        latitude: 42.34,
        longitude: -83.045,
      },
    });
  });

  it("a place with no house-number component — an interpolated address — still fills every field", async () => {
    // The shape that was refused live: the components describe the street.
    const { outcome } = await pickThroughProvider({
      addressComponents: [
        { longText: "Brush Street", shortText: "Brush St", types: ["route"] },
        { longText: "Detroit", shortText: "Detroit", types: ["locality", "political"] },
        { longText: "Michigan", shortText: "MI", types: ["administrative_area_level_1"] },
        { longText: "United States", shortText: "US", types: ["country"] },
        { longText: "48201", shortText: "48201", types: ["postal_code"] },
      ],
      location: { latitude: 42.345, longitude: -83.05 },
      formattedAddress: "Brush St, Detroit, MI 48201, USA",
    });
    expect(outcome.kind).toBe("replace");
    if (outcome.kind !== "replace") return;
    expect(outcome.parts).toMatchObject({
      street: "2000 Brush Street",
      city: "Detroit",
      region: "MI",
      postalCode: "48201",
    });
  });

  it("the legacy long_name / short_name shape maps the same way", () => {
    const d = addressFromPlace({
      addressComponents: [
        { long_name: "1", short_name: "1", types: ["street_number"] },
        { long_name: "Woodward Avenue", short_name: "Woodward Ave", types: ["route"] },
        { long_name: "Detroit", short_name: "Detroit", types: ["locality"] },
        { long_name: "Michigan", short_name: "MI", types: ["administrative_area_level_1"] },
        { long_name: "48226", short_name: "48226", types: ["postal_code"] },
      ],
    });
    expect(d).toMatchObject({
      street: "1 Woodward Avenue",
      city: "Detroit",
      region: "MI",
      postalCode: "48226",
      formatted: "1 Woodward Avenue, Detroit, MI 48226",
    });
  });
});

describe("the picked row only supplies a street line that names the place's own route", () => {
  const ROUTE_ONLY = {
    addressComponents: [
      { longText: "Woodward Avenue", shortText: "Woodward Ave", types: ["route"] },
      { longText: "Detroit", types: ["locality"] },
      { longText: "Michigan", shortText: "MI", types: ["administrative_area_level_1"] },
      { longText: "48226", types: ["postal_code"] },
    ],
    location: { latitude: 42.33, longitude: -83.04 },
    formattedAddress: "Woodward Ave, Detroit, MI 48226, USA",
  };

  it("a row naming a different street is not used, and the pick is refused rather than mixed", async () => {
    // The row is sent from the browser, so it cannot vouch for a street the
    // place itself does not have.
    expect(addressFromPlace({ ...ROUTE_ONLY, suggestion: BRUSH_ROW }).street).toBe("");
    const { details, outcome } = await pickThroughProvider(ROUTE_ONLY, BRUSH_ROW);
    expect(details).toBeNull();
    expect(outcome).toEqual({ kind: "keep-typed", reason: "failed" });
  });

  it("a numbered pick that resolves to a bare street is refused, not saved without its number", () => {
    const d = addressFromPlace({
      ...ROUTE_ONLY,
      suggestion: { mainText: "77 Woodward Way", secondaryText: "Detroit, MI, USA" },
    });
    expect(d.street).toBe("");
  });

  it("a row naming the same street, spelled differently, is used", () => {
    const d = addressFromPlace({
      ...ROUTE_ONLY,
      suggestion: { mainText: "1 Woodward Ave.", secondaryText: "Detroit, MI, USA" },
    });
    expect(d.street).toBe("1 Woodward Ave.");
  });

  it("St / Street, Ave / Avenue and directionals normalise to one spelling", () => {
    expect(normalizeStreetName("Brush Street")).toBe(normalizeStreetName("brush st."));
    expect(normalizeStreetName("W Grand Boulevard")).toBe(normalizeStreetName("West Grand Blvd"));
    expect(normalizeStreetName("Brush St")).not.toBe(normalizeStreetName("Woodward Ave"));
  });
});

describe("(b) missing postal_code falls back to the formatted address", () => {
  it("ZIP is read from formattedAddress when there is no postal_code component", async () => {
    const { outcome } = await pickThroughProvider({
      addressComponents: [
        { longText: "2000", types: ["street_number"] },
        { longText: "Brush Street", types: ["route"] },
        { longText: "Detroit", types: ["locality"] },
        { longText: "Michigan", shortText: "MI", types: ["administrative_area_level_1"] },
      ],
      location: { latitude: 42.34, longitude: -83.045 },
      formattedAddress: "2000 Brush St, Detroit, MI 48226, USA",
    });
    expect(outcome.kind).toBe("replace");
    if (outcome.kind !== "replace") return;
    expect(outcome.parts).toMatchObject({
      street: "2000 Brush Street",
      city: "Detroit",
      region: "MI",
      postalCode: "48226",
    });
  });

  it("with no ZIP anywhere it fills what it can — and the pick is still refused, all or nothing (#783)", async () => {
    const body = {
      addressComponents: [
        { longText: "2000", types: ["street_number"] },
        { longText: "Brush Street", types: ["route"] },
        { longText: "Detroit", types: ["locality"] },
        { longText: "Michigan", shortText: "MI", types: ["administrative_area_level_1"] },
      ],
      formattedAddress: "2000 Brush St, Detroit, MI, USA",
    };
    expect(addressFromPlace(body)).toMatchObject({
      street: "2000 Brush Street",
      city: "Detroit",
      region: "MI",
      postalCode: "",
    });
    const { details, outcome } = await pickThroughProvider(body);
    expect(details).toBeNull();
    expect(outcome).toEqual({ kind: "keep-typed", reason: "failed" });
  });
});

describe("(c) formatted address only — no usable components", () => {
  it("parses street, city, state and ZIP out of formattedAddress", async () => {
    const { outcome } = await pickThroughProvider({
      addressComponents: [],
      location: { latitude: 42.34, longitude: -83.045 },
      formattedAddress: "2000 Brush St, Detroit, MI 48226, USA",
    });
    expect(outcome.kind).toBe("replace");
    if (outcome.kind !== "replace") return;
    expect(outcome.parts).toMatchObject({
      street: "2000 Brush St",
      city: "Detroit",
      region: "MI",
      postalCode: "48226",
      latitude: 42.34,
      longitude: -83.045,
    });
  });

  it("parses the shapes Google and people actually produce", () => {
    expect(parseFormattedAddress("2000 Brush St, Detroit, MI 48226, USA")).toEqual({
      street: "2000 Brush St",
      unit: "",
      city: "Detroit",
      region: "MI",
      postalCode: "48226",
    });
    // The suggestion row as displayed: no comma between street and city.
    expect(parseFormattedAddress("2000 Brush Street Detroit, MI, USA")).toEqual({
      street: "2000 Brush Street",
      unit: "",
      city: "Detroit",
      region: "MI",
      postalCode: "",
    });
    expect(parseFormattedAddress("100 Main St, Apt 4, Lansing, Michigan 48933-1234")).toEqual({
      street: "100 Main St",
      unit: "Apt 4",
      city: "Lansing",
      region: "MI",
      postalCode: "48933-1234",
    });
    expect(parseFormattedAddress("12 Oak Ave, Ann Arbor MI 48104")).toMatchObject({
      street: "12 Oak Ave",
      city: "Ann Arbor",
      region: "MI",
      postalCode: "48104",
    });
    expect(parseFormattedAddress("")).toEqual({
      street: "",
      unit: "",
      city: "",
      region: "",
      postalCode: "",
    });
  });
});

describe("the fix is in the shared path every address field uses", () => {
  it("the provider maps through addressFromPlace and still gates on isCompletePick", () => {
    const src = read("src/lib/address/google-places.server.ts");
    expect(src).toMatch(/addressFromPlace\(/);
    expect(src).toMatch(/isCompletePick\(details\)/);
  });

  it("the control sends the picked row to the server, so the street line can come from it", () => {
    const control = read("src/components/AddressAutocomplete.tsx");
    expect(control).toMatch(/mainText:\s*s\.mainText/);
    const fns = read("src/lib/address.functions.ts");
    expect(fns).toMatch(/suggestion:/);
  });

  it("the server still matches the zone off the resolved ZIP", () => {
    const fns = read("src/lib/address.functions.ts");
    const resolve = fns.slice(fns.indexOf("export const resolveAddress"));
    expect(resolve).toMatch(/postalCode:\s*details\.postalCode/);
  });
});

describe("the saved and shown address keeps the state", () => {
  it("Street, City, ST ZIP", () => {
    expect(
      formatAddressLine({
        street: "2000 Brush St",
        city: "Detroit",
        region: "MI",
        postal_code: "48201",
      }),
    ).toBe("2000 Brush St, Detroit, MI 48201");
    expect(
      formatAddressLine({
        street: "2000 Brush St",
        unit: "Apt 2",
        city: "Detroit",
        postalCode: "48201",
      }),
    ).toBe("2000 Brush St, Apt 2, Detroit, 48201");
  });

  it("the property list, the directions links and the activity summary use it", () => {
    for (const f of [
      "src/components/client-detail/PropertiesTab.tsx",
      "src/components/client-detail/ClientHeader.tsx",
      "src/lib/properties.functions.ts",
    ]) {
      const src = read(f);
      expect(src, f).toMatch(/formatAddressLine\(/);
      // The shape that dropped the state.
      expect(src, f).not.toMatch(/\$\{\w+\.city\} \$\{\w+\.(postal_code|postalCode)\}/);
    }
  });
});
