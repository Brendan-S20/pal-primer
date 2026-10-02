import { useEffect, useRef } from "react";
import { useMapRenderer } from "@/lib/maps/use-map-renderer";
import { OverlayGroup, US_VIEW, type MarkerHandle } from "@/lib/maps/types";

export type StationPoint = { lat: number; lng: number };

// With neither a marker nor a property location the maps open on US_VIEW,
// the continental-US default every map shares.
const PLACED_ZOOM = 19;

const STATION_PIN_HTML = `
    <div style="
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: #16a34a;
      border: 2px solid white;
      box-shadow: 0 1px 4px rgba(0,0,0,0.45);
    "></div>`;

function numberedStationHtml(label: string) {
  return `
    <div style="
      min-width: 22px;
      height: 22px;
      padding: 0 4px;
      border-radius: 11px;
      background: #16a34a;
      border: 2px solid white;
      box-shadow: 0 1px 4px rgba(0,0,0,0.45);
      color: white;
      font: 700 11px/18px system-ui, sans-serif;
      text-align: center;
    ">${label}</div>`;
}

export type OverviewStation = {
  id: string;
  station_number: number | null;
  label: string | null;
  latitude: number | null;
  longitude: number | null;
};

/**
 * Read-only satellite overview of every waste station on a client's
 * properties — numbered markers, view fitted to the stations (G7 follow-up:
 * the panel previously only had the add/edit picker, never a map of what
 * already exists). Clicking a marker hands the station back to the caller
 * (e.g. to open it for editing).
 */
export function StationsOverviewMap({
  stations,
  center,
  onSelect,
  height = 260,
}: {
  stations: OverviewStation[];
  /** Fallback view (property location) when no station has coordinates. */
  center?: StationPoint | null;
  onSelect?: (stationId: string) => void;
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  });
  const map = useMapRenderer(containerRef, {
    initialView: center ? { center, zoom: 18 } : US_VIEW,
    style: "satellite",
    gestures: "page",
    maxZoom: 22,
  });

  useEffect(() => {
    if (!map) return;
    const layer = new OverlayGroup();
    const placed = stations.filter((s) => s.latitude != null && s.longitude != null);
    for (const s of placed) {
      const title = s.station_number != null ? String(s.station_number) : "•";
      layer.add(
        map.addMarker({
          position: { lat: Number(s.latitude), lng: Number(s.longitude) },
          className: "station-pin",
          html: numberedStationHtml(title),
          size: [22, 22],
          anchor: [11, 11],
          title: s.label ?? `Station ${title}`,
          onClick: () => onSelectRef.current?.(s.id),
        }),
      );
    }
    if (placed.length > 0) {
      map.fitBounds(
        placed.map((s) => ({ lat: Number(s.latitude), lng: Number(s.longitude) })),
        { padding: 30, maxZoom: 19 },
      );
    } else if (center) {
      map.setView(center, 18);
    }
    return () => layer.clear();
  }, [map, stations, center?.lat, center?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={containerRef}
      style={{ height }}
      className="isolate z-0 w-full overflow-hidden rounded-md border"
    />
  );
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
  const markerRef = useRef<MarkerHandle | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  // Where the map opens. Read when the map is created (which waits for the
  // container to be on screen), so a property location that arrived in the
  // meantime is used; later changes are handled by the effects below rather
  // than by yanking the view mid-edit.
  const map = useMapRenderer(containerRef, {
    initialView: value
      ? { center: value, zoom: PLACED_ZOOM }
      : center
        ? { center, zoom: 18 }
        : US_VIEW,
    style: "satellite",
    gestures: "map",
    maxZoom: 22,
  });

  // Click (or tap) places the marker.
  useEffect(() => {
    if (!map) return;
    return map.onMapClick((p) => onChangeRef.current({ lat: p.lat, lng: p.lng }));
  }, [map]);

  // Keep the (single, draggable) marker in sync with value.
  useEffect(() => {
    if (!map) return;
    if (!value) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    if (markerRef.current) {
      markerRef.current.setPosition(value);
    } else {
      markerRef.current = map.addMarker({
        position: value,
        className: "station-pin",
        html: STATION_PIN_HTML,
        size: [18, 18],
        anchor: [9, 9],
        title: "Station location (drag to adjust)",
        draggable: true,
        onDragEnd: (p) => onChangeRef.current({ lat: p.lat, lng: p.lng }),
      });
    }
    // Editing a station elsewhere (or a far first placement): bring it in view.
    if (!map.isInView(value)) map.setView(value, Math.max(map.getZoom(), 17));
  }, [map, value]);

  // The marker belongs to this map; drop the handle with it.
  useEffect(() => {
    if (!map) return;
    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
    };
  }, [map]);

  // Recenter when the caller's suggested center changes (e.g. a different
  // property is selected) and no marker has been placed yet.
  useEffect(() => {
    if (!map || value || !center) return;
    map.setView(center, 18);
  }, [map, center?.lat, center?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  // isolate: map panes use z-index 400+; without a contained stacking
  // context they paint over dropdowns and popovers.
  return (
    <div
      ref={containerRef}
      style={{ height }}
      className="isolate z-0 w-full cursor-crosshair overflow-hidden rounded-md border"
    />
  );
}
