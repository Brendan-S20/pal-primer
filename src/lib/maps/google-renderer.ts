/**
 * The Google Maps JavaScript API behind the MapRenderer interface.
 *
 * ── COST, BY CONSTRUCTION ─────────────────────────────────────────────────
 *
 * Google bills Dynamic Maps per MAP LOAD — each `new google.maps.Map` — and
 * nothing per pan, zoom, marker, polyline or redraw. So the whole cost design
 * is about how often that constructor runs, and none of it is about limiting
 * what a person can do with a map once it is there:
 *
 *   * A surface creates its map ONCE and moves overlays on it forever after.
 *     Data refetches, filter changes, hovering, tab switches inside a page —
 *     none of them construct anything. (Components hold the renderer in state
 *     and redraw overlays in effects keyed on their data.)
 *   * When a surface unmounts, its map is not destroyed: it goes to the POOL
 *     below, detached from the page, and the next surface to mount adopts it.
 *     Dashboard -> Routes -> My Day -> a client's yard is one map load, not
 *     four. The pool only grows when two maps are on screen at once, so a page
 *     lifetime costs as many loads as the most maps ever visible together —
 *     typically one, occasionally two (a preview plus its full-screen dialog).
 *   * A map is not created until its container is on screen (see
 *     use-map-renderer.ts), so a map that is scrolled past, collapsed, or
 *     `display: none` on a phone never loads at all.
 *   * Street View is switched off. A pegman drag is a separate, pricier SKU
 *     (Dynamic Street View), and no surface here needs it.
 *
 * ── NO MAP ID NEEDED ──────────────────────────────────────────────────────
 *
 * Pins are HTML drawn through an OverlayView, not Advanced Markers. Advanced
 * Markers require a Map ID, and classic `google.maps.Marker` is deprecated and
 * can only draw images — the numbered, coloured, status-marked pins this app
 * uses are HTML, and the OverlayView keeps them pixel-identical to the
 * Leaflet fallback. So there is nothing for the owner to create in Cloud
 * Console beyond the key itself.
 *
 * ── ATTRIBUTION ───────────────────────────────────────────────────────────
 *
 * Google draws its logo and the data attribution inside the map div. Nothing
 * here hides them and the containers clip only at their own edge; the terms
 * require both to stay visible.
 */
import type {
  EditableMarkerOptions,
  FitOptions,
  LatLng,
  LineHandle,
  LineOptions,
  LineStyle,
  MapRenderer,
  MapStyle,
  MapSurfaceOptions,
  MarkerHandle,
  ShapeHandle,
  ShapeStyle,
} from "./types";
import type {
  GInfoWindow,
  GMap,
  GMapsEventListener,
  GOverlayViewInstance,
  GoogleMapsApi,
} from "./google-types";
import { googleRefused } from "./google-loader";

const MAP_TYPE: Record<MapStyle, string> = { street: "roadmap", satellite: "hybrid" };

/** The 44px floor (CLAUDE.md) for Google's own +/- buttons. Google's default
 *  is 40. Applied at every width rather than guessed from one: the zoom
 *  buttons are the answer for anyone who will not scroll to zoom, and 4px
 *  more on a laptop costs nothing. */
const CONTROL_SIZE = 44;

export function mapOptions(o: MapSurfaceOptions): Record<string, unknown> {
  return {
    center: o.initialView.center,
    zoom: o.initialView.zoom,
    mapTypeId: MAP_TYPE[o.style],
    gestureHandling: o.gestures === "map" ? "greedy" : "cooperative",
    maxZoom: o.maxZoom ?? null,
    zoomControl: o.zoomControl !== false,
    controlSize: CONTROL_SIZE,
    // Off: the pegman opens Street View, a separately billed SKU.
    streetViewControl: false,
    mapTypeControl: false,
    // The app has its own expand control where a map needs one, and a
    // fullscreen API inside a WebView is not something to depend on.
    fullscreenControl: false,
    rotateControl: false,
    cameraControl: false,
    // A tap on a business icon would open Google's place card and swallow the
    // click a drawing surface was waiting for.
    clickableIcons: false,
    // Satellite at yard zoom otherwise tilts to 45° imagery, and a boundary
    // drawn on oblique imagery is drawn on the roofs.
    tilt: 0,
    keyboardShortcuts: true,
  };
}

