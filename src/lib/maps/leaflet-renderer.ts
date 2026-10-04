/**
 * Leaflet + OpenStreetMap behind the MapRenderer interface: THE FALLBACK.
 *
 * Used when no Google browser key is configured, or Google will not load or
 * refuses the key (see google-loader.ts). It exists so that nothing goes
 * blank, not as a second product: the viewport sweeps measure maps through
 * it, because their network fence blocks every non-local host and Google
 * included.
 *
 * Loaded with a dynamic import from create.ts, so a production page that
 * draws with Google never downloads Leaflet, its CSS or its images.
 */
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import { addBaseTiles } from "@/lib/map-tiles";
import type {
  EditableMarkerOptions,
  FitOptions,
  LatLng,
  LineHandle,
  LineOptions,
  MapRenderer,
  MapStyle,
  MapSurfaceOptions,
  MarkerHandle,
  ShapeHandle,
  ShapeStyle,
} from "./types";

// Fix Leaflet default icon paths (they break under bundlers).
//
// These three were unpkg.com URLs. Nothing fetches them today -- every marker
// in this app passes its own icon, there is no L.geoJSON (which would make
// default markers for Point features), and no L.Marker constructed directly --
// so this block is a SAFETY NET for a future marker created without one, not
// a live dependency. It was still worth changing: a net that reaches for a
// CDN is no net at all in a van with no signal, which is the condition this
// app is built to survive. Imported so Vite bundles them.
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

/** RouteMap's wheel gate (the long note above `wheelZoomIntent` there).
 *
 *  Leaflet's wheel handler is OFF and the caller re-implements it under a
 *  gate via `zoomAround`. `scrollWheelZoom: true` is the bug RouteMap shipped
 *  with: the map is docked beside the calendar and ate every scroll that
 *  crossed it — and Leaflet's handler cannot be gated, it binds its own
 *  listener, so having it on as well means two zooms per notch. Two fingers on
 *  a map means zoom on any surface, so pinch is never gated. */
const GATED_WHEEL = { scrollWheelZoom: false, touchZoom: true } as const;

const toLL = (p: LatLng) => L.latLng(p.lat, p.lng);
const fromLL = (p: L.LatLng): LatLng => ({ lat: p.lat, lng: p.lng });

class LeafletRenderer implements MapRenderer {
  readonly provider = "leaflet" as const;
  readonly ownsWheelGate = false;
  private base: L.Layer[] = [];
  private destroyed = false;

  constructor(
    readonly map: L.Map,
    private readonly opts: MapSurfaceOptions,
  ) {
    this.setStyle(opts.style);
    // The touch twin of the plain wheel: a one-finger drag over a docked map
    // is usually somebody trying to scroll the schedule underneath it. A tap
    // arms it, the same tap that arms the wheel.
    if (opts.gestures === "gated" && L.Browser.mobile) map.dragging.disable();
  }

  setView(center: LatLng, zoom: number): void {
    this.map.setView(toLL(center), zoom);
  }

  getZoom(): number {
    return this.map.getZoom();
  }

  fitBounds(points: LatLng[], o: FitOptions): void {
    if (points.length === 0) return;
    try {
      this.map.fitBounds(L.latLngBounds(points.map(toLL)), {
        padding: [o.padding, o.padding],
        maxZoom: o.maxZoom,
      });
    } catch {
      /* a map torn down mid-fit */
    }
  }

  isInView(p: LatLng): boolean {
    return this.map.getBounds().contains(toLL(p));
  }

  setStyle(style: MapStyle): void {
    // Swapped in place rather than rebuilding the map, so pan and zoom survive
    // a style change.
    for (const l of this.base) this.map.removeLayer(l);
    this.base = [];
    const before = new Set<L.Layer>();
    this.map.eachLayer((l) => {
      before.add(l);
    });
    addBaseTiles(L, this.map, style);
    this.map.eachLayer((l) => {
      if (!before.has(l) && l instanceof L.TileLayer) {
        this.base.push(l);
        // Tiles belong underneath every pin and polyline.
        l.setZIndex(0);
      }
    });
  }

  setArmed(armed: boolean): void {
    if (this.opts.gestures !== "gated" || !L.Browser.mobile) return;
    if (armed) this.map.dragging.enable();
    else this.map.dragging.disable();
  }

  zoomAround(clientX: number, clientY: number, delta: number): void {
    // Around the POINTER, not the centre: zooming a route map is "look closer
    // at that stop", and centre-zoom walks the stop off the screen.
    const pt = this.map.mouseEventToContainerPoint({ clientX, clientY } as MouseEvent);
    this.map.setZoomAround(pt, this.map.getZoom() + delta);
  }

  onMapClick(cb: (p: LatLng) => void): () => void {
    const h = (e: L.LeafletMouseEvent) => cb(fromLL(e.latlng));
    this.map.on("click", h);
    return () => {
      this.map.off("click", h);
    };
  }

