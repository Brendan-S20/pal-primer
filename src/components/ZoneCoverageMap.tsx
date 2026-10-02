import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Button } from "@/components/ui/button";
import { Undo2, Trash2, Save, MousePointer2, Pencil, Circle as CircleIcon, Clock } from "lucide-react";
import type { PolygonGeoJSON } from "@/components/BoundarySketch";
import { addBaseTiles } from "@/lib/map-tiles";
import { DRIVE_M_PER_MIN } from "@/lib/zone-match";

export type CoverageMode = "polygon" | "radius" | "drive_time";

export type CoverageValue = {
  mode: CoverageMode;
  polygon: PolygonGeoJSON | null;
  centerLat: number | null;
  centerLng: number | null;
  radiusMeters: number | null;
  driveTimeMinutes: number | null;
};

function toRing(latlngs: L.LatLng[]): number[][] {
  const ring = latlngs.map((p) => [p.lng, p.lat]);
  if (ring.length > 0) {
    const [fx, fy] = ring[0];
    const [lx, ly] = ring[ring.length - 1];
    if (fx !== lx || fy !== ly) ring.push([fx, fy]);
  }
  return ring;
}
function fromPolygon(poly: PolygonGeoJSON | null): L.LatLng[] {
  if (!poly) return [];
  const ring = poly.coordinates?.[0] ?? [];
  return ring.slice(0, Math.max(0, ring.length - 1)).map(([lng, lat]) => L.latLng(lat, lng));
}

// Rough urban drive speed used to visualize drive-time as an approximate radius
// (~800m per minute ≈ 30 mph average with stops). Defined once, by the matcher,
// so what is drawn is what is matched; re-exported for existing importers.
export { DRIVE_M_PER_MIN };