/** Maps released by unmounted surfaces, waiting for the next one.
 *
 *  Exported with its construction count so the "one load per surface" claim
 *  is a number a test can read rather than a sentence in a comment. */
export class GoogleMapPool {
  private free: GMap[] = [];
  /** How many `new google.maps.Map` calls this pool has made. Each one is a
   *  billed map load. */
  constructions = 0;

  constructor(
    private readonly construct: (div: HTMLElement, opts: Record<string, unknown>) => GMap,
    private readonly createDiv: () => HTMLElement,
  ) {}

  acquire(container: HTMLElement, opts: Record<string, unknown>): GMap {
    const reused = this.free.pop();
    if (reused) {
      container.appendChild(reused.getDiv());
      reused.setOptions(opts);
      return reused;
    }
    const div = this.createDiv();
    div.style.width = "100%";
    div.style.height = "100%";
    container.appendChild(div);
    this.constructions++;
    return this.construct(div, opts);
  }

  release(m: GMap): void {
    m.getDiv().remove();
    this.free.push(m);
  }

  /** After Google refuses the key, a pooled map is a map that will only ever
   *  show Google's error. */
  discardAll(): void {
    this.free = [];
  }

  get idle(): number {
    return this.free.length;
  }
}

let pool: GoogleMapPool | null = null;
/** Which loaded API the pool and the marker class were built against. One per
 *  page lifetime in production; keyed anyway so a second API object can never
 *  be handed maps or overlays built by the first. */
let builtFor: GoogleMapsApi | null = null;
function forApi(g: GoogleMapsApi) {
  if (builtFor !== g) {
    builtFor = g;
    pool = null;
    HtmlMarkerClass = null;
  }
}
export function googleMapPool(g: GoogleMapsApi): GoogleMapPool {
  forApi(g);
  if (!pool) {
    pool = new GoogleMapPool(
      (div, opts) => new g.Map(div, opts),
      () => document.createElement("div"),
    );
  }
  return pool;
}

type HtmlMarkerInstance = GOverlayViewInstance & {
  draw(): void;
  el: HTMLDivElement;
  pos: LatLng;
};

/** One OverlayView subclass per loaded API (the base class only exists once
 *  the script has run, so it cannot be declared at module scope). */
let HtmlMarkerClass:
  (new (o: EditableMarkerOptions, r: GoogleRenderer) => HtmlMarkerInstance) | null = null;

