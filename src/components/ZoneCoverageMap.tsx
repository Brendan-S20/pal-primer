import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Undo2, Trash2, Save, MousePointer2, Pencil, Circle as CircleIcon, Clock } from "lucide-react";
import type { PolygonGeoJSON } from "@/components/BoundarySketch";
import { DRIVE_M_PER_MIN } from "@/lib/zone-match";
import { useMapRenderer } from "@/lib/maps/use-map-renderer";
import { OverlayGroup, US_VIEW, circleBoundsPoints, type LatLng } from "@/lib/maps/types";

export type CoverageMode = "polygon" | "radius" | "drive_time";

export type CoverageValue = {
  mode: CoverageMode;
  polygon: PolygonGeoJSON | null;
  centerLat: number | null;
  centerLng: number | null;
  radiusMeters: number | null;
  driveTimeMinutes: number | null;
};

function toRing(latlngs: LatLng[]): number[][] {
  const ring = latlngs.map((p) => [p.lng, p.lat]);
  if (ring.length > 0) {
    const [fx, fy] = ring[0];
    const [lx, ly] = ring[ring.length - 1];
    if (fx !== lx || fy !== ly) ring.push([fx, fy]);
  }
  return ring;
}
function fromPolygon(poly: PolygonGeoJSON | null): LatLng[] {
  if (!poly) return [];
  const ring = poly.coordinates?.[0] ?? [];
  return ring.slice(0, Math.max(0, ring.length - 1)).map(([lng, lat]) => ({ lat, lng }));
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
  const pointsRef = useRef<LatLng[]>(fromPolygon(initial.polygon));
  const centerRef = useRef<LatLng | null>(
    initial.centerLat != null && initial.centerLng != null
      ? { lat: initial.centerLat, lng: initial.centerLng }
      : null,
  );
  const [mode, setMode] = useState<CoverageMode>(initial.mode);
  const modeRef = useRef<CoverageMode>(initial.mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  const [radius, setRadius] = useState<number>(initial.radiusMeters ?? 5000);
  const [minutes, setMinutes] = useState<number>(initial.driveTimeMinutes ?? 15);
  const [tick, setTick] = useState(0);
  const fittedRef = useRef(false);

  const startAt = centerRef.current ?? pointsRef.current[0] ?? null;
  // One map per mount; every edit redraws overlays on it.
  const map = useMapRenderer(containerRef, {
    initialView: startAt ? { center: startAt, zoom: 12 } : US_VIEW,
    style: "street",
    gestures: "map",
    maxZoom: 19,
  });

  useEffect(() => {
    if (!map) return;
    return map.onMapClick((p) => {
      // Read the current mode from the ref — the handler is registered once
      // per map, so closing over the initial `mode` state would misroute
      // clicks after the user switches tabs.
      if (modeRef.current === "polygon") {
        pointsRef.current = [...pointsRef.current, p];
      } else {
        centerRef.current = p;
      }
      setTick((t) => t + 1);
    });
  }, [map]);

  // Redraw on any state change
  useEffect(() => {
    if (!map) return;
    const layer = new OverlayGroup();

    if (mode === "polygon") {
      const pts = pointsRef.current;
      if (pts.length >= 3) {
        layer.add(
          map.addPolygon(pts, {
            color: "#2563eb",
            weight: 2,
            fillColor: "#3b82f6",
            fillOpacity: 0.2,
            interactive: false,
          }),
        );
      } else if (pts.length >= 2) {
        layer.add(
          map.addPolyline({ path: pts, color: "#2563eb", weight: 3, opacity: 1, dashed: true }),
        );
      }
      pts.forEach((p, i) => {
        layer.add(
          map.addMarker({
            position: p,
            className: "zone-vertex",
            html: `<div style="background:${i === 0 ? "#f59e0b" : "#2563eb"};color:white;border:2px solid white;border-radius:9999px;width:12px;height:12px;box-shadow:0 1px 3px rgba(0,0,0,.4)"></div>`,
            size: [12, 12],
            anchor: [6, 6],
            title: `Coverage point ${i + 1}`,
            draggable: true,
            onDrag: (ll) => {
              pointsRef.current = pointsRef.current.map((q, idx) => (idx === i ? ll : q));
            },
            onDragEnd: () => setTick((t) => t + 1),
            onClick: () => {
              pointsRef.current = pointsRef.current.filter((_, idx) => idx !== i);
              setTick((t) => t + 1);
            },
          }),
        );
      });
      if (pts.length >= 3 && !fittedRef.current) {
        map.fitBounds(pts, { padding: 30, maxZoom: 15 });
        fittedRef.current = true;
      }
    } else {
      const c = centerRef.current;
      if (c) {
        const r = mode === "radius" ? radius : minutes * DRIVE_M_PER_MIN;
        layer.add(
          map.addCircle(c, r, {
            color: mode === "drive_time" ? "#0891b2" : "#2563eb",
            weight: 2,
            fillOpacity: 0.15,
            interactive: false,
          }),
        );
        layer.add(
          map.addMarker({
            position: c,
            className: "zone-center",
            html: `<div style="background:#f59e0b;border:2px solid white;border-radius:9999px;width:14px;height:14px;box-shadow:0 1px 3px rgba(0,0,0,.4)"></div>`,
            size: [14, 14],
            anchor: [7, 7],
            title: "Coverage center (drag to move)",
            draggable: true,
            onDragEnd: (ll) => {
              centerRef.current = ll;
              setTick((t) => t + 1);
            },
          }),
        );
        if (!fittedRef.current) {
          map.fitBounds(circleBoundsPoints(c, r), { padding: 30, maxZoom: 14 });
          fittedRef.current = true;
        }
      }
    }
    return () => layer.clear();
  }, [map, tick, mode, radius, minutes]);

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
    if (!map || !focusPoint) return;
    map.setView(focusPoint, 12);
    if (modeRef.current !== "polygon" && !centerRef.current) {
      centerRef.current = { lat: focusPoint.lat, lng: focusPoint.lng };
      setTick((t) => t + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, focusPoint?.lat, focusPoint?.lng]);

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