export function ZoneCoverageMap({
  initial,
  onSave,
  onChange,
  saving,
  height = 420,
  focusPoint,
}: {
  initial: CoverageValue;
  /** Standalone mode: renders a Save button that emits the drawn coverage. */
  onSave?: (v: CoverageValue) => void;
  /** Controlled mode (zone drawer): emits the coverage on every edit; pass
   * this and omit onSave so the parent form owns the submit. */
  onChange?: (v: CoverageValue) => void;
  saving?: boolean;
  height?: number;
  /** Pans the map here (e.g. a typed ZIP's centroid) and seeds the center
   * point for radius/drive-time modes when none is placed yet. */
  focusPoint?: { lat: number; lng: number } | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const drawLayer = useRef<L.LayerGroup | null>(null);
  const pointsRef = useRef<L.LatLng[]>(fromPolygon(initial.polygon));
  const centerRef = useRef<L.LatLng | null>(
    initial.centerLat != null && initial.centerLng != null
      ? L.latLng(initial.centerLat, initial.centerLng)
      : null,
  );
  const [mode, setMode] = useState<CoverageMode>(initial.mode);
  const modeRef = useRef<CoverageMode>(initial.mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  const [radius, setRadius] = useState<number>(initial.radiusMeters ?? 5000);
  const [minutes, setMinutes] = useState<number>(initial.driveTimeMinutes ?? 15);
  const [tick, setTick] = useState(0);
  const fittedRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const start: [number, number] =
      centerRef.current
        ? [centerRef.current.lat, centerRef.current.lng]
        : pointsRef.current[0]
          ? [pointsRef.current[0].lat, pointsRef.current[0].lng]
          : [39.5, -98.35];
    const map = L.map(containerRef.current, { center: start, zoom: centerRef.current || pointsRef.current[0] ? 12 : 4, maxZoom: 19, scrollWheelZoom: true });
    addBaseTiles(map);
    mapRef.current = map;
    drawLayer.current = L.layerGroup().addTo(map);

    map.on("click", (e: L.LeafletMouseEvent) => {
      // Read the current mode from the ref — the handler is registered once at
      // init, so closing over the initial `mode` state would misroute clicks
      // after the user switches tabs.
      if (modeRef.current === "polygon") {
        pointsRef.current = [...pointsRef.current, e.latlng];
        setTick((t) => t + 1);
      } else {
        centerRef.current = e.latlng;
        setTick((t) => t + 1);
      }
    });
    return () => {
      try { map.off(); map.remove(); } catch { /* ignore */ }
      mapRef.current = null;
      drawLayer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redraw on any state change
  useEffect(() => {
    const map = mapRef.current;
    const layer = drawLayer.current;
    if (!map || !layer) return;
    // Stop any in-flight interactions before we tear down the layer — otherwise
    // a marker mid-drag whose ._map has already been detached crashes Leaflet's
    // mouse plumbing with `Cannot read properties of undefined (reading 'layerPointToLatLng')`.
    try { (map as any).dragging?.enable(); } catch { /* ignore */ }
    layer.clearLayers();

    if (mode === "polygon") {
      const pts = pointsRef.current;
      if (pts.length >= 3) L.polygon(pts, { color: "#2563eb", weight: 2, fillColor: "#3b82f6", fillOpacity: 0.2 }).addTo(layer);
      else if (pts.length >= 2) L.polyline(pts, { color: "#2563eb", dashArray: "4 4" }).addTo(layer);
      pts.forEach((p, i) => {
        const icon = L.divIcon({
          className: "zone-vertex",
          html: `<div style="background:${i === 0 ? "#f59e0b" : "#2563eb"};color:white;border:2px solid white;border-radius:9999px;width:12px;height:12px;box-shadow:0 1px 3px rgba(0,0,0,.4)"></div>`,
          iconSize: [12, 12], iconAnchor: [6, 6],
        });
        const m = L.marker(p, { icon, draggable: true }).addTo(layer);
        m.on("drag", (ev: any) => {
          if (!ev.target?._map) return; // detached mid-drag
          pointsRef.current = pointsRef.current.map((q, idx) => idx === i ? ev.target.getLatLng() : q);
        });
        m.on("dragend", (ev: any) => { if (ev.target?._map) setTick((t) => t + 1); });
        m.on("click", (ev) => {
          if (!(ev as any).target?._map) return;
          L.DomEvent.stopPropagation(ev);
          pointsRef.current = pointsRef.current.filter((_, idx) => idx !== i);
          setTick((t) => t + 1);
        });
      });
      if (pts.length >= 3 && !fittedRef.current) {
        try { map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 15 }); } catch { /* ignore */ }
        fittedRef.current = true;
      }
    } else {
      const c = centerRef.current;
      if (c) {
        const r = mode === "radius" ? radius : minutes * DRIVE_M_PER_MIN;
        L.circle(c, { radius: r, color: mode === "drive_time" ? "#0891b2" : "#2563eb", weight: 2, fillOpacity: 0.15 }).addTo(layer);
        const icon = L.divIcon({ className: "zone-center", html: `<div style="background:#f59e0b;border:2px solid white;border-radius:9999px;width:14px;height:14px;box-shadow:0 1px 3px rgba(0,0,0,.4)"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] });
        const m = L.marker(c, { icon, draggable: true }).addTo(layer);
        m.on("dragend", (ev: any) => {
          if (!ev.target?._map) return;
          centerRef.current = ev.target.getLatLng();
          setTick((t) => t + 1);
        });
        if (!fittedRef.current) {
          try { map.fitBounds(L.circle(c, { radius: r }).getBounds(), { padding: [30, 30], maxZoom: 14 }); } catch { /* ignore */ }
          fittedRef.current = true;
        }
      }
    }
  }, [tick, mode, radius, minutes]);

  // Reset the fit-once guard whenever the drawing mode changes so a fresh
  // mode gets one fit; individual drags/edits do not refit.
  useEffect(() => { fittedRef.current = false; }, [mode]);

  const currentValue = (): CoverageValue => {
    let polygon: PolygonGeoJSON | null = null;
    if (mode === "polygon" && pointsRef.current.length >= 3) {
      polygon = { type: "Polygon", coordinates: [toRing(pointsRef.current)] };
    }
    const c = centerRef.current;
    return {
      mode,
      polygon,
      centerLat: mode !== "polygon" && c ? c.lat : null,
      centerLng: mode !== "polygon" && c ? c.lng : null,
      radiusMeters: mode === "radius" ? Math.round(radius) : null,
      driveTimeMinutes: mode === "drive_time" ? Math.round(minutes) : null,
    };
  };

  // Controlled mode: report the coverage after every edit. The ref keeps the
  // redraw effect's dependency list unchanged when callers pass inline fns.
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });
  useEffect(() => {
    onChangeRef.current?.(currentValue());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, mode, radius, minutes]);

  // Pan to an externally supplied point (typed ZIP centroid) and seed the
  // center for circle modes so "ZIP + radius" works without a map click.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusPoint) return;
    map.setView([focusPoint.lat, focusPoint.lng], 12);
    if (modeRef.current !== "polygon" && !centerRef.current) {
      centerRef.current = L.latLng(focusPoint.lat, focusPoint.lng);
      setTick((t) => t + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPoint?.lat, focusPoint?.lng]);

  const save = () => onSave?.(currentValue());

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant={mode === "polygon" ? "default" : "outline"} onClick={() => { setMode("polygon"); setTick((t) => t + 1); }}>
            <Pencil className="mr-1 h-3.5 w-3.5 shrink-0" /> Polygon
          </Button>
          <Button size="sm" variant={mode === "radius" ? "default" : "outline"} onClick={() => { setMode("radius"); setTick((t) => t + 1); }}>
            <CircleIcon className="mr-1 h-3.5 w-3.5 shrink-0" /> Radius
          </Button>
          <Button size="sm" variant={mode === "drive_time" ? "default" : "outline"} onClick={() => { setMode("drive_time"); setTick((t) => t + 1); }}>
            <Clock className="mr-1 h-3.5 w-3.5 shrink-0" /> Drive time
          </Button>
          {mode === "polygon" && (
            <>
              <Button size="sm" variant="ghost" onClick={() => { pointsRef.current = pointsRef.current.slice(0, -1); setTick((t) => t + 1); }}>
                <Undo2 className="mr-1 h-3.5 w-3.5 shrink-0" /> Undo
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { pointsRef.current = []; setTick((t) => t + 1); }}>
                <Trash2 className="mr-1 h-3.5 w-3.5 shrink-0" /> Clear
              </Button>
            </>
          )}
        </div>
        {onSave && (
          <Button size="sm" onClick={save} disabled={!!saving}>
            <Save className="mr-1 h-3.5 w-3.5 shrink-0" /> {saving ? "Saving…" : "Save coverage"}
          </Button>
        )}
      </div>

      {mode === "radius" && (
        <div className="flex items-center gap-2 text-sm">
          <MousePointer2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground">Click the map to place the center, then set radius:</span>
          <input type="range" min={500} max={40000} step={500} value={radius} onChange={(e) => setRadius(Number(e.target.value))} className="flex-1" />
          <span className="w-24 text-right tabular-nums">{(radius / 1609).toFixed(1)} mi</span>
        </div>
      )}
      {mode === "drive_time" && (
        <div className="flex items-center gap-2 text-sm">
          <MousePointer2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground">Click the map to place the shop/depot, then set minutes:</span>
          <input type="range" min={5} max={60} step={5} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className="flex-1" />
          <span className="w-24 text-right tabular-nums">{minutes} min</span>
        </div>
      )}
      <div ref={containerRef} style={{ height, width: "100%" }} className="isolate rounded-lg border overflow-hidden z-0" />
      <p className="text-xs text-muted-foreground">
        {mode === "polygon" && "Click to add vertices around the coverage area. Drag or click a point to adjust."}
        {mode === "radius" && "New addresses within this radius from the center are considered in-zone."}
        {mode === "drive_time" && "Approximate: visualized at ~30 mph (800 m/min) from the center. New addresses inside this circle match."}
      </p>
    </div>
  );
}
