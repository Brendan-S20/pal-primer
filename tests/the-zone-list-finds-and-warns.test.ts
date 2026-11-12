// The Zones page list (#450): the shape each row names, search, filters,
// sort, and the shared-ZIP warning. Rules in src/lib/zone-list.ts.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ZONE_QUERY,
  filterAndSortZones,
  zipOverlaps,
  zipOverlapSentence,
  zoneQueryIsFiltered,
  zoneShape,
  zoneShapeDetail,
  type ZoneListRow,
} from "@/lib/zone-list";

const Z = (id: string, z: Partial<ZoneListRow> = {}): ZoneListRow => ({ id, name: id, ...z });

const ZONES: ZoneListRow[] = [
  Z("b", {
    name: "Birch",
    zip_codes: ["48201", "48202"],
    active_clients: 4,
    base_price_cents: 2500,
  }),
  Z("a", {
    name: "alder",
    geo_match_mode: "polygon",
    boundary: { type: "Polygon" },
    active_clients: 9,
    base_price_cents: 2000,
  }),
  Z("c", {
    name: "Cedar",
    geo_match_mode: "radius",
    radius_meters: 8045,
    enabled: false,
    zip_codes: ["48202"],
    base_price_cents: 3000,
  }),
  Z("d", {
    name: "Dogwood",
    geo_match_mode: "drive_time",
    drive_time_minutes: 15,
    postal_prefix: "482",
  }),
];

describe("the shape a row names", () => {
  it("names the drawn shape, and a drawn mode with nothing drawn as a ZIP list", () => {
    expect(ZONES.map(zoneShape)).toEqual(["zip", "polygon", "radius", "drive_time"]);
    expect(zoneShape(Z("x", { geo_match_mode: "polygon", boundary: null }))).toBe("zip");
    expect(zoneShapeDetail(ZONES[2])).toBe("Radius, 5.0 mi");
    expect(zoneShapeDetail(ZONES[3])).toBe("Drive time, 15 min");
  });
});

describe("search, filter and sort", () => {
  const run = (q: Partial<typeof DEFAULT_ZONE_QUERY>) =>
    filterAndSortZones(ZONES, { ...DEFAULT_ZONE_QUERY, ...q }).map((z) => z.id);

  it("sorts by name without regard to case by default", () => {
    expect(run({})).toEqual(["a", "b", "c", "d"]);
    expect(zoneQueryIsFiltered(DEFAULT_ZONE_QUERY)).toBe(false);
  });

  it("sorts by clients and by price, most first", () => {
    expect(run({ sort: "clients" })).toEqual(["a", "b", "c", "d"]);
    expect(run({ sort: "price" })).toEqual(["c", "b", "a", "d"]);
  });

  it("finds a zone by name, by a listed ZIP, or by its prefix", () => {
    expect(run({ search: "ced" })).toEqual(["c"]);
    // Dogwood matches too: its prefix 482 covers 48202.
    expect(run({ search: "48202" })).toEqual(["b", "c", "d"]);
    expect(run({ search: "48299" })).toEqual(["d"]);
    expect(zoneQueryIsFiltered({ ...DEFAULT_ZONE_QUERY, search: " x " })).toBe(true);
  });

  it("filters on status and shape", () => {
    expect(run({ status: "off" })).toEqual(["c"]);
    expect(run({ status: "on" })).toEqual(["a", "b", "d"]);
    expect(run({ shape: "polygon" })).toEqual(["a"]);
  });
});

describe("a ZIP two zones both list", () => {
  it("is not reported against a zone that is off, which matches nothing", () => {
    expect(zipOverlaps(ZONES[0], ZONES)).toEqual([]);
    expect(zipOverlaps(ZONES[2], ZONES)).toEqual([]);
  });

  it("names the winner when priority settles it, and says when it does not", () => {
    const one = Z("1", { name: "One", zip_codes: ["48229", "48218"], priority: 2 });
    const two = Z("2", { name: "Two", zip_codes: ["48229"] });
    const three = Z("3", { name: "Three", zip_codes: ["48218"], priority: 2 });
    const all = [one, two, three];
    expect(zipOverlaps(two, all).map(zipOverlapSentence)).toEqual([
      "48229 is also in One, which wins on priority.",
    ]);
    expect(zipOverlaps(one, all).map(zipOverlapSentence)).toEqual([
      "48229 is also in Two. This zone wins on priority.",
      "48218 is also in Three, with the same priority. Set a priority to choose which zone wins.",
    ]);
  });

  it("shows three ZIPs and counts the rest, with no em dash", () => {
    const zips = ["1", "2", "3", "4", "5"].map((n) => `4820${n}`);
    const s = zipOverlapSentence({ otherId: "x", otherName: "X", zips, winner: null });
    expect(s).toMatch(/^48201, 48202, 48203 and 2 more are also in X/);
    expect(s).not.toMatch(/—/);
  });
});
