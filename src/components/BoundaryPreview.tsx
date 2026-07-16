import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Maximize2 } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { addBaseTiles } from "@/lib/map-tiles";
import type { PolygonGeoJSON } from "@/components/BoundarySketch";
import { formatArea } from "@/components/BoundarySketch";

/** Renders the boundary polygon into a Leaflet map. Shared by the inline
 * preview and the full-screen dialog. */
function BoundaryMap({
  boundary,
  className,
  style,
  scrollWheelZoom = false,
}: {
  boundary: PolygonGeoJSON;
  className: string;
  style?: React.CSSProperties;
  scrollWheelZoom?: boolean;
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
      scrollWheelZoom,
    });
    addBaseTiles(map, "satellite");
    const poly = L.polygon(pts, { color: "#16a34a", weight: 2, fillOpacity: 0.15 });
    poly.addTo(map);
    map.fitBounds(poly.getBounds(), { padding: [24, 24], maxZoom: 20 });
    requestAnimationFrame(() => map.invalidateSize());

    return () => {
      map.remove();
    };
  }, [boundary, scrollWheelZoom]);

  // isolate: Leaflet panes use z-index 400+; without a contained stacking
  // context they paint over dropdowns and popovers.
  return <div ref={containerRef} style={style} className={className} />;
}

/**
 * Read-only view of a property's sketched service boundary (client detail
 * page), with an expand control (UX round 4) that opens the same map
 * full-screen in a dialog instead of navigating anywhere.
 */
export function BoundaryPreview({
  boundary,
  areaSqm,
  height = 320,
  title = "Service boundary",
}: {
  boundary: PolygonGeoJSON;
  areaSqm?: number | null;
  height?: number;
  /** Dialog heading when expanded, e.g. the property address. */
  title?: string;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <div className="relative">
        <BoundaryMap
          boundary={boundary}
          style={{ height }}
          className="isolate z-0 w-full overflow-hidden rounded-md border"
        />
        {/* Sits just below Leaflet's zoom control, mirroring its look. */}
        <button
          type="button"
          aria-label="Expand map"
          title="Expand map"
          onClick={() => setExpanded(true)}
          className="absolute left-[10px] top-[80px] z-10 flex h-[30px] w-[30px] items-center justify-center rounded-[4px] border-2 border-black/20 bg-white text-black hover:bg-neutral-100"
        >
          <Maximize2 className="h-4 w-4" />
        </button>
      </div>
      {areaSqm != null && (
        <p className="mt-2 text-xs text-muted-foreground">
          Sketched area: {formatArea(Number(areaSqm))}
        </p>
      )}

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="flex h-[92vh] w-[96vw] max-w-none flex-col gap-3 p-4 sm:max-w-none">
          <DialogTitle className="pr-8 text-base">
            {title}
            {areaSqm != null && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {formatArea(Number(areaSqm))}
              </span>
            )}
          </DialogTitle>
          {expanded && (
            <BoundaryMap
              boundary={boundary}
              scrollWheelZoom
              className="isolate z-0 min-h-0 flex-1 overflow-hidden rounded-md border"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
