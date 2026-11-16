// Zones > New zone, for a business that has just been through setup (#914).
//
// Found on onboarding QA, 2026-11-12, at "200 Test Ave, Lansing MI 48933",
// with $20 typed into setup's price step (whose save failed, #881):
//
//   * New zone's base price read $25.00 -- a number nobody chose (the drawer's
//     `"25.00"` default, removed by #860, which left a blank field and a
//     standard price that a failed setup never set);
//   * a 1-mile circle round the business said "No ZIP has its center inside
//     the circle. Make it bigger, or add a nearby ZIP below." and showed no
//     chip, although the save then listed one (#858) -- and the business's
//     own ZIP, 48933, had to be typed by hand;
//   * the Zones list showed the new zone only after a reload.
//
// Product acceptance (locked 2026-11-16):
//   1. the visible default is the business's standard visit price, from setup
//      or Services, never a $25 that looks entered; blank still means "use the
//      standard";
//   2. the business or center ZIP is always in the zone, even when its
//      centroid is outside the default 1-mile circle, and the form says so;
//   3. the Zones list updates as soon as Create zone succeeds.
//
// ZIP centers are the real Census rows from the data migration, as in
// tests/a-service-area-fills-its-zips-on-save.test.ts.

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
const ONE_MILE_M = 1609;
const at = (zip: string) => {
  const c = CENSUS.find((x) => x.zip === zip)!;
  return { lat: c.lat, lng: c.lng };
};
const circle = (p: { lat: number; lng: number }, r = ONE_MILE_M) => ({
  mode: "radius",
  centerLat: p.lat,
  centerLng: p.lng,
  radiusMeters: r,
});

const { businessZipFromAddress, newZonePriceDefault, newZoneZips, withCreatedZone } =
  await import("@/lib/new-zone-defaults");
const { classifyZipCentroids, nearestZipToMiddle, fillStatusText, IDLE_FILL } =
  await import("@/lib/zone-zip-fill");

// A business in 48933 whose one-mile circle holds no ZIP's center -- found
// rather than assumed, stepping south from 48933's center (a ZIP 928 m
// across, in a downtown of small ZIPs), as the QA run's circle was.
const LANSING_BUSINESS = (() => {
  const c = at("48933");
  for (let i = 1; i < 100; i++) {
    const p = { lat: c.lat - i * 0.001, lng: c.lng };
    if (classifyZipCentroids(circle(p), CENSUS).insideTotal === 0) return p;
  }
  throw new Error("no empty one-mile circle found near 48933");
})();

// ── 1. The price ──────────────────────────────────────────────────────────