  addMarker(o: EditableMarkerOptions): MarkerHandle {
    const icon = L.divIcon({
      className: o.className ?? "",
      html: o.html,
      iconSize: o.size,
      iconAnchor: o.anchor,
    });
    const m = L.marker(toLL(o.position), {
      icon,
      title: o.tooltipHtml ? "" : (o.title ?? ""),
      alt: o.title ?? "",
      draggable: !!o.draggable,
      zIndexOffset: o.zIndex ?? 0,
      keyboard: !!(o.onClick || o.popupHtml || o.draggable),
    }).addTo(this.map);
    if (o.popupHtml) m.bindPopup(o.popupHtml);
    // Tooltip as well as popup: a popup needs a click, and "what is this
    // pin?" should not cost one.
    if (o.tooltipHtml)
      m.bindTooltip(o.tooltipHtml, { direction: "top", offset: [0, -12], opacity: 1 });
    if (o.label) {
      m.bindTooltip(o.label.text, {
        permanent: true,
        direction: "top",
        offset: [0, -10],
        className: o.label.className,
      });
    }
    m.on("click", (ev) => {
      L.DomEvent.stopPropagation(ev);
      o.onClick?.();
    });
    if (o.onHover) {
      m.on("mouseover", () => o.onHover?.(true));
      m.on("mouseout", () => o.onHover?.(false));
    }
    if (o.draggable) {
      // A marker detached mid-drag has no map, and Leaflet's mouse plumbing
      // crashes reading it.
      const attached = (ev: L.LeafletEvent) =>
        (ev.target as { _map?: unknown } | undefined)?._map ? (ev.target as L.Marker) : null;
      m.on("drag", (ev) => {
        const t = attached(ev);
        if (t) o.onDrag?.(fromLL(t.getLatLng()));
      });
      m.on("dragend", (ev) => {
        const t = attached(ev);
        if (t) o.onDragEnd?.(fromLL(t.getLatLng()));
      });
    }
    const base = o.zIndex ?? 0;
    return {
      setPosition: (p) => m.setLatLng(toLL(p)),
      setHighlighted: (on) => {
        const inner = m.getElement()?.firstElementChild as HTMLElement | null | undefined;
        if (inner) {
          inner.style.transition = "transform 90ms ease-out";
          inner.style.transform = on ? "scale(1.45)" : "";
          inner.style.filter = on ? "drop-shadow(0 0 6px rgba(0,0,0,.45))" : "";
        }
        m.setZIndexOffset(on ? 1000 : base);
      },
      remove: () => {
        m.remove();
      },
    };
  }

  addPolyline(o: LineOptions): LineHandle {
    const dashed = !!o.dashed;
    const line = L.polyline(o.path.map(toLL), {
      color: o.color,
      weight: o.weight,
      opacity: o.opacity,
      dashArray: dashed ? "6 6" : undefined,
      interactive: false,
    }).addTo(this.map);
    return {
      dashed,
      setStyle: (s) => line.setStyle({ weight: s.weight, opacity: s.opacity }),
      bringToFront: () => {
        line.bringToFront();
      },
      remove: () => {
        line.remove();
      },
    };
  }

  private finishShape(layer: L.Path, s: ShapeStyle): ShapeHandle {
    if (s.popupHtml && s.interactive !== false) layer.bindPopup(s.popupHtml);
    layer.addTo(this.map);
    return {
      remove: () => {
        layer.remove();
      },
    };
  }

  addCircle(center: LatLng, radiusMeters: number, s: ShapeStyle): ShapeHandle {
    return this.finishShape(
      L.circle(toLL(center), {
        radius: radiusMeters,
        color: s.color,
        weight: s.weight,
        opacity: s.opacity ?? 1,
        fillColor: s.fillColor ?? s.color,
        fillOpacity: s.fillOpacity,
        interactive: s.interactive !== false && !!s.popupHtml,
      }),
      s,
    );
  }

  addPolygon(path: LatLng[], s: ShapeStyle): ShapeHandle {
    return this.finishShape(
      L.polygon(path.map(toLL), {
        color: s.color,
        weight: s.weight,
        opacity: s.opacity ?? 1,
        fillColor: s.fillColor ?? s.color,
        fillOpacity: s.fillOpacity,
        interactive: s.interactive !== false && !!s.popupHtml,
      }),
      s,
    );
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      this.map.off();
      this.map.remove();
    } catch {
      /* already gone */
    }
  }
}

export function createLeafletRenderer(container: HTMLElement, o: MapSurfaceOptions): MapRenderer {
  const map = L.map(container, {
    center: toLL(o.initialView.center),
    zoom: o.initialView.zoom,
    maxZoom: o.maxZoom ?? (o.style === "satellite" ? 22 : 19),
    zoomControl: o.zoomControl !== false,
    ...(o.gestures === "map" ? { scrollWheelZoom: true } : GATED_WHEEL),
  });
  // No "Leaflet" link in front of the attribution (2026-10-03, the same
  // owner request that trimmed Google's corner: the small print took a lot of
  // space on a phone). That prefix is Leaflet advertising itself and is not
  // required. The tile layer's own attribution stays: "© OpenStreetMap
  // contributors" is required by the ODbL, and the Esri credit by Esri's terms
  // (src/lib/map-tiles.ts).
  map.attributionControl?.setPrefix(false);
  // Hosts include animated modals and scroll containers; re-measure once
  // layout settles so the map never initializes into a stale size.
  requestAnimationFrame(() => {
    try {
      map.invalidateSize();
    } catch {
      /* removed before the frame */
    }
  });
  return new LeafletRenderer(map, o);
}
