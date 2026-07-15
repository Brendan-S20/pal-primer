import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { addBaseTiles } from "@/lib/map-tiles";
import type { PolygonGeoJSON } from "@/components/BoundarySketch";
import { formatArea } from "@/components/BoundarySketch";

/**
 * Read-only view of a property's sketched service boundary (client detail
 * page). Editing stays on the dedicated boundary page; this just shows what's
 * already drawn without leaving the client.
 */
export function BoundaryPreview({
  boundary,
  areaSqm,
  height = 320,
}: {
  boundary: PolygonGeoJSON;
  areaSqm?: number | null;
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const ring = boundary.coordinates?.[0] ?? [];
    const pts = ring.map(([lng, lat]) => L.latLng(lat, lng));
    if (pts.length < 3) return;

    const map = L.map(containerRef.current, {
      zoomControl: true,
      attributionControl: false,
      scrollWheelZoom: false,
    });
    addBaseTiles(map);
    const poly = L.polygon(pts, { color: "#16a34a", weight: 2, fillOpacity: 0.15 });
    poly.addTo(map);
    map.fitBounds(poly.getBounds(), { padding: [24, 24], maxZoom: 20 });

    return () => {
      map.remove();
    };
  }, [boundary]);

  return (
    <div>
      <div
        ref={containerRef}
        style={{ height }}
        className="w-full overflow-hidden rounded-md border"
      />
      {areaSqm != null && (
        <p className="mt-2 text-xs text-muted-foreground">
          Sketched area: {formatArea(Number(areaSqm))}
        </p>
      )}
    </div>
  );
}
