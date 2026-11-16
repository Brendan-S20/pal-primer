import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZoneCoverageMap, type CoverageValue } from "@/components/ZoneCoverageMap";
import { US_VIEW } from "@/lib/maps/types";

const { renderer } = vi.hoisted(() => ({ renderer: vi.fn(() => null) }));
vi.mock("@/lib/maps/use-map-renderer", () => ({ useMapRenderer: renderer }));
const empty: CoverageValue = {
  mode: "radius",
  polygon: null,
  centerLat: null,
  centerLng: null,
  radiusMeters: 1609,
  driveTimeMinutes: null,
};
function view(initial: CoverageValue, openingCenter: { lat: number; lng: number } | null) {
  renderToStaticMarkup(createElement(ZoneCoverageMap, { initial, openingCenter }));
  return renderer.mock.calls.at(-1)?.[1]?.initialView;
}
describe("new zone map viewport", () => {
  it("opens at city zoom on the business without placing coverage", () => {
    const center = { lat: 42.73, lng: -84.55 };
    expect(view(empty, center)).toEqual({ center, zoom: 12 });
    expect(empty.centerLat).toBeNull();
  });
  it("keeps the current US view without an address point", () => {
    expect(view(empty, null)).toEqual(US_VIEW);
  });
  it("preserves an existing zone's center", () => {
    expect(view({ ...empty, centerLat: 41, centerLng: -81 }, { lat: 42, lng: -84 })).toEqual({
      center: { lat: 41, lng: -81 },
      zoom: 12,
    });
  });
});
