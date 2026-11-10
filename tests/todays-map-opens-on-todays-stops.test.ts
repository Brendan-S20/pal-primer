// #773 (onboarding QA, 2026-11-09): a fresh org's first client at 1 Woodward
// Ave, Detroit, with one visit today. The dashboard's "Today's map" opened
// around Royal Oak / 11 Mile instead of on that pin.
//
// Acceptance, from the issue:
//   1. One Detroit visit today: the map fits that pin at neighbourhood zoom
//      (maxZoom 14) with no click.
//   2. "You are here" is opt-in, and does not keep the map away from today's
//      stops for good.
//
// Three faults, each pinned below:
//   * The one-pin fit on Google skipped the replay a map adopted from the pool
//     needs (tests/google-draws-the-maps.test.ts has that half).
//   * The fit took in a tech's start and end even on a map that does not draw
//     them, so the frame could be pulled toward a home base with no marker on
//     it.
//   * Once the owner located themselves, nothing on the map took them back to
//     the stops until the day's visits changed.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("leaflet", () => ({
  default: { Icon: { Default: { prototype: {}, mergeOptions: () => {} } } },
}));

import { fitTargets, nextFit, type TechGroup } from "@/components/RouteMap";

const woodward = { lat: 42.3297, lng: -83.0458 };
const royalOak = { lat: 42.4895, lng: -83.1446 };

function group(o: Partial<TechGroup> = {}): TechGroup {
  return {
    staffId: "tech-1",
    name: "Sam",
    color: "#2563eb",
    visits: [
      {
        id: "v-rex",
        sequence: 1,
        status: "scheduled",
        clients: { display_name: "Rex QA" },
        properties: {
          street: "1 Woodward Ave",
          city: "Detroit",
          latitude: woodward.lat,
          longitude: woodward.lng,
        },
      },
    ],
    ...o,
  } as TechGroup;
}

describe("#773: what the map fits", () => {
  it("one geocoded visit and no anchors is exactly that pin", () => {
    expect(fitTargets([group()], true)).toEqual([woodward]);
  });

  it("takes in a tech's start and end when the map draws them", () => {
    const g = group({
      startLat: royalOak.lat,
      startLng: royalOak.lng,
      endLat: royalOak.lat,
      endLng: royalOak.lng,
    });
    expect(fitTargets([g], true)).toEqual([woodward, royalOak, royalOak]);
  });

  it("does not frame an anchor the map does not draw", () => {
    const g = group({ startLat: royalOak.lat, startLng: royalOak.lng });
    expect(fitTargets([g], false)).toEqual([woodward]);
  });

  it("skips a visit whose address has not been geocoded yet", () => {
    const g = group();
    g.visits.push({ id: "v-2", properties: { latitude: null, longitude: null } });
    expect(fitTargets([g], true)).toEqual([woodward]);
  });
});

describe("#773: when the map fits, and when it leaves the view alone", () => {
  const first = { fittedKey: null, located: false };

  it("fits on first paint, with no click", () => {
    const d = nextFit(first, "v-rex", 1);
    expect(d.fit).toBe(true);
    expect(d.memory).toEqual({ fittedKey: "v-rex", located: false });
  });

  it("does not fit when there is nothing to fit", () => {
    expect(nextFit(first, "", 0).fit).toBe(false);
  });

  it("after the owner locates themselves, a refetch of the same day leaves them there", () => {
    const d = nextFit({ fittedKey: "v-rex", located: true }, "v-rex", 1);
    expect(d.fit).toBe(false);
    expect(d.memory.located).toBe(true);
  });

  it("a different set of stops takes the view back", () => {
    const d = nextFit({ fittedKey: "v-rex", located: true }, "v-rex,v-2", 2);
    expect(d.fit).toBe(true);
    expect(d.memory).toEqual({ fittedKey: "v-rex,v-2", located: false });
  });

  it("a pin that geocodes after first paint is fitted when it arrives", () => {
    // Created client, address still geocoding: the visit is listed with no
    // coordinates, so there is nothing to fit. When it lands, fit it.
    const before = nextFit(first, "", 0);
    const after = nextFit(before.memory, "v-rex", 1);
    expect(after.fit).toBe(true);
  });
});

describe("#773: locating is opt-in, and the stops are one tap away after it", () => {
  const read = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");
  const code = () =>
    read("src/components/RouteMap.tsx")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");

  it("asks for the device position only from the location button", () => {
    const src = code();
    // locate() is the only caller of either geolocation path...
    expect(src.match(/getCurrentPosition\(/g)).toHaveLength(1);
    expect(src.match(/getPositionNative\(\)/g)).toHaveLength(1);
    // ...and locate is wired to a click, never called from an effect.
    expect(src).toMatch(/onClick=\{locate\}/);
    expect(src).not.toMatch(/\blocate\(\)/);
  });

  it("offers Show all stops once the owner has located themselves", () => {
    const src = code();
    expect(src).toMatch(/awayFromStops\s*&&/);
    expect(src).toMatch(/onClick=\{showStops\}/);
    expect(src).toContain('aria-label="Show all stops"');
  });
});