function htmlMarkerClass(g: GoogleMapsApi) {
  forApi(g);
  if (HtmlMarkerClass) return HtmlMarkerClass;
  class HtmlMarker extends g.OverlayView {
    el: HTMLDivElement;
    pos: LatLng;
    constructor(
      private readonly o: EditableMarkerOptions,
      r: GoogleRenderer,
    ) {
      super();
      this.pos = o.position;
      const el = document.createElement("div");
      el.className = `hs-map-marker ${o.className ?? ""}`.trim();
      el.style.position = "absolute";
      el.style.width = `${o.size[0]}px`;
      el.style.height = `${o.size[1]}px`;
      el.style.zIndex = String(o.zIndex ?? 0);
      el.innerHTML = o.html;
      if (o.label) {
        const label = document.createElement("div");
        label.className = `hs-map-marker-label ${o.label.className ?? ""}`.trim();
        label.textContent = o.label.text;
        label.style.cssText =
          "position:absolute;left:50%;bottom:100%;transform:translate(-50%,-4px);" +
          "white-space:nowrap;background:#fff;color:#0f172a;font:600 11px/1.3 system-ui,sans-serif;" +
          "padding:2px 6px;border-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,.3);pointer-events:none";
        el.appendChild(label);
      }
      const interactive = !!(o.onClick || o.popupHtml || o.draggable);
      if (interactive) {
        el.style.cursor = o.draggable ? "grab" : "pointer";
        el.setAttribute("role", "button");
        el.tabIndex = 0;
      }
      if (o.title) {
        el.setAttribute("aria-label", o.title);
        if (!o.tooltipHtml) el.title = o.title;
      }
      // The map must not see presses on a pin: in a drawing surface a click
      // on a vertex removes it, and the same click reaching the map would add
      // a new one under it.
      g.OverlayView.preventMapHitsAndGesturesFrom(el);
      r.wireMarkerElement(el, this as unknown as HtmlMarkerInstance, o);
      this.el = el;
    }
    onAdd() {
      this.getPanes()?.overlayMouseTarget.appendChild(this.el);
    }
    draw() {
      const proj = this.getProjection();
      const p = proj?.fromLatLngToDivPixel(new g.LatLng(this.pos.lat, this.pos.lng));
      if (!p) return;
      this.el.style.left = `${Math.round(p.x - this.o.anchor[0])}px`;
      this.el.style.top = `${Math.round(p.y - this.o.anchor[1])}px`;
    }
    onRemove() {
      this.el.remove();
    }
  }
  HtmlMarkerClass = HtmlMarker as unknown as typeof HtmlMarkerClass;
  return HtmlMarkerClass!;
}

export class GoogleRenderer implements MapRenderer {
  readonly provider = "google" as const;
  readonly ownsWheelGate = true;
  private readonly overlays = new Set<{ setMap(m: GMap | null): void }>();
  private readonly listeners = new Set<GMapsEventListener>();
  private popup: GInfoWindow | null = null;
  private tooltip: GInfoWindow | null = null;
  private z = 10;
  private destroyed = false;

  constructor(
    private readonly g: GoogleMapsApi,
    readonly map: GMap,
    private readonly opts: MapSurfaceOptions,
    private readonly release: (m: GMap) => void,
  ) {}

  setView(center: LatLng, zoom: number): void {
    this.map.setCenter(center);
    this.map.setZoom(zoom);
  }

  getZoom(): number {
    return this.map.getZoom() ?? this.opts.initialView.zoom;
  }

  fitBounds(points: LatLng[], opts: FitOptions): void {
    if (points.length === 0) return;
    if (points.length === 1) {
      this.setView(points[0], opts.maxZoom);
      return;
    }
    const b = new this.g.LatLngBounds();
    for (const p of points) b.extend(p);
    // Google's fitBounds has no maxZoom. Clamp once the fit lands, so a day
    // with two stops on one street fits to the neighbourhood, not a driveway.
    const once = this.g.event.addListenerOnce(this.map, "bounds_changed", () => {
      const z = this.map.getZoom();
      if (z != null && z > opts.maxZoom) this.map.setZoom(opts.maxZoom);
    });
    this.listeners.add(once);
    this.map.fitBounds(b, opts.padding);
  }

  isInView(p: LatLng): boolean {
    return this.map.getBounds()?.contains(p) ?? false;
  }

  setStyle(style: MapStyle): void {
    this.map.setMapTypeId(MAP_TYPE[style]);
  }

  setArmed(armed: boolean): void {
    if (this.opts.gestures !== "gated") return;
    this.map.setOptions({ gestureHandling: armed ? "greedy" : "cooperative" });
  }

  zoomAround(): void {
    /* Google gates and zooms the wheel itself (cooperative gesture handling). */
  }

