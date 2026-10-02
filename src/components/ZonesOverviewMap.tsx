import { useEffect, useMemo, useRef } from "react";
import { DRIVE_M_PER_MIN } from "@/components/ZoneCoverageMap";
import type { PolygonGeoJSON } from "@/components/BoundarySketch";
import { useMapRenderer } from "@/lib/maps/use-map-renderer";
import { OverlayGroup, US_VIEW, circleBoundsPoints, type LatLng } from "@/lib/maps/types";

// For a geography-based product, the Zones page was plain text cards (P2).
// This draws every zone's coverage on one map — polygon if sketched, radius
// or drive-time circle otherwise, a pin as a last resort — color-coded to a
// legend the caller renders from the same palette.

export const ZONE_COLORS = [
  "#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed",
  "#0891b2", "#db2777", "#65a30d", "#c026d3", "#0d9488",
];

export type OverviewZone = {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  center_latitude: number | null;
  center_longitude: number | null;
  radius_meters: number | null;
  drive_time_minutes: number | null;
  boundary: PolygonGeoJSON | null;
};

export function zoneHasGeo(z: OverviewZone): boolean {
  return (
    !!z.boundary?.coordinates?.[0]?.length ||
    (z.center_latitude != null && z.center_longitude != null) ||
    (z.latitude != null && z.longitude != null)
  );
}

export function ZonesOverviewMap({ zones, height = 340 }: { zones: OverviewZone[]; height?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const geoZones = useMemo(() => zones.filter(zoneHasGeo), [zones]);
  // One map per mount. The zones are redrawn on it when they change.
  const map = useMapRenderer(containerRef, {
    initialView: US_VIEW,
    style: "street",
    gestures: "page",
  });

  useEffect(() => {
    if (!map || geoZones.length === 0) return;
    const layer = new OverlayGroup();
    const bounds: LatLng[] = [];
    geoZones.forEach((z, i) => {
      const color = ZONE_COLORS[i % ZONE_COLORS.length];
      const popupHtml = `<div style="font-weight:600">${escapeHtml(z.name)}</div>`;
      const ring = z.boundary?.coordinates?.[0];
      if (ring && ring.length >= 3) {
        const path = ring.map(([lng, lat]) => ({ lat, lng }));
        layer.add(map.addPolygon(path, { color, weight: 2, fillOpacity: 0.12, popupHtml }));
        bounds.push(...path);
        return;
      }
      const cLat = z.center_latitude ?? z.latitude;
      const cLng = z.center_longitude ?? z.longitude;
      if (cLat == null || cLng == null) return;
      const center = { lat: cLat, lng: cLng };
      const radius =
        z.radius_meters ??
        (z.drive_time_minutes != null ? z.drive_time_minutes * DRIVE_M_PER_MIN : null);
      if (radius != null) {
        layer.add(
          map.addCircle(center, radius, { color, weight: 2, fillOpacity: 0.12, popupHtml }),
        );
        bounds.push(...circleBoundsPoints(center, radius));
      } else {
        layer.add(
          map.addMarker({
            position: center,
            className: "zone-marker",
            html: `<div style="background:${color};border:2px solid white;border-radius:9999px;width:16px;height:16px;box-shadow:0 1px 4px rgba(0,0,0,.3);"></div>`,
            size: [16, 16],
            anchor: [8, 8],
            title: z.name,
            popupHtml,
          }),
        );
        bounds.push(center);
      }
    });
    if (bounds.length > 0) map.fitBounds(bounds, { padding: 30, maxZoom: 13 });
    return () => layer.clear();
  }, [map, geoZones]);

  return (
    <div
      ref={containerRef}
      style={{ height, width: "100%" }}
      className="isolate z-0 overflow-hidden rounded-lg border"
    />
  );
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