describe("1. a new zone's price is the business's price, never one nobody chose", () => {
  it("with a standard price: the field stays blank and the standard shows through", () => {
    // Blank is "charge the standard" (#860); a copy would stop following it.
    expect(newZonePriceDefault(2000, { price: "35" })).toEqual({
      basePrice: "",
      perDog: "",
      source: "standard",
    });
  });

  it("with no standard yet: the price typed into setup on this device", () => {
    expect(newZonePriceDefault(null, { price: "20", extraDog: "5" })).toEqual({
      basePrice: "20.00",
      perDog: "5.00",
      source: "setup",
    });
    expect(newZonePriceDefault(null, { price: "$19.5", extraDog: "" })).toEqual({
      basePrice: "19.50",
      perDog: "0.00",
      source: "setup",
    });
  });

  it("with neither: blank and said so, never a made-up number", () => {
    for (const draft of [null, undefined, {}, { price: "" }, { price: "abc" }, { price: "0" }]) {
      expect(newZonePriceDefault(null, draft as any)).toEqual({
        basePrice: "",
        perDog: "",
        source: "none",
      });
    }
  });

  it("while the standard is still loading, nothing is filled in", () => {
    expect(newZonePriceDefault(undefined, { price: "20" }).source).toBe("none");
  });

  const drawer = read("src/components/ZoneDrawer.tsx");

  it("the drawer has no hardcoded $25 default, and shows the standard as the placeholder", () => {
    expect(drawer).not.toMatch(/:\s*"25\.00"\s*,?\s*\)/);
    expect(drawer).toMatch(/std\?\.basePriceCents != null \? \(std\.basePriceCents \/ 100\)/);
    expect(drawer).toMatch(/standardPriceLine\(/);
  });

  it("the drawer reads setup's own draft, by setup's own form name, and says where it came from", () => {
    expect(drawer).toMatch(/useSetupAreaPriceDraft\(isNew\)/);
    expect(drawer).toMatch(/newZonePriceDefault\(/);
    expect(drawer).toMatch(/Filled in from the price you entered in setup\./);
    const hook = read("src/hooks/useSetupAreaPriceDraft.ts");
    expect(hook).toMatch(/SETUP_AREA_DRAFT_FORM = "setup-area"/);
    expect(read("src/routes/_authenticated/setup.tsx")).toMatch(/form: "setup-area"/);
    // Read only: the draft is setup's to clear.
    expect(hook).not.toMatch(/saveFormDraft|clearFormDraft/);
  });
});

// ── 2. The business's ZIP ─────────────────────────────────────────────────

describe("2. a circle round the business lists the business's ZIP", () => {
  it("reads the ZIP off a one-line address", () => {
    expect(businessZipFromAddress("200 Test Ave, Lansing MI 48933")).toBe("48933");
    expect(businessZipFromAddress("200 Test Ave, Lansing, MI 48933-1234")).toBe("48933");
    expect(businessZipFromAddress("48933 Main St, Lansing MI 48912")).toBe("48912");
    expect(businessZipFromAddress("48933 Main St, Lansing MI")).toBeNull();
    expect(businessZipFromAddress("Lansing, MI")).toBeNull();
    expect(businessZipFromAddress(null)).toBeNull();
  });

  it("the QA circle: one mile round the business, no ZIP center inside it", () => {
    const shape = circle(LANSING_BUSINESS);
    const c = classifyZipCentroids(shape, CENSUS);
    expect(c.insideTotal).toBe(0);
    // What the save already listed (#858), now also the drawer's chip...
    const centerZip = nearestZipToMiddle(shape, CENSUS);
    expect(centerZip).toBe("48933");
    const out = newZoneZips(shape, c.inside, centerZip, { ...LANSING_BUSINESS, zip: "48933" });
    expect(out.zips).toEqual(["48933"]);
    expect(out.centerZip).toBe("48933");
    // ...and said as what happened, not "add one below".
    const text = fillStatusText(
      { ...IDLE_FILL, status: "done", inside: out.zips, added: 1, centerZip: out.centerZip },
      "the circle",
    );
    expect(text).toBe(
      "No ZIP has its center inside the circle, so the ZIP at its middle, 48933, was added. Make it bigger to add more.",
    );
    expect(text).not.toMatch(/add a nearby ZIP below/);
  });

  it("the circle placed off the business: the middle's ZIP AND the business's", () => {
    // A click a little east of the business, still within a mile of it.
    let found: { shape: ReturnType<typeof circle>; mid: string } | null = null;
    for (let i = 1; i < 40 && !found; i++) {
      const p = { lat: LANSING_BUSINESS.lat, lng: LANSING_BUSINESS.lng + i * 0.001 };
      const shape = circle(p);
      const mid = nearestZipToMiddle(shape, CENSUS);
      if (
        classifyZipCentroids(shape, CENSUS).insideTotal === 0 &&
        mid &&
        mid !== "48933" &&
        newZoneZips(shape, [], null, { ...LANSING_BUSINESS, zip: "48933" }).businessZip
      )
        found = { shape, mid };
    }
    expect(found, "no such click near the Lansing business").not.toBeNull();
    const out = newZoneZips(found!.shape, [], found!.mid, { ...LANSING_BUSINESS, zip: "48933" });
    expect(out.zips).toEqual([found!.mid, "48933"]);
    expect(
      fillStatusText(
        {
          ...IDLE_FILL,
          status: "done",
          added: 2,
          centerZip: out.centerZip,
          businessZip: out.businessZip,
        },
        "the circle",
      ),
    ).toBe(
      `No ZIP has its center inside the circle, so ${found!.mid}, the ZIP at its middle, and 48933, your business's ZIP, were added.`,
    );
  });

  it("a bigger circle that holds other centers but not 48933's still lists 48933", () => {
    // Centered south of the business, far enough that 48933's own center is
    // outside while the business and other ZIP centers are in.
    let shape: ReturnType<typeof circle> | null = null;
    for (let i = 1; i < 200 && !shape; i++) {
      const s = circle({ lat: LANSING_BUSINESS.lat - i * 0.001, lng: LANSING_BUSINESS.lng }, 3200);
      const c = classifyZipCentroids(s, CENSUS);
      const biz = newZoneZips(s, c.inside, null, { ...LANSING_BUSINESS, zip: "48933" });
      if (c.insideTotal > 0 && !c.inside.includes("48933") && biz.businessZip) shape = s;
    }
    expect(shape, "no such circle south of the business").not.toBeNull();
    const c = classifyZipCentroids(shape!, CENSUS);
    const out = newZoneZips(shape!, c.inside, null, { ...LANSING_BUSINESS, zip: "48933" });
    expect(out.zips).toEqual([...c.inside, "48933"]);
    expect(out.centerZip).toBeNull();
    const text = fillStatusText(
      {
        ...IDLE_FILL,
        status: "done",
        inside: out.zips,
        insideTotal: c.insideTotal,
        added: out.zips.length,
        businessZip: "48933",
      },
      "the circle",
    );
    expect(text).toContain(
      `Added ${c.inside.length} ${c.inside.length === 1 ? "ZIP" : "ZIPs"} with a center inside the circle.`,
    );
    expect(text).toContain("Your business's ZIP, 48933, was added too: the business is inside it.");
  });

  it("a circle drawn somewhere else does not claim the business's ZIP", () => {
    const far = circle(at("48226")); // downtown Detroit
    const c = classifyZipCentroids(far, CENSUS);
    const out = newZoneZips(far, c.inside, null, { ...LANSING_BUSINESS, zip: "48933" });
    expect(out.zips).not.toContain("48933");
    expect(out.businessZip).toBeNull();
  });

  it("the drawer applies it only to a new zone's own fills, and says only what went on", () => {
    const drawer = read("src/components/ZoneDrawer.tsx");
    expect(drawer).toMatch(/if \(isNew && !isBaseline\) \{\s*const extra = newZoneZips\(/);
    expect(drawer).toMatch(/if \(businessZip && !r\.added\.includes\(businessZip\)\)/);
  });
});

// ── The server: the lookup and the save ───────────────────────────────────

function fakeDb(org: Record<string, unknown> | null) {
  const inserted: Record<string, any>[] = [];
  const db = {
    inserted,
    rpc: async (name: string, args: any) => {
      if (name !== "zip_centroids_in_box") throw new Error(`unexpected rpc ${name}`);
      const found = CENSUS.filter(
        (c) =>
          c.lat >= args._south &&
          c.lat <= args._north &&
          c.lng >= args._west &&
          c.lng <= args._east,
      )
        .slice(0, args._limit)
        .map((c) => ({ zip: c.zip, lat: c.lat, lng: c.lng, radius_m: c.radiusM }));
      return { data: found, error: null };
    },
    from: (table: string) => {
      let insert: Record<string, any> | null = null;
      const finish = () => {
        if (insert) {
          inserted.push(insert);
          return { data: { id: "zone-new" }, error: null };
        }
        if (table === "organizations") return { data: org, error: null };
        return { data: [], error: null };
      };
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        insert: (row: Record<string, any>) => {
          insert = row;
          return chain;
        },
        single: async () => finish(),
        maybeSingle: async () => finish(),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(finish()).then(res, rej),
      };
      return chain;
    },
  };
  return db;
}

const state = vi.hoisted(() => ({ db: null as any }));
const { createZone } = await import("@/lib/zones.functions");
const { zipsInsideShape } = await import("@/lib/zone-zip-fill.server");

const LANSING_ORG = {
  contact_address: "200 Test Ave, Lansing MI 48933",
  latitude: 0,
  longitude: 0,
};

describe("the server agrees", () => {
  beforeEach(() => {
    state.db = fakeDb({
      ...LANSING_ORG,
      latitude: LANSING_BUSINESS.lat,
      longitude: LANSING_BUSINESS.lng,
    });
  });

  it("the drawer's lookup returns the middle's ZIP when nothing is inside", async () => {
    const r = await zipsInsideShape(state.db, "org-1", circle(LANSING_BUSINESS) as any);
    expect(r.insideTotal).toBe(0);
    expect(r.centerZip).toBe("48933");
    const big = await zipsInsideShape(state.db, "org-1", circle(LANSING_BUSINESS, 8000) as any);
    expect(big.insideTotal).toBeGreaterThan(0);
    expect(big.centerZip).toBeNull();
  });

  it("Create lists the business's ZIP even when it beat the drawer's lookup", async () => {
    // A bigger circle south of the business, whose fill does not hold 48933.
    let shape: ReturnType<typeof circle> | null = null;
    for (let i = 1; i < 200 && !shape; i++) {
      const s = circle({ lat: LANSING_BUSINESS.lat - i * 0.001, lng: LANSING_BUSINESS.lng }, 3200);
      const c = classifyZipCentroids(s, CENSUS);
      const biz = newZoneZips(s, c.inside, null, { ...LANSING_BUSINESS, zip: "48933" });
      if (c.insideTotal > 0 && !c.inside.includes("48933") && biz.businessZip) shape = s;
    }
    expect(shape).not.toBeNull();
    const out: any = await createZone({
      data: {
        name: "Lansing",
        geoMatchMode: "radius",
        centerLatitude: shape!.centerLat,
        centerLongitude: shape!.centerLng,
        radiusMeters: shape!.radiusMeters,
        zipCodes: [],
      },
    } as any);
    expect(state.db.inserted[0].zip_codes).toContain("48933");
    expect(out.businessZipAdded).toBe("48933");
  });

  it("not when the owner removed that chip, and not for a business with no stored point", async () => {
    const data = {
      name: "Lansing",
      geoMatchMode: "radius",
      centerLatitude: LANSING_BUSINESS.lat,
      centerLongitude: LANSING_BUSINESS.lng + 0.012,
      radiusMeters: ONE_MILE_M,
      zipCodes: [],
      zipCodesRemoved: ["48933"],
    };
    await createZone({ data } as any);
    expect(state.db.inserted[0].zip_codes).not.toContain("48933");

    state.db = fakeDb(LANSING_ORG && { ...LANSING_ORG, latitude: null, longitude: null });
    const out: any = await createZone({ data: { ...data, zipCodesRemoved: [] } } as any);
    expect(out.businessZipAdded).toBeNull();
  });

  it("a business-ZIP read that fails never fails the save", async () => {
    state.db = fakeDb(null);
    const out: any = await createZone({
      data: {
        name: "Lansing",
        geoMatchMode: "radius",
        centerLatitude: LANSING_BUSINESS.lat,
        centerLongitude: LANSING_BUSINESS.lng,
        radiusMeters: ONE_MILE_M,
      },
    } as any);
    expect(out.id).toBe("zone-new");
    // The save's own fill still lists the ZIP the circle's middle sits in.
    expect(state.db.inserted[0].zip_codes).toEqual(["48933"]);
  });

  it("Create returns the row the Zones list draws", async () => {
    const out: any = await createZone({
      data: {
        name: "Lansing",
        geoMatchMode: "radius",
        centerLatitude: LANSING_BUSINESS.lat,
        centerLongitude: LANSING_BUSINESS.lng,
        radiusMeters: ONE_MILE_M,
        basePriceCents: 2000,
        perDogAddlCents: 500,
      },
    } as any);
    expect(out.zone).toMatchObject({
      id: "zone-new",
      name: "Lansing",
      base_price_cents: 2000,
      per_dog_addl_cents: 500,
      zip_codes: ["48933"],
      geo_match_mode: "radius",
      enabled: true,
      active_clients: 0,
    });
  });
});

// ── 3. The list ───────────────────────────────────────────────────────────

describe("3. the Zones list shows the new zone as Create succeeds", () => {
  const before = {
    zones: [{ id: "a", name: "Old Town" }],
    activeClientsKnown: true,
  };

  it("adds the created zone to the cached list, keeping everything else", () => {
    const next = withCreatedZone(before, { id: "b", name: "Lansing" });
    expect(next).toEqual({
      zones: [
        { id: "a", name: "Old Town" },
        { id: "b", name: "Lansing" },
      ],
      activeClientsKnown: true,
    });
    expect(before.zones).toHaveLength(1); // not mutated
  });

  it("replaces rather than duplicates, and leaves an empty cache to the refetch", () => {
    const twice = withCreatedZone(withCreatedZone(before, { id: "b", name: "x" }), {
      id: "b",
      name: "Lansing",
    });
    expect(twice!.zones).toHaveLength(2);
    expect(twice!.zones!.find((z) => z.id === "b")).toEqual({ id: "b", name: "Lansing" });
    expect(withCreatedZone(undefined, { id: "b" })).toBeUndefined();
    expect(withCreatedZone(before, null)).toBe(before);
  });

  it("the drawer writes it into the list's own key before closing, then refetches", () => {
    const drawer = read("src/components/ZoneDrawer.tsx");
    const onSuccess = drawer.slice(drawer.indexOf("onSuccess: (res: any) => {"));
    const body = onSuccess.slice(0, onSuccess.indexOf("onClose();"));
    expect(body).toMatch(
      /qc\.setQueryData<ZonesListData>\(\["zones"\], \(old\) => withCreatedZone\(old, res\.zone\)\)/,
    );
    expect(body).toMatch(/qc\.invalidateQueries\(\{ queryKey: \["zones"\] \}\)/);
    expect(body).toMatch(/qc\.invalidateQueries\(\{ queryKey: \["zone-coverage"\] \}\)/);
    // The Zones page reads the same key.
    expect(read("src/routes/_authenticated/settings.zones.tsx")).toMatch(
      /useQuery\(\{ queryKey: \["zones"\], queryFn: \(\) => list\(\) \}\)/,
    );
  });
});