  onMapClick(cb: (p: LatLng) => void): () => void {
    const l = this.map.addListener("click", (e: { latLng?: { lat(): number; lng(): number } }) => {
      if (e.latLng) cb({ lat: e.latLng.lat(), lng: e.latLng.lng() });
    });
    this.listeners.add(l);
    return () => {
      l.remove();
      this.listeners.delete(l);
    };
  }

  private track<T extends { setMap(m: GMap | null): void }>(o: T): T {
    this.overlays.add(o);
    return o;
  }

  private untrack(o: { setMap(m: GMap | null): void }) {
    o.setMap(null);
    this.overlays.delete(o);
  }

  openPopup(html: string, at: LatLng, offsetY = 0): void {
    this.tooltip?.close();
    if (!this.popup) this.popup = new this.g.InfoWindow();
    this.popup.setContent(html);
    this.popup.setPosition(at);
    this.popup.setOptions({ pixelOffset: new this.g.Size(0, offsetY) });
    this.popup.open({ map: this.map });
  }

  private showTooltip(html: string, at: LatLng, offsetY: number): void {
    if (!this.tooltip) {
      // No auto-pan: a hover that drags the map toward itself moves the pin
      // out from under the pointer and the tooltip closes again.
      this.tooltip = new this.g.InfoWindow({ disableAutoPan: true, headerDisabled: true });
    }
    this.tooltip.setContent(html);
    this.tooltip.setPosition(at);
    this.tooltip.setOptions({ pixelOffset: new this.g.Size(0, offsetY) });
    this.tooltip.open({ map: this.map });
  }

