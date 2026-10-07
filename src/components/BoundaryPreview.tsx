import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2 } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { PolygonGeoJSON } from "@/components/BoundarySketch";
import { formatArea } from "@/components/BoundarySketch";
import { useMapRenderer } from "@/lib/maps/use-map-renderer";
import { US_VIEW, type GestureMode, type LatLng } from "@/lib/maps/types";

/** Draws the boundary polygon on a satellite map. Shared by the inline
 * preview and the full-screen dialog.
 *
 * The map is made once per mount and the polygon is redrawn on it when the
 * boundary's GEOMETRY changes — keyed on the coordinates, not the object, so
 * a refetch that returns the same yard neither rebuilds anything nor flings
 * the view back to the fit. It used to rebuild the whole map on every new
 * `boundary` object, which on Google would be a billed load per refetch. */
function BoundaryMap({
  boundary,
  className,
  style,
  gestures = "page",
}: {
  boundary: PolygonGeoJSON;
  className: string;
  style?: React.CSSProperties;
  gestures?: GestureMode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ringKey = JSON.stringify(boundary.coordinates?.[0] ?? []);
  const ring = useMemo<LatLng[]>(
    () => (JSON.parse(ringKey) as number[][]).map(([lng, lat]) => ({ lat, lng })),
    [ringKey],
  );
  const renderer = useMapRenderer(containerRef, {
    initialView: ring[0] ? { center: ring[0], zoom: 19 } : US_VIEW,
    style: "satellite",
    gestures,
    maxZoom: 22,
  });

  useEffect(() => {
    if (!renderer || ring.length < 3) return;
    const poly = renderer.addPolygon(ring, {
      color: "#16a34a",
      weight: 2,
      fillOpacity: 0.15,
      interactive: false,
    });
    renderer.fitBounds(ring, { padding: 24, maxZoom: 20 });
    return () => poly.remove();
  }, [renderer, ring]);

  // isolate: map panes use z-index 400+; without a contained stacking
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
        {/* Top-left, below the fallback's zoom buttons (Google's sit at the
            bottom right, so this is clear of both). */}
        <button
          type="button"
          aria-label="Expand map"
          title="Expand map"
          onClick={() => setExpanded(true)}
          className="absolute left-[10px] top-[80px] z-10 flex h-[30px] w-[30px] items-center justify-center rounded-[4px] border-2 border-black/20 bg-white text-black hover:bg-neutral-100"
        >
          <Maximize2 className="h-4 w-4 shrink-0" />
        </button>
      </div>
      {areaSqm != null && (
        <p className="mt-2 text-xs text-muted-foreground">
          Sketched area: {formatArea(Number(areaSqm))}
        </p>
      )}

      <Dialog open={expanded} onOpenChange={setExpanded}>
        {/* `h-dvh` asks for the whole screen and ui/dialog.tsx's cap takes it
            back down to the safe region: clear of the status bar and the home
            indicator in the iOS app, where the old 92vh put the title under
            the clock. The width loses the side insets for landscape. The map
            fills what is left and scrolls nothing, so the panel's own scroll
            never engages. */}
        <DialogContent className="flex h-dvh w-[calc(100vw_-_1rem_-_env(safe-area-inset-left)_-_env(safe-area-inset-right))] max-w-none flex-col gap-3 p-4 sm:max-w-none">
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
              gestures="map"
              className="isolate z-0 min-h-0 flex-1 overflow-hidden rounded-md border"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
