// #617 review, B1: an import saves an address with no map pin when the
// geocoding budget runs out, and with no pin only a ZIP-code zone can match
// it. "Geocode addresses" on the Routes page found the pin later and wrote the
// coordinates only, so a property in a radius or drawn zone stayed zoneless
// for good. Now the pin brings the zone with it, by the rule an address edit
// follows: an override keeps its zone, an off zone keeps its properties.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { fakePostgrest, type Seen } from "./support/fake-postgrest";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const b: any = {
      middleware: () => b,
      inputValidator: (v: (d: unknown) => unknown) => {
        b.validate = v;
        return b;
      },
      handler: (h: any) => (input: any) =>
        h({
          data: b.validate ? b.validate(input?.data) : input?.data,
          context: { supabase: state.supabase, userId: "owner" },
        }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/activity.server", () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock("@/lib/geocode.server", () => ({
  // Every address is found, at the middle of the radius zone below, by
  // Google -- so the pin is stored with its source and time (#745).
  geocodeAddressesSourced: vi.fn(async (list: unknown[]) =>
    list.map(() => ({
      point: { latitude: 41.9, longitude: -87.65, precision: "house" },
      source: "google",
    })),
  ),
}));

/** What a found pin carries besides its zone (20261109200000). */
const PIN = {
  latitude: 41.9,
  longitude: -87.65,
  geocode_source: "google",
  geocoded_at: expect.any(String),
};

const state = vi.hoisted(() => ({ supabase: null as any }));

import { backfillPropertyGeocodes } from "@/lib/properties.functions";
import { logActivity } from "@/lib/activity.server";

const RADIUS = "aaaaaaaa-0000-4000-8000-000000000001";
const OFF = "aaaaaaaa-0000-4000-8000-000000000002";
const CHOSEN = "aaaaaaaa-0000-4000-8000-000000000003";

function zone(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    organization_id: "org",
    priority: 0,
    account_type: null,
    postal_prefix: null,
    zip_codes: null,
    geo_match_mode: "radius",
    boundary: null,
    center_latitude: 41.9,
    center_longitude: -87.65,
    radius_meters: 5_000,
    drive_time_minutes: null,
    enabled: true,
    ...extra,
  };
}

function property(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    organization_id: "org",
    client_id: "c1",
    street: `${id} Oak St`,
    city: "Chicago",
    region: "IL",
    // A ZIP no zone lists: only the pin can place it.
    postal_code: "99999",
    account_type: null,
    latitude: null,
    longitude: null,
    auto_zone_id: null,
    zone_id: null,
    zone_override_reason: null,
    ...extra,
  };
}

let seen: Seen[];
let tables: Record<string, any[]>;
function use(t: Record<string, any[]>) {
  seen = [];
  tables = t;
  state.supabase = createClient("https://abcdefghijklmnopqrst.supabase.co", "anon-key", {
    global: {
      fetch: fakePostgrest(t, { properties: { clients: "^client_id" } }, seen) as typeof fetch,
    },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
const patchFor = (id: string) =>
  seen.find(
    (s) => s.method === "PATCH" && s.table === "properties" && s.url.includes(`id=eq.${id}`),
  )?.body;

beforeEach(() => vi.mocked(logActivity).mockClear());

describe("a pin found after an import", () => {
  it("places a zoneless property with no override in the zone the pin is in", async () => {
    use({
      properties: [property("p1")],
      zones: [zone(RADIUS)],
      clients: [{ id: "c1", account_type: "residential" }],
    });
    const r = await backfillPropertyGeocodes({ data: {} });
    expect(patchFor("p1")).toEqual({
      ...PIN,
      auto_zone_id: RADIUS,
      zone_id: RADIUS,
    });
    expect(r).toMatchObject({ updated: 1, rezoned: 1 });
    expect(logActivity).toHaveBeenCalledTimes(1);
  });

  it("keeps a manual override, refreshing only the detected zone", async () => {
    use({
      properties: [property("p2", { zone_id: CHOSEN, zone_override_reason: "Owner moved it" })],
      zones: [zone(RADIUS), zone(CHOSEN, { center_latitude: 10, center_longitude: 10 })],
      clients: [{ id: "c1", account_type: "residential" }],
    });
    const r = await backfillPropertyGeocodes({ data: {} });
    expect(patchFor("p2")).toEqual({ ...PIN, auto_zone_id: RADIUS });
    expect(r).toMatchObject({ updated: 1, rezoned: 0 });
  });

  it("leaves a property in a zone that is turned off where it is", async () => {
    use({
      properties: [property("p3", { zone_id: OFF, auto_zone_id: OFF })],
      zones: [zone(RADIUS), zone(OFF, { enabled: false })],
      clients: [{ id: "c1", account_type: "residential" }],
    });
    await backfillPropertyGeocodes({ data: {} });
    expect(patchFor("p3")).toEqual(PIN);
  });

  it("saves the pin and leaves the zone alone when the zones cannot be read", async () => {
    use({
      properties: [property("p4", { zone_id: CHOSEN, auto_zone_id: CHOSEN })],
      clients: [{ id: "c1", account_type: "residential" }],
      zones: [],
    });
    // The zones read fails; everything else goes to the fake.
    const real = state.supabase.from.bind(state.supabase);
    state.supabase.from = (t: string) =>
      t === "zones"
        ? {
            select: () => ({
              eq: async () => ({ data: null, error: { message: "statement timeout" } }),
            }),
          }
        : real(t);
    const r = await backfillPropertyGeocodes({ data: {} });
    expect(patchFor("p4")).toEqual(PIN);
    expect(r).toMatchObject({ updated: 1, rezoned: 0, zonesUnread: 1 });
  });
});
