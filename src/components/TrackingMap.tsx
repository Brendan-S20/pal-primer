import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { addBaseTiles } from "@/lib/map-tiles";

/**
 * The customer's live map on /track/<token>: the tech's approximate position
 * and the property's, on the same OpenStreetMap tiles RouteMap uses (through
 * addBaseTiles, keyless — see src/lib/map-tiles.ts for why CARTO is gone).
 *
 * Loaded on demand by the page, after mount, because Leaflet reaches for
 * `window` and the page is server-rendered. Nothing on it is a control: the
 * zoom buttons are off (pinch and scroll still zoom) and the two markers are
 * circles that take no taps, so there is nothing under 44px for a thumb to
 * miss. The tech's dot sits inside a 100 m ring, because the position IS
 * rounded to about 100 m and the map should not pretend otherwise.
 *
 * `onFail` fires if Leaflet throws, or if no tile has loaded after several
 * have failed, and the page swaps the map for text.
 */

export const TECH_COLOR = "#2563eb";
export const HOME_COLOR = "#16a34a";

export default function TrackingMap({
  tech,
  home,
  onFail,
}: {
  tech: { lat: number; lng: number } | null;
  home: { lat: number; lng: number } | null;
  onFail: () => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const failRef = useRef(onFail);
  failRef.current = onFail;

  // Build once.
  useEffect(() => {
    if (!el.current) return;
    try {
      const m = L.map(el.current, {
        zoomControl: false,
        attributionControl: true,
        // A page that scrolls on a phone should not be hijacked by the map
        // on the way past; two fingers or a tap-then-drag still move it.
        scrollWheelZoom: false,
      });
      let loaded = 0;
      let failed = 0;
      m.on("layeradd", (e: any) => {
        if (!(e.layer instanceof L.TileLayer)) return;
        e.layer.on("tileload", () => (loaded += 1));
        e.layer.on("tileerror", () => {
          failed += 1;
          if (loaded === 0 && failed >= 6) failRef.current();
        });
      });
      addBaseTiles(m, "street");
      layer.current = L.layerGroup().addTo(m);
      map.current = m;
    } catch (e) {
      console.warn("tracking map failed to start", e);
      failRef.current();
    }
    return () => {
      map.current?.remove();
      map.current = null;
      layer.current = null;
    };
  }, []);

  // Redraw the two points on every poll.
  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    try {
      g.clearLayers();
      const points: L.LatLngExpression[] = [];
      if (home) {
        L.circleMarker([home.lat, home.lng], {
          radius: 9,
          color: "#ffffff",
          weight: 3,
          fillColor: HOME_COLOR,
          fillOpacity: 1,
          interactive: false,
        }).addTo(g);
        points.push([home.lat, home.lng]);
      }
      if (tech) {
        L.circle([tech.lat, tech.lng], {
          radius: 100,
          color: TECH_COLOR,
          weight: 1,
          fillColor: TECH_COLOR,
          fillOpacity: 0.12,
          interactive: false,
        }).addTo(g);
        L.circleMarker([tech.lat, tech.lng], {
          radius: 9,
          color: "#ffffff",
          weight: 3,
          fillColor: TECH_COLOR,
          fillOpacity: 1,
          interactive: false,
        }).addTo(g);
        points.push([tech.lat, tech.lng]);
      }
      if (points.length === 1) m.setView(points[0], 15);
      else if (points.length > 1) m.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 16 });
    } catch (e) {
      console.warn("tracking map failed to draw", e);
      failRef.current();
    }
  }, [tech?.lat, tech?.lng, home?.lat, home?.lng]);

  return (
    <div
      ref={el}
      role="img"
      aria-label="Map of your tech's approximate location and your property"
      className="h-64 w-full sm:h-80"
    />
  );
}
