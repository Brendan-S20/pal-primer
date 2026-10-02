/* eslint-disable @typescript-eslint/no-explicit-any -- stands in for, and reads back from, an untyped foreign API on `window`. */
/**
 * A stand-in for the Google Maps JavaScript API, just wide enough for
 * src/lib/maps/google-renderer.ts, that COUNTS the thing Google bills for:
 * `new google.maps.Map`.
 *
 * Used twice:
 *   * tests/google-draws-the-maps.test.ts installs it in node, over a tiny
 *     fake DOM, to drive the renderer and the pool directly;
 *   * tests/viewports/a-map-is-paid-for-once.spec.ts serves it AS the Maps
 *     script (`installFakeGoogleMaps.toString()`), so a real browser runs the
 *     app's real loader, real components and real navigation against it.
 *
 * Because of the second use it must be SELF-CONTAINED: no imports, no
 * references to anything outside its own body, plain classes. It is
 * serialised into a page.
 *
 * Read back through `window.__fakeGoogleMaps`:
 *   maps         — how many maps were constructed (= billed map loads)
 *   liveOverlays — overlays currently on a map; a redraw that leaks them
 *                  shows up as this growing
 *   scripts      — how many times the script itself ran
 */
export function installFakeGoogleMaps(w: any): void {
  const counters = (w.__fakeGoogleMaps = w.__fakeGoogleMaps || {
    maps: 0,
    liveOverlays: 0,
    scripts: 0,
  });
  counters.scripts++;
  const doc = w.document;

  class MVC {
    _l: Record<string, Array<(...a: any[]) => void>>;
    opts: Record<string, any>;
    constructor() {
      this._l = {};
      this.opts = {};
    }
    addListener(e: string, cb: (...a: any[]) => void) {
      (this._l[e] = this._l[e] || []).push(cb);
      return {
        remove: () => {
          this._l[e] = (this._l[e] || []).filter((f) => f !== cb);
        },
      };
    }
    trigger(e: string, ...a: any[]) {
      for (const f of [...(this._l[e] || [])]) f(...a);
    }
    setOptions(o: Record<string, any>) {
      this.opts = { ...this.opts, ...o };
    }
  }

  class LatLng {
    a: number;
    b: number;
    constructor(a: number, b: number) {
      this.a = a;
      this.b = b;
    }
    lat() {
      return this.a;
    }
    lng() {
      return this.b;
    }
  }
  const plain = (p: any) =>
    typeof p.lat === "function" ? { lat: p.lat(), lng: p.lng() } : { lat: p.lat, lng: p.lng };

  class LatLngBounds {
    pts: Array<{ lat: number; lng: number }>;
    constructor() {
      this.pts = [];
    }
    extend(p: any) {
      this.pts.push(plain(p));
      return this;
    }
    contains() {
      return true;
    }
  }

  class GMap extends MVC {
    div: any;
    layer: any;
    center: { lat: number; lng: number };
    zoom: number;
    constructor(div: any, opts: Record<string, any>) {
      super();
      counters.maps++;
      this.div = div;
      this.opts = { ...opts };
      this.center = opts.center || { lat: 0, lng: 0 };
      this.zoom = opts.zoom ?? 4;
      div.setAttribute("data-fake-google-map", String(counters.maps));
      this.layer = doc.createElement("div");
      this.layer.style.position = "absolute";
      this.layer.style.left = "0px";
      this.layer.style.top = "0px";
      div.appendChild(this.layer);
    }
    setOptions(o: Record<string, any>) {
      super.setOptions(o);
      if (o.center) this.center = o.center;
      if (o.zoom != null) this.zoom = o.zoom;
    }
    getDiv() {
      return this.div;
    }
    fitBounds() {
      this.zoom = 21;
      this.trigger("bounds_changed");
    }
    getZoom() {
      return this.zoom;
    }
    setZoom(z: number) {
      this.zoom = z;
    }
    setCenter(c: any) {
      this.center = plain(c);
    }
    getBounds() {
      return new LatLngBounds();
    }
    setMapTypeId(id: string) {
      this.opts.mapTypeId = id;
    }
  }

  class OverlayView {
    _map: GMap | null;
    constructor() {
      this._map = null;
    }
    setMap(m: GMap | null) {
      if (this._map) {
        counters.liveOverlays--;
        (this as any).onRemove?.();
      }
      this._map = m;
      if (m) {
        counters.liveOverlays++;
        (this as any).onAdd?.();
        (this as any).draw?.();
      }
    }
    getPanes() {
      return this._map ? { overlayMouseTarget: this._map.layer, floatPane: this._map.layer } : null;
    }
    getProjection() {
      const m = this._map;
      if (!m) return null;
      // A flat projection around the centre: enough to place pins inside the
      // box and to round-trip a drag.
      return {
        fromLatLngToDivPixel: (ll: any) => ({
          x: (ll.lng() - m.center.lng) * 1000 + 100,
          y: (m.center.lat - ll.lat()) * 1000 + 100,
        }),
        fromContainerPixelToLatLng: (p: { x: number; y: number }) =>
          new LatLng(m.center.lat - (p.y - 100) / 1000, m.center.lng + (p.x - 100) / 1000),
      };
    }
    static preventMapHitsAndGesturesFrom() {}
  }

  class Shape extends MVC {
    _map: GMap | null;
    constructor(o: Record<string, any>) {
      super();
      this._map = null;
      this.opts = { ...o };
      this.setMap(o.map || null);
    }
    setMap(m: GMap | null) {
      if (this._map) counters.liveOverlays--;
      this._map = m;
      if (m) counters.liveOverlays++;
    }
  }

  class InfoWindow {
    isOpen: boolean;
    content: string;
    constructor() {
      this.isOpen = false;
      this.content = "";
    }
    setContent(c: string) {
      this.content = c;
    }
    setPosition() {}
    setOptions() {}
    open() {
      this.isOpen = true;
    }
    close() {
      this.isOpen = false;
    }
  }

  class Point {
    x: number;
    y: number;
    constructor(x: number, y: number) {
      this.x = x;
      this.y = y;
    }
  }
  class Size {
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
  }

  const maps: Record<string, any> = {
    Map: GMap,
    OverlayView,
    Polyline: Shape,
    Polygon: Shape,
    Circle: Shape,
    InfoWindow,
    LatLng,
    LatLngBounds,
    Point,
    Size,
    event: {
      addListenerOnce(o: MVC, e: string, cb: (...a: any[]) => void) {
        const l = o.addListener(e, (...a: any[]) => {
          l.remove();
          cb(...a);
        });
        return l;
      },
    },
    importLibrary: async () => maps,
  };
  w.google = { maps };
}
