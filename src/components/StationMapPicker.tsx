import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { addBaseTiles } from "@/lib/map-tiles";

export type StationPoint = { lat: number; lng: number };

// Continental US fallback when neither a marker nor a property location is
// known (mirrors NeighborMap's default view).
const US_CENTER: [number, number] = [39.5, -98.35];
const US_ZOOM = 4;
const PLACED_ZOOM = 19;

function stationIcon() {
  const html = `
    <div style="
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: #16a34a;
      border: 2px solid white;
      box-shadow: 0 1px 4px rgba(0,0,0,0.45);
    "></div>`;
  return L.divIcon({
    html,
    className: "station-pin",
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

/**
 * Satellite map for marking exactly where a waste station sits. Click (or
 * tap) places the marker; dragging it fine-tunes the spot. The marker is the
 * station's location — the position flows back through onChange.
 */
export function StationMapPicker({
  value,
  onChange,
  center,
  height = 260,
}: {
  /** Current marker position, or null when no marker has been placed. */
  value: StationPoint | null;
  /** Fired whenever the marker is placed or moved. */
  onChange: (point: StationPoint) => void;
  /** Where to look before a marker exists, e.g. the property's lat/lng. */
  center?: StationPoint | null;
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Captured once so a late-arriving center doesn't yank the view around
  // mid-edit; recentering on property change is handled by the effect below.
  const initialViewRef = useRef<{ point: StationPoint | null; center: StationPoint | null }>({
    point: value,
    center: center ?? null,
  });

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { zoomControl: true });
    addBaseTiles(map, "satellite");

    const { point, center: c } = initialViewRef.current;
    if (point) map.setView([point.lat, point.lng], PLACED_ZOOM);
    else if (c) map.setView([c.lat, c.lng], 18);
    else map.setView(US_CENTER, US_ZOOM);

    map.on("click", (e: L.LeafletMouseEvent) => {
      onChangeRef.current({ lat: e.latlng.lat, lng: e.latlng.lng });
    });
    requestAnimationFrame(() => map.invalidateSize());
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  // Keep the (single, draggable) marker in sync with value.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!value) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    const pos = L.latLng(value.lat, value.lng);
    if (markerRef.current) {
      markerRef.current.setLatLng(pos);
    } else {
      const m = L.marker(pos, { icon: stationIcon(), draggable: true }).addTo(map);
      m.on("dragend", () => {
        const p = m.getLatLng();
        onChangeRef.current({ lat: p.lat, lng: p.lng });
      });
      markerRef.current = m;
    }
    // Editing a station elsewhere (or a far first placement): bring it in view.
    if (!map.getBounds().contains(pos)) map.setView(pos, Math.max(map.getZoom(), 17));
  }, [value]);

  // Recenter when the caller's suggested center changes (e.g. a different
  // property is selected) and no marker has been placed yet.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || value || !center) return;
    map.setView([center.lat, center.lng], 18);
  }, [center?.lat, center?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  // isolate: Leaflet panes use z-index 400+; without a contained stacking
  // context they paint over dropdowns and popovers.
  return (
    <div
      ref={containerRef}
      style={{ height }}
      className="isolate z-0 w-full cursor-crosshair overflow-hidden rounded-md border"
    />
  );
}
