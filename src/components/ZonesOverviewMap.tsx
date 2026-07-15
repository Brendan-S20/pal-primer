import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { DRIVE_M_PER_MIN } from "@/components/ZoneCoverageMap";
import type { PolygonGeoJSON } from "@/components/BoundarySketch";
import { addBaseTiles } from "@/lib/map-tiles";

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
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

  const geoZones = useMemo(() => zones.filter(zoneHasGeo), [zones]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      center: [39.5, -98.35],
      zoom: 4,
      scrollWheelZoom: false,
    });
    addBaseTiles(map);
    mapRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    if (geoZones.length === 0) return;

    const bounds = L.latLngBounds([]);
    geoZones.forEach((z, i) => {
      const color = ZONE_COLORS[i % ZONE_COLORS.length];
      const popup = `<div style="font-weight:600">${escapeHtml(z.name)}</div>`;
      const ring = z.boundary?.coordinates?.[0];
      if (ring && ring.length >= 3) {
        const latlngs = ring.map(([lng, lat]) => L.latLng(lat, lng));
        const poly = L.polygon(latlngs, { color, weight: 2, fillOpacity: 0.12 }).addTo(layer);
        poly.bindPopup(popup);
        bounds.extend(poly.getBounds());
        return;
      }
      const cLat = z.center_latitude ?? z.latitude;
      const cLng = z.center_longitude ?? z.longitude;
      if (cLat == null || cLng == null) return;
      const radius =
        z.radius_meters ??
        (z.drive_time_minutes != null ? z.drive_time_minutes * DRIVE_M_PER_MIN : null);
      if (radius != null) {
        const circle = L.circle([cLat, cLng], { radius, color, weight: 2, fillOpacity: 0.12 }).addTo(layer);
        circle.bindPopup(popup);
        bounds.extend(circle.getBounds());
      } else {
        const icon = L.divIcon({
          className: "zone-marker",
          html: `<div style="background:${color};border:2px solid white;border-radius:9999px;width:16px;height:16px;box-shadow:0 1px 4px rgba(0,0,0,.3);"></div>`,
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        });
        const m = L.marker([cLat, cLng], { icon }).addTo(layer);
        m.bindPopup(popup);
        bounds.extend(m.getLatLng());
      }
    });
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 13 });
  }, [geoZones]);

  useEffect(() => {
    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

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
