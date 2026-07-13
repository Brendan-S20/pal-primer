import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Button } from "@/components/ui/button";
import { Undo2, Trash2, Save, MousePointer2, Pencil } from "lucide-react";

export type PolygonGeoJSON = {
  type: "Polygon";
  coordinates: number[][][]; // [ [ [lng, lat], ... , [lng, lat] ] ]
};

function toRing(latlngs: L.LatLng[]): number[][] {
  const ring = latlngs.map((p) => [p.lng, p.lat]);
  if (ring.length > 0) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  }
  return ring;
}

function fromPolygon(poly: PolygonGeoJSON | null): L.LatLng[] {
  if (!poly) return [];
  const ring = poly.coordinates?.[0] ?? [];
  const pts = ring.slice(0, Math.max(0, ring.length - 1)); // strip closing dup
  return pts.map(([lng, lat]) => L.latLng(lat, lng));
}

export function BoundarySketch({
  center,
  initial,
  onSave,
  saving,
  areaSqm,
  height = 460,
}: {
  center: { lat: number; lng: number } | null;
  initial: PolygonGeoJSON | null;
  onSave: (polygon: PolygonGeoJSON | null) => void;
  saving?: boolean;
  areaSqm?: number | null;
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const pointsRef = useRef<L.LatLng[]>(fromPolygon(initial));
  const [mode, setMode] = useState<"draw" | "view">(initial ? "view" : "draw");
  const [tick, setTick] = useState(0);
  const [liveArea, setLiveArea] = useState<number | null>(areaSqm ?? null);

  const currentPolygon = useMemo<PolygonGeoJSON | null>(() => {
    const pts = pointsRef.current;
    if (pts.length < 3) return null;
    return { type: "Polygon", coordinates: [toRing(pts)] };
  }, [tick]);

  // Init map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const start: [number, number] = center ? [center.lat, center.lng] : [39.5, -98.35];
    const map = L.map(containerRef.current, {
      center: start,
      zoom: center ? 19 : 4,
      maxZoom: 22,
      scrollWheelZoom: true,
    });
    // Yard sketching genuinely benefits from photographic imagery — use the
    // satellite variant of the shared tile helper (labels overlay included).
    addBaseTiles(map, "satellite");
    mapRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);

    map.on("click", (e: L.LeafletMouseEvent) => {
      if (mode !== "draw") return;
      pointsRef.current = [...pointsRef.current, e.latlng];
      setTick((t) => t + 1);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redraw layer
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    const pts = pointsRef.current;
    if (pts.length >= 3) {
      const poly = L.polygon(pts, {
        color: "#2563eb",
        weight: 2,
        fillColor: "#3b82f6",
        fillOpacity: 0.25,
      });
      poly.addTo(layer);
      // rough area for live display
      const g: PolygonGeoJSON = { type: "Polygon", coordinates: [toRing(pts)] };
      setLiveArea(quickArea(g));
    } else if (pts.length >= 2) {
      L.polyline(pts, { color: "#2563eb", weight: 2, dashArray: "4 4" }).addTo(layer);
      setLiveArea(null);
    } else {
      setLiveArea(null);
    }
    pts.forEach((p, i) => {
      const icon = L.divIcon({
        className: "boundary-vertex",
        html: `<div style="background:${i === 0 ? "#f59e0b" : "#2563eb"};color:white;border:2px solid white;border-radius:9999px;width:14px;height:14px;box-shadow:0 1px 3px rgba(0,0,0,.4)"></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      });
      const m = L.marker(p, { icon, draggable: mode === "draw" }).addTo(layer);
      m.on("drag", (ev: any) => {
        const ll: L.LatLng = ev.target.getLatLng();
        pointsRef.current = pointsRef.current.map((q, idx) => (idx === i ? ll : q));
      });
      m.on("dragend", () => setTick((t) => t + 1));
      m.on("click", (ev) => {
        if (mode !== "draw") return;
        L.DomEvent.stopPropagation(ev);
        pointsRef.current = pointsRef.current.filter((_, idx) => idx !== i);
        setTick((t) => t + 1);
      });
    });

    if (pts.length >= 3) {
      map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 20 });
    }
  }, [tick, mode]);

  // Recenter on new center prop
  useEffect(() => {
    if (!mapRef.current || !center) return;
    if (pointsRef.current.length === 0) mapRef.current.setView([center.lat, center.lng], 20);
  }, [center]);

  useEffect(() => {
    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  const undo = () => {
    pointsRef.current = pointsRef.current.slice(0, -1);
    setTick((t) => t + 1);
  };
  const clear = () => {
    pointsRef.current = [];
    setTick((t) => t + 1);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          <Button
            size="sm"
            variant={mode === "draw" ? "default" : "outline"}
            onClick={() => setMode("draw")}
          >
            <Pencil className="mr-1 h-3.5 w-3.5" /> Draw
          </Button>
          <Button
            size="sm"
            variant={mode === "view" ? "default" : "outline"}
            onClick={() => setMode("view")}
          >
            <MousePointer2 className="mr-1 h-3.5 w-3.5" /> View
          </Button>
          <Button size="sm" variant="ghost" onClick={undo} disabled={pointsRef.current.length === 0}>
            <Undo2 className="mr-1 h-3.5 w-3.5" /> Undo
          </Button>
          <Button size="sm" variant="ghost" onClick={clear} disabled={pointsRef.current.length === 0}>
            <Trash2 className="mr-1 h-3.5 w-3.5" /> Clear
          </Button>
        </div>
        <div className="flex items-center gap-3">
          {liveArea != null && (
            <span className="text-xs text-muted-foreground">
              ~{formatArea(liveArea)} · {pointsRef.current.length} points
            </span>
          )}
          <Button size="sm" onClick={() => onSave(currentPolygon)} disabled={!!saving}>
            <Save className="mr-1 h-3.5 w-3.5" />
            {saving ? "Saving…" : currentPolygon ? "Save boundary" : "Clear saved"}
          </Button>
        </div>
      </div>
      <div
        ref={containerRef}
        style={{ height, width: "100%" }}
        className="rounded-lg border overflow-hidden z-0"
      />
      <p className="text-xs text-muted-foreground">
        In <b>Draw</b> mode: click to add points around the yard. Drag any point to adjust; click a point to remove it. Switch to <b>View</b> to pan without adding.
      </p>
    </div>
  );
}

function quickArea(g: PolygonGeoJSON): number | null {
  const ring = g.coordinates[0];
  if (!ring || ring.length < 4) return null;
  const R = 6378137;
  const latMean = (ring.reduce((s, p) => s + p[1], 0) / ring.length) * (Math.PI / 180);
  const cosLat = Math.cos(latMean);
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const x1 = xi * (Math.PI / 180) * R * cosLat;
    const y1 = yi * (Math.PI / 180) * R;
    const x2 = xj * (Math.PI / 180) * R * cosLat;
    const y2 = yj * (Math.PI / 180) * R;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}

export function formatArea(sqm: number): string {
  const sqft = sqm * 10.7639;
  if (sqft < 15000) return `${Math.round(sqft).toLocaleString()} sq ft`;
  const acres = sqm / 4046.8564;
  return `${acres.toFixed(2)} acres`;
}
