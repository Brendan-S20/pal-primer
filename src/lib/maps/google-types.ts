/**
 * The slice of the `google.maps` namespace this app touches, typed by hand.
 *
 * Not `@types/google.maps`: that package would be a dependency for the sake of
 * about thirty signatures, and pinning the API version (google-loader.ts)
 * already means these do not move under us. If a call here is wrong, the
 * Google-path test (tests/google-draws-the-maps.test.ts) and the browser spec
 * (tests/viewports/a-map-is-paid-for-once.spec.ts) drive it against a stub
 * that implements the same shapes.
 */

export interface GLatLng {
  lat(): number;
  lng(): number;
}

export interface GLatLngBounds {
  extend(p: GLatLng | { lat: number; lng: number }): GLatLngBounds;
  contains(p: GLatLng | { lat: number; lng: number }): boolean;
}

/** Any listener. `never[]` rather than `any[]`: every concrete handler
 *  (`(e: { latLng?: … }) => void`) is assignable to it, and nothing can call
 *  it with arguments it did not declare. */
export type GHandler = (...args: never[]) => void;

export interface GMapsEventListener {
  remove(): void;
}

export interface GMVCObject {
  addListener(event: string, cb: GHandler): GMapsEventListener;
  setOptions(o: Record<string, unknown>): void;
}

export interface GMap extends GMVCObject {
  getDiv(): HTMLElement;
  fitBounds(b: GLatLngBounds, padding?: number): void;
  getZoom(): number | undefined;
  setZoom(z: number): void;
  setCenter(c: { lat: number; lng: number }): void;
  getBounds(): GLatLngBounds | null | undefined;
  setMapTypeId(id: string): void;
}

export interface GOverlayLike {
  setMap(m: GMap | null): void;
}

export interface GShape extends GMVCObject, GOverlayLike {}

export interface GInfoWindow {
  setContent(html: string): void;
  setPosition(p: { lat: number; lng: number }): void;
  setOptions(o: Record<string, unknown>): void;
  open(o: { map: GMap }): void;
  close(): void;
}

export interface GMapCanvasProjection {
  fromLatLngToDivPixel(p: GLatLng): { x: number; y: number } | null;
  fromContainerPixelToLatLng(p: { x: number; y: number }): GLatLng | null;
}

export interface GOverlayViewInstance extends GOverlayLike {
  getPanes(): { overlayMouseTarget: HTMLElement; floatPane: HTMLElement } | null;
  getProjection(): GMapCanvasProjection | null;
}

export interface GoogleMapsApi {
  Map: new (div: HTMLElement, opts: Record<string, unknown>) => GMap;
  OverlayView: (new () => GOverlayViewInstance) & {
    preventMapHitsAndGesturesFrom(el: HTMLElement): void;
  };
  Polyline: new (opts: Record<string, unknown>) => GShape;
  Polygon: new (opts: Record<string, unknown>) => GShape;
  Circle: new (opts: Record<string, unknown>) => GShape;
  InfoWindow: new (opts?: Record<string, unknown>) => GInfoWindow;
  LatLng: new (lat: number, lng: number) => GLatLng;
  LatLngBounds: new () => GLatLngBounds;
  Point: new (x: number, y: number) => { x: number; y: number };
  Size: new (w: number, h: number) => { width: number; height: number };
  event: {
    addListenerOnce(o: GMVCObject, event: string, cb: GHandler): GMapsEventListener;
  };
}
