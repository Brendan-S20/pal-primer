/**
 * The map layer's vocabulary. Every map in the app draws through one of these
 * renderers and never through Leaflet or `google.maps` directly.
 *
 * ── WHY AN INTERFACE AND NOT JUST GOOGLE ──────────────────────────────────
 *
 * Three implementations exist or are planned, and the components should not
 * have to know which one they got:
 *
 *   * Google Maps JavaScript API (`google-renderer.ts`) — production, whenever
 *     a browser key is configured.
 *   * Leaflet + OpenStreetMap (`leaflet-renderer.ts`) — the fallback when no
 *     key is configured (local dev, unit tests, the viewport sweeps behind a
 *     network fence) or when Google refuses to load. Nothing goes blank.
 *   * A native Maps SDK (owner decision 2026-10-02, NOT built): after launch
 *     the technician's read-only route map may be drawn by
 *     `@capacitor/google-maps` inside the native app, because the native SDKs
 *     are free and unlimited. That renderer would have to satisfy
 *     `ReadOnlyMapRenderer` below and nothing more — which is why that type
 *     exists separately from `MapRenderer`. RouteMap is typed against the
 *     read-only half, so the seam is checked by the compiler rather than by a
 *     comment. Editing surfaces (BoundarySketch, StationMapPicker,
 *     ZoneCoverageMap) use the full `MapRenderer` and are expected to stay on
 *     the JavaScript API.
 *
 * One thing a native renderer will need that the two web ones do not: pins
 * here are HTML strings, and the native SDK draws bitmaps under the WebView.
 * It would rasterise `MarkerOptions.html` (or switch on `className`) rather
 * than change this interface.
 */

export type LatLng = { lat: number; lng: number };

/** Which imagery the SURFACE needs. `satellite` is photographic imagery with
 *  roads and labels over it (Google: "hybrid"); it is chosen by surfaces where
 *  seeing the actual yard matters, never offered as a preference. */
export type MapStyle = "street" | "satellite";

/** How plain gestures are shared between the map and the page.
 *
 *  - `map`: a plain wheel zooms and one finger pans. For editors, where the
 *    map IS the task.
 *  - `page`: a plain wheel scrolls the page; ctrl/⌘ + wheel or a pinch zooms.
 *  - `gated`: like `page` until `setArmed(true)` (RouteMap arms on a click or
 *    tap), after which it behaves like `map`. See the long note in RouteMap. */
export type GestureMode = "map" | "page" | "gated";

export type MapViewInit = {
  center: LatLng;
  zoom: number;
};

export type MapSurfaceOptions = {
  /** Where to look before any overlay asks for a fit. */
  initialView: MapViewInit;
  style: MapStyle;
  gestures: GestureMode;
  maxZoom?: number;
  /** Show the +/- zoom buttons. Default true. */
  zoomControl?: boolean;
};

export type MarkerOptions = {
  position: LatLng;
  /** The pin, as HTML. Escaped by the caller. */
  html: string;
  /** A class for the wrapper, e.g. "route-marker". */
  className?: string;
  size: [number, number];
  anchor: [number, number];
  /** Accessible name; also the native tooltip where there is no tooltipHtml. */
  title?: string;
  /** Higher draws on top. */
  zIndex?: number;
  /** Opened by a click / tap. */
  popupHtml?: string;
  /** Opened by a mouse hover. Never the only way to reach anything: hover does
   *  not exist on a phone, so anything here is also in `popupHtml`. */
  tooltipHtml?: string;
  /** Always-visible label above the pin ("You are here"). */
  label?: { text: string; permanent: true; className?: string };
  onClick?: () => void;
  onHover?: (over: boolean) => void;
};

export type EditableMarkerOptions = MarkerOptions & {
  draggable?: boolean;
  /** Fires continuously while dragging. */
  onDrag?: (p: LatLng) => void;
  onDragEnd?: (p: LatLng) => void;
};

export interface MarkerHandle {
  setPosition(p: LatLng): void;
  /** Make one pin stand out (another pane is hovering its visit). */
  setHighlighted(on: boolean): void;
  remove(): void;
}

export type LineStyle = { weight: number; opacity: number };

export type LineOptions = LineStyle & {
  path: LatLng[];
  color: string;
  dashed?: boolean;
};

export interface LineHandle {
  readonly dashed: boolean;
  setStyle(s: LineStyle): void;
  bringToFront(): void;
  remove(): void;
}

export type ShapeStyle = {
  color: string;
  weight: number;
  opacity?: number;
  fillColor?: string;
  fillOpacity: number;
  /** Opened by a click / tap on the shape. */
  popupHtml?: string;
  /** False lets clicks fall through to the map (drawing, an accuracy ring). */
  interactive?: boolean;
};

export interface ShapeHandle {
  remove(): void;
}

export type FitOptions = { padding: number; maxZoom: number };

/** Everything a map that only SHOWS things needs. The native seam. */
export interface ReadOnlyMapRenderer {
  readonly provider: "google" | "leaflet";
  /** True when the provider gates the wheel itself (Google's cooperative
   *  gesture handling shows its own "use ctrl + scroll" hint). When false the
   *  caller's own wheel gate does the zooming via `zoomAround`. */
  readonly ownsWheelGate: boolean;
  setView(center: LatLng, zoom: number): void;
  getZoom(): number;
  fitBounds(points: LatLng[], opts: FitOptions): void;
  addMarker(o: MarkerOptions): MarkerHandle;
  addPolyline(o: LineOptions): LineHandle;
  addCircle(center: LatLng, radiusMeters: number, style: ShapeStyle): ShapeHandle;
  addPolygon(path: LatLng[], style: ShapeStyle): ShapeHandle;
  /** Returns an unsubscribe. */
  onMapClick(cb: (p: LatLng) => void): () => void;
  setStyle(style: MapStyle): void;
  /** Only meaningful for `gestures: "gated"`. */
  setArmed(armed: boolean): void;
  /** Zoom by `delta` levels around a viewport point. Used by a caller-owned
   *  wheel gate; a no-op where `ownsWheelGate` is true. */
  zoomAround(clientX: number, clientY: number, delta: number): void;
}

/** The full renderer, for surfaces that edit. */
export interface MapRenderer extends ReadOnlyMapRenderer {
  addMarker(o: EditableMarkerOptions): MarkerHandle;
  isInView(p: LatLng): boolean;
  /** Tear down. A Google map goes back to the pool for the next surface. */
  destroy(): void;
}

/** A set of overlays cleared together — the shape Leaflet's LayerGroup gave
 *  every component, kept so each one still reads "clear, then redraw". */
export class OverlayGroup {
  private items: Array<{ remove(): void }> = [];
  add<T extends { remove(): void }>(h: T): T {
    this.items.push(h);
    return h;
  }
  clear(): void {
    const items = this.items;
    this.items = [];
    for (const h of items) h.remove();
  }
}

/** Points on a circle's bounding box, for fitting a view to a radius. */
export function circleBoundsPoints(center: LatLng, radiusMeters: number): LatLng[] {
  const dLat = radiusMeters / 111_320;
  const dLng = radiusMeters / (111_320 * Math.max(0.01, Math.cos((center.lat * Math.PI) / 180)));
  return [
    { lat: center.lat - dLat, lng: center.lng - dLng },
    { lat: center.lat + dLat, lng: center.lng + dLng },
  ];
}

/** Continental-US default view, used wherever nothing better is known yet. */
export const US_VIEW: MapViewInit = { center: { lat: 39.5, lng: -98.35 }, zoom: 4 };