  /** Pointer, keyboard and drag handling for one pin. Called from the
   *  OverlayView's constructor. */
  wireMarkerElement(el: HTMLDivElement, m: HtmlMarkerInstance, o: EditableMarkerOptions): void {
    const offsetY = -Math.round(o.anchor[1]);
    let dragged = false;

    const activate = () => {
      if (o.popupHtml) this.openPopup(o.popupHtml, m.pos, offsetY);
      o.onClick?.();
    };
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (dragged) {
        dragged = false;
        return;
      }
      activate();
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });
    el.addEventListener("mouseenter", () => {
      o.onHover?.(true);
      if (o.tooltipHtml) this.showTooltip(o.tooltipHtml, m.pos, offsetY);
    });
    el.addEventListener("mouseleave", () => {
      o.onHover?.(false);
      if (o.tooltipHtml) this.tooltip?.close();
    });

    if (!o.draggable) return;
    el.style.touchAction = "none";
    el.addEventListener("pointerdown", (down) => {
      if (down.button !== 0) return;
      const rect = this.map.getDiv().getBoundingClientRect();
      const pin = el.getBoundingClientRect();
      const start = { x: down.clientX, y: down.clientY };
      // Where in the pin it was grabbed, so the pin does not jump to centre
      // its anchor on the finger.
      const grab = {
        x: down.clientX - (pin.left + o.anchor[0]),
        y: down.clientY - (pin.top + o.anchor[1]),
      };
      let moving = false;
      el.setPointerCapture?.(down.pointerId);
      const move = (e: PointerEvent) => {
        if (!moving && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) return;
        moving = true;
        el.style.cursor = "grabbing";
        const ll = m
          .getProjection()
          ?.fromContainerPixelToLatLng(
            new this.g.Point(e.clientX - rect.left - grab.x, e.clientY - rect.top - grab.y),
          );
        if (!ll) return;
        m.pos = { lat: ll.lat(), lng: ll.lng() };
        m.draw();
        o.onDrag?.(m.pos);
      };
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        el.style.cursor = "grab";
        if (moving) {
          dragged = true;
          o.onDragEnd?.(m.pos);
        }
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    });
  }

  addMarker(o: EditableMarkerOptions): MarkerHandle {
    const Cls = htmlMarkerClass(this.g);
    const m = this.track(new Cls(o, this));
    m.setMap(this.map);
    const base = String(o.zIndex ?? 0);
    return {
      setPosition: (p) => {
        m.pos = p;
        m.draw();
      },
      setHighlighted: (on) => {
        const inner = m.el.firstElementChild as HTMLElement | null;
        if (inner) {
          inner.style.transition = "transform 90ms ease-out";
          inner.style.transform = on ? "scale(1.45)" : "";
          inner.style.filter = on ? "drop-shadow(0 0 6px rgba(0,0,0,.45))" : "";
        }
        m.el.style.zIndex = on ? "1000" : base;
      },
      remove: () => this.untrack(m),
    };
  }

  addPolyline(o: LineOptions): LineHandle {
    const dashed = !!o.dashed;
    const styleOf = (s: LineStyle) =>
      dashed
        ? {
            strokeOpacity: 0,
            strokeWeight: s.weight,
            // Google has no dashArray. The documented way is a repeated
            // line symbol over an invisible stroke.
            icons: [
              {
                icon: {
                  path: "M 0,-1 0,1",
                  strokeColor: o.color,
                  strokeOpacity: s.opacity,
                  scale: Math.max(1, s.weight),
                },
                offset: "0",
                repeat: `${Math.max(8, s.weight * 5)}px`,
              },
            ],
          }
        : { strokeOpacity: s.opacity, strokeWeight: s.weight };
    const line = this.track(
      new this.g.Polyline({
        path: o.path,
        strokeColor: o.color,
        clickable: false,
        zIndex: 1,
        map: this.map,
        ...styleOf(o),
      }),
    );
    return {
      dashed,
      setStyle: (s) => line.setOptions(styleOf(s)),
      bringToFront: () => line.setOptions({ zIndex: ++this.z }),
      remove: () => this.untrack(line),
    };
  }

  private shape(kind: "Circle" | "Polygon", geometry: Record<string, unknown>, s: ShapeStyle) {
    const interactive = s.interactive !== false && !!s.popupHtml;
    const shape = this.track(
      new this.g[kind]({
        ...geometry,
        strokeColor: s.color,
        strokeWeight: s.weight,
        strokeOpacity: s.opacity ?? 1,
        fillColor: s.fillColor ?? s.color,
        fillOpacity: s.fillOpacity,
        // Not clickable unless it has something to say: a clickable shape
        // swallows the map click a drawing surface adds its points with.
        clickable: interactive,
        zIndex: 0,
        map: this.map,
      }),
    );
    if (interactive && s.popupHtml) {
      const html = s.popupHtml;
      const l = shape.addListener("click", (e: { latLng?: { lat(): number; lng(): number } }) => {
        if (e.latLng) this.openPopup(html, { lat: e.latLng.lat(), lng: e.latLng.lng() });
      });
      this.listeners.add(l);
    }
    return { remove: () => this.untrack(shape) } satisfies ShapeHandle;
  }

  addCircle(center: LatLng, radiusMeters: number, s: ShapeStyle): ShapeHandle {
    return this.shape("Circle", { center, radius: radiusMeters }, s);
  }

  addPolygon(path: LatLng[], s: ShapeStyle): ShapeHandle {
    return this.shape("Polygon", { paths: path }, s);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const o of this.overlays) o.setMap(null);
    this.overlays.clear();
    for (const l of this.listeners) l.remove();
    this.listeners.clear();
    this.popup?.close();
    this.tooltip?.close();
    this.release(this.map);
  }
}

export function createGoogleRenderer(
  g: GoogleMapsApi,
  container: HTMLElement,
  opts: MapSurfaceOptions,
  release?: (m: GMap) => void,
): GoogleRenderer {
  const p = googleMapPool(g);
  const map = p.acquire(container, mapOptions(opts));
  // A map Google has refused the key for only ever shows Google's error, so
  // after a refusal it is dropped instead of pooled.
  const back = (m: GMap) => (googleRefused() ? m.getDiv().remove() : p.release(m));
  return new GoogleRenderer(g, map, opts, release ?? back);
}
