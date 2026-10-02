import { useEffect, useRef } from "react";
import { useMapRenderer } from "@/lib/maps/use-map-renderer";
import { OverlayGroup, US_VIEW, type LatLng } from "@/lib/maps/types";

/**
 * The customer's live map on /track/<token>: the tech's approximate position
 * and the property's, drawn through useMapRenderer like every other map here
 * (Google when its key answers, the keyless fallback when it does not -- see
 * src/lib/maps/create.ts). The map is created only once its box is on screen,
 * and the tech's position moves overlays on that one map on every poll; a poll
 * never makes a new map, which is what Google bills for.
 *
 * Loaded on demand by the page, after mount, because the page is
 * server-rendered and a map needs `window`. Nothing on it is a control: the
 * zoom buttons are off (pinch and ctrl/⌘ + scroll still zoom, and a plain
 * scroll moves the page past it) and the two markers take no taps, so there is
 * nothing under 44px for a thumb to miss. The tech's dot sits inside a 100 m
 * ring, because the position IS rounded to about 100 m and the map should not
 * pretend otherwise.
 *
 * `onFail` fires if drawing throws, and the page swaps the map for text.
 */

export const TECH_COLOR = "#2563eb";
export const HOME_COLOR = "#16a34a";

const DOT = 18;

function dotHtml(color: string) {
  return (
    `<div style="width:${DOT}px;height:${DOT}px;border-radius:50%;background:${color};` +
    `border:3px solid #ffffff;box-shadow:0 1px 4px rgba(0,0,0,0.35);box-sizing:border-box"></div>`
  );
}

export default function TrackingMap({
  tech,
  home,
  onFail,
}: {
  tech: LatLng | null;
  home: LatLng | null;
  onFail: () => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const failRef = useRef(onFail);
  failRef.current = onFail;

  const first = home ?? tech;
  const map = useMapRenderer(el, {
    initialView: first ? { center: first, zoom: 15 } : US_VIEW,
    style: "street",
    // A page that scrolls on a phone should not be hijacked by the map on the
    // way past.
    gestures: "page",
    zoomControl: false,
  });

  // Redraw the two points on every poll, on the one map.
  useEffect(() => {
    if (!map) return;
    const layer = new OverlayGroup();
    try {
      const points: LatLng[] = [];
      if (home) {
        layer.add(
          map.addMarker({
            position: home,
            html: dotHtml(HOME_COLOR),
            size: [DOT, DOT],
            anchor: [DOT / 2, DOT / 2],
            title: "Your property",
          }),
        );
        points.push(home);
      }
      if (tech) {
        layer.add(
          map.addCircle(tech, 100, {
            color: TECH_COLOR,
            weight: 1,
            fillColor: TECH_COLOR,
            fillOpacity: 0.12,
            interactive: false,
          }),
        );
        layer.add(
          map.addMarker({
            position: tech,
            html: dotHtml(TECH_COLOR),
            size: [DOT, DOT],
            anchor: [DOT / 2, DOT / 2],
            title: "Your tech, approximately",
            zIndex: 2,
          }),
        );
        points.push(tech);
      }
      if (points.length === 1) map.setView(points[0], 15);
      else if (points.length > 1) map.fitBounds(points, { padding: 40, maxZoom: 16 });
    } catch (e) {
      console.warn("tracking map failed to draw", e);
      failRef.current();
    }
    return () => layer.clear();
  }, [map, tech?.lat, tech?.lng, home?.lat, home?.lng]);

  return (
    <div
      ref={el}
      role="img"
      aria-label="Map of your tech's approximate location and your property"
      className="h-64 w-full sm:h-80"
    />
  );
}
