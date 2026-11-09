// gaps-r2-09: four corners and a click on the first one saved a TRIANGLE.
//
// Every vertex click removed that vertex, so the usual "close the shape"
// gesture deleted corner 1 and Create zone stored corners 2-4. The
// acceptance is that the saved polygon equals the drawn one; these tests
// drive the same click rules ZoneCoverageMap uses and compare the result.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { clickMap, clickVertex, undoDraft, type PolygonDraft } from "@/lib/zone-drawing";

const A = { lat: 42.0, lng: -83.0 };
const B = { lat: 42.0, lng: -82.9 };
const C = { lat: 41.9, lng: -82.9 };
const D = { lat: 41.9, lng: -83.0 };
const E = { lat: 41.95, lng: -83.05 };

const empty: PolygonDraft = { points: [], closed: false };
const drawn = [A, B, C, D].reduce(clickMap, empty);

describe("closing a polygon zone", () => {
  it("keeps every corner when the first one is clicked again", () => {
    const closed = clickVertex(drawn, 0);
    expect(closed.closed).toBe(true);
    expect(closed.points).toEqual([A, B, C, D]);
  });

  it("a double-click on the first corner does not undo the close it made", () => {
    const twice = clickVertex(clickVertex(drawn, 0), 0);
    expect(twice).toEqual({ points: [A, B, C, D], closed: true });
  });

  it("a closed shape ignores further map clicks, so a stray tap adds nothing", () => {
    expect(clickMap(clickVertex(drawn, 0), E).points).toEqual([A, B, C, D]);
  });

  it("Undo reopens the shape before it takes a corner back", () => {
    const reopened = undoDraft(clickVertex(drawn, 0));
    expect(reopened).toEqual({ points: [A, B, C, D], closed: false });
    expect(undoDraft(reopened).points).toEqual([A, B, C]);
    expect(clickMap(reopened, E).points).toEqual([A, B, C, D, E]);
  });

  it("clicking any other corner still removes it, and a shape under three reopens", () => {
    expect(clickVertex(drawn, 2).points).toEqual([A, B, D]);
    const closedTriangle = clickVertex([A, B, C].reduce(clickMap, empty), 0);
    expect(closedTriangle.closed).toBe(true);
    expect(clickVertex(closedTriangle, 1)).toEqual({ points: [A, C], closed: false });
  });

  it("with fewer than three corners there is nothing to close, so corner 1 is removed as before", () => {
    expect(clickVertex([A, B].reduce(clickMap, empty), 0)).toEqual({ points: [B], closed: false });
  });

  it("ZoneCoverageMap routes its vertex clicks through these rules, not its own filter", () => {
    const src = readFileSync(
      path.resolve(import.meta.dirname, "../src/components/ZoneCoverageMap.tsx"),
      "utf8",
    );
    expect(src).toMatch(/onClick:\s*\(\)\s*=>\s*applyDraft\(\(d\)\s*=>\s*clickVertex\(d,\s*i\)\)/);
    expect(src).toMatch(/clickMap\(d,\s*p\)/);
    expect(src).not.toMatch(/pointsRef\.current\.filter\(/);
    // The hint tells people how to close it, instead of "click a point to adjust".
    expect(src).toMatch(/click the first \(orange\) point to close the shape/);
  });
});
