/* eslint-disable @typescript-eslint/no-explicit-any -- stands in for, and reads back from, an untyped foreign API on `window`. */
// Every map moved from OpenStreetMap's tiles to the Google Maps JavaScript
// API on 2026-10-02, on a limited budget and with one condition from the
// owner: nobody is limited in how much they pan or zoom. So cost has to be
// low BY CONSTRUCTION, and Google's price list says where to look — Dynamic
// Maps bills per map LOAD (each `new google.maps.Map`), and panning, zooming
// and redrawing a loaded map are free.
//
// This file pins the parts of that design that can be checked in node:
//
//   * the pool: a surface that unmounts gives its map back, and the next one
//     adopts it, so navigating between map pages is not a load per page;
//   * the renderer: redrawing overlays a hundred times constructs nothing and
//     leaks nothing;
//   * the loader: one script per page lifetime, a key from the build or the
//     server, and a fallback — never a blank map — when there is no key, the
//     script fails, or Google refuses the key;
//   * the seams: no component talks to Leaflet or Google directly, and the
//     read-only route map is typed against the half of the interface a
//     native renderer could satisfy.
//
// What it cannot see is React: whether a component really keeps one map
// across re-renders, tab switches and navigation. That runs in a browser, in
// tests/viewports/a-map-is-paid-for-once.spec.ts, against the same fake.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { installFakeGoogleMaps } from "./support/fake-google-maps";

const getMapsBrowserKey = vi.fn<() => Promise<{ key: string | null }>>();
vi.mock("@/lib/maps-key.functions", () => ({
  getMapsBrowserKey: () => getMapsBrowserKey(),
}));
const fakeLeaflet = { provider: "leaflet" };
vi.mock("@/lib/maps/leaflet-renderer", () => ({
  createLeafletRenderer: () => fakeLeaflet,
}));

import {
  GoogleMapPool,
  createGoogleRenderer,
  googleMapPool,
  mapOptions,
} from "@/lib/maps/google-renderer";
import {
  MAPS_JS_VERSION,
  __resetGoogleLoaderForTests,
  loadGoogleMaps,
  resolveBrowserKey,
} from "@/lib/maps/google-loader";
import { createMapRenderer } from "@/lib/maps/create";
import { US_VIEW, type MapSurfaceOptions } from "@/lib/maps/types";
import type { GoogleMapsApi } from "@/lib/maps/google-types";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .map((l) => l.replace(/\s\/\/.*$/, ""))
    .join("\n");

// ── A DOM just wide enough for the renderer ──────────────────────────────
//
// There is no jsdom in this repo, and installing one for this file would be a
// dependency for the sake of a dozen methods. The renderer creates divs, sets
// styles and attributes, appends, removes and listens; that is all this does.
class FakeEl {
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  className = "";
  innerHTML = "";
  textContent = "";
  title = "";
  tabIndex = -1;
  listeners: Record<string, Array<(e: any) => void>> = {};
  get firstElementChild() {
    return this.children[0] ?? null;
  }
  appendChild(c: FakeEl) {
    c.parent?.children.splice(c.parent.children.indexOf(c), 1);
    c.parent = this;
    this.children.push(c);
    return c;
  }
  append(c: FakeEl) {
    this.appendChild(c);
  }
  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  addEventListener(t: string, cb: (e: any) => void) {
    (this.listeners[t] = this.listeners[t] ?? []).push(cb);
  }
  removeEventListener() {}
  dispatch(t: string, e: any = {}) {
    for (const cb of this.listeners[t] ?? [])
      cb({ stopPropagation() {}, preventDefault() {}, ...e });
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 400, height: 300 };
  }
}

const head = new FakeEl();
const fakeWindow: any = {
  document: { createElement: () => new FakeEl(), head },
};

beforeEach(() => {
  vi.stubGlobal("window", fakeWindow);
  vi.stubGlobal("document", fakeWindow.document);
  vi.stubEnv("VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY", "");
  delete fakeWindow.google;
  delete fakeWindow.__fakeGoogleMaps;
  head.children = [];
  getMapsBrowserKey.mockReset();
  __resetGoogleLoaderForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const surface = (o: Partial<MapSurfaceOptions> = {}): MapSurfaceOptions => ({
  initialView: US_VIEW,
  style: "street",
  gestures: "page",
  ...o,
});

function fakeGoogle(): GoogleMapsApi {
  installFakeGoogleMaps(fakeWindow);
  return fakeWindow.google.maps as GoogleMapsApi;
}
const counters = () => fakeWindow.__fakeGoogleMaps as { maps: number; liveOverlays: number };

describe("a map is paid for once per surface, not once per render", () => {
  it("hands a released map to the next surface instead of building another", () => {
    const g = fakeGoogle();
    const pool = new GoogleMapPool(
      (div, opts) => new g.Map(div, opts),
      () => new FakeEl() as unknown as HTMLElement,
    );
    const a = new FakeEl() as unknown as HTMLElement;
    const b = new FakeEl() as unknown as HTMLElement;

    // Mount, unmount, mount somewhere else — the dashboard, then /routes,
    // then My Day, ten times over.
    for (let i = 0; i < 10; i++) {
      const m = pool.acquire(i % 2 ? a : b, mapOptions(surface()));
      pool.release(m);
    }
    expect(pool.constructions).toBe(1);
    expect(counters().maps).toBe(1);

    // Two on screen at once (a preview and its full-screen dialog) is two —
    // and only ever two, however often the dialog opens.
    for (let i = 0; i < 5; i++) {
      const m1 = pool.acquire(a, mapOptions(surface()));
      const m2 = pool.acquire(b, mapOptions(surface()));
      pool.release(m2);
      pool.release(m1);
    }
    expect(pool.constructions).toBe(2);
  });

  it("moves the reused map into the new container and re-applies the new surface's options", () => {
    const g = fakeGoogle();
    const pool = new GoogleMapPool(
      (div, opts) => new g.Map(div, opts),
      () => new FakeEl() as unknown as HTMLElement,
    );
    const a = new FakeEl();
    const b = new FakeEl();
    const m = pool.acquire(a as unknown as HTMLElement, mapOptions(surface()));
    pool.release(m);
    expect(a.children).toHaveLength(0);
    const again = pool.acquire(
      b as unknown as HTMLElement,
      mapOptions(surface({ style: "satellite", gestures: "map" })),
    );
    expect(again).toBe(m);
    expect(b.children).toHaveLength(1);
    expect((m as any).opts.mapTypeId).toBe("hybrid");
    expect((m as any).opts.gestureHandling).toBe("greedy");
  });

  it("redraws a hundred times on one map, and leaves nothing behind", () => {
    const g = fakeGoogle();
    const container = new FakeEl() as unknown as HTMLElement;
    const r = createGoogleRenderer(g, container, surface({ gestures: "gated" }));
    const before = googleMapPool(g).constructions;

    // What a schedule refetch does: clear, then draw pins, legs and a ring.
    let drawn: Array<{ remove(): void }> = [];
    for (let i = 0; i < 100; i++) {
      for (const h of drawn) h.remove();
      drawn = [
        r.addMarker({
          position: { lat: 42 + i / 1000, lng: -83 },
          html: "<div>1</div>",
          className: "route-marker",
          size: [26, 26],
          anchor: [13, 13],
          title: "#1 · Somebody",
          popupHtml: "<b>Somebody</b>",
          tooltipHtml: "<b>Somebody</b>",
        }),
        r.addPolyline({
          path: [
            { lat: 42, lng: -83 },
            { lat: 42.01, lng: -83.01 },
          ],
          color: "#2563eb",
          weight: 3,
          opacity: 0.7,
        }),
        r.addPolyline({
          path: [
            { lat: 42, lng: -83 },
            { lat: 42.02, lng: -83.02 },
          ],
          color: "#2563eb",
          weight: 2,
          opacity: 0.5,
          dashed: true,
        }),
        r.addCircle({ lat: 42, lng: -83 }, 30, { color: "#0f172a", weight: 1, fillOpacity: 0.08 }),
        r.addPolygon(
          [
            { lat: 42, lng: -83 },
            { lat: 42.001, lng: -83 },
            { lat: 42.001, lng: -83.001 },
          ],
          { color: "#16a34a", weight: 2, fillOpacity: 0.15 },
        ),
      ];
      r.fitBounds(
        [
          { lat: 42, lng: -83 },
          { lat: 42.1, lng: -83.1 },
        ],
        { padding: 30, maxZoom: 14 },
      );
    }
    expect(googleMapPool(g).constructions).toBe(before);
    expect(counters().liveOverlays).toBe(5);

    // Destroy returns the map and takes every overlay off it.
    r.destroy();
    expect(counters().liveOverlays).toBe(0);
    expect(googleMapPool(g).idle).toBeGreaterThan(0);
  });

  it("caps a fit at the surface's max zoom, which Google's fitBounds cannot do itself", () => {
    const g = fakeGoogle();
    const r = createGoogleRenderer(g, new FakeEl() as unknown as HTMLElement, surface());
    // The fake zooms every fit to 21, as Google does for two stops on a street.
    r.fitBounds(
      [
        { lat: 42, lng: -83 },
        { lat: 42.0001, lng: -83.0001 },
      ],
      { padding: 30, maxZoom: 14 },
    );
    expect(r.getZoom()).toBe(14);
    // One point: no fit at all, straight to the cap.
    r.fitBounds([{ lat: 42, lng: -83 }], { padding: 30, maxZoom: 17 });
    expect(r.getZoom()).toBe(17);
    r.destroy();
  });

  it("draws pins as HTML a finger and a screen reader can both use", () => {
    const g = fakeGoogle();
    const container = new FakeEl();
    const r = createGoogleRenderer(g, container as unknown as HTMLElement, surface());
    const clicked = vi.fn();
    r.addMarker({
      position: { lat: 42, lng: -83 },
      html: '<div class="pin">3</div>',
      className: "route-marker",
      size: [26, 26],
      anchor: [13, 13],
      title: "#3 · A client",
      onClick: clicked,
    });
    const mapDiv = container.children[0];
    const layer = mapDiv.children[0];
    const pin = layer.children[0];
    expect(pin.className).toBe("hs-map-marker route-marker");
    expect(pin.attrs.role).toBe("button");
    expect(pin.attrs["aria-label"]).toBe("#3 · A client");
    expect(pin.tabIndex).toBe(0);
    pin.dispatch("click");
    pin.dispatch("keydown", { key: "Enter" });
    expect(clicked).toHaveBeenCalledTimes(2);
    r.destroy();
  });
});

// 2026-10-09: a map adopted from the pool still believed it was the size of
// the surface that released it, so a fit made on arrival was framed for that
// box — the dashboard card after /routes' tall panel opened with its stops at
// the edges. Reproduced with the real Maps script; Google learns the new size
// on a ResizeObserver tick, after the component has already asked for a fit.
describe("a fit asked for before Google has measured the box is made again once it has", () => {
  class FakeResizeObserver {
    static all: FakeResizeObserver[] = [];
    observed: unknown[] = [];
    disconnected = false;
    constructor(private readonly cb: (entries: unknown[]) => void) {
      FakeResizeObserver.all.push(this);
    }
    observe(el: unknown) {
      this.observed.push(el);
    }
    disconnect() {
      this.disconnected = true;
    }
    size(width: number, height: number) {
      if (!this.disconnected) this.cb([{ contentRect: { width, height } }]);
    }
  }
  beforeEach(() => {
    FakeResizeObserver.all = [];
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  });

  const stops = [
    { lat: 42.46, lng: -83.14 },
    { lat: 42.55, lng: -83.22 },
  ];

  it("refits on the first real size, once, and then leaves the view to the user", () => {
    const g = fakeGoogle();
    const r = createGoogleRenderer(g, new FakeEl() as unknown as HTMLElement, surface());
    const fit = vi.spyOn((r as any).map, "fitBounds");
    const watch = FakeResizeObserver.all.at(-1)!;
    expect(watch.observed).toEqual([(r as any).map.getDiv()]);

    r.fitBounds(stops, { padding: 30, maxZoom: 14 });
    expect(fit).toHaveBeenCalledTimes(1);
    // Detached, or not laid out yet: nothing to fit to.
    watch.size(0, 0);
    expect(fit).toHaveBeenCalledTimes(1);
    watch.size(760, 380);
    expect(fit).toHaveBeenCalledTimes(2);
    // Measured: later fits are made once, and later resizes do not refit.
    expect(watch.disconnected).toBe(true);
    r.fitBounds(stops, { padding: 30, maxZoom: 14 });
    expect(fit).toHaveBeenCalledTimes(3);
    r.destroy();
  });

  it("does not undo a deliberate jump made before the box was measured", () => {
    const g = fakeGoogle();
    const r = createGoogleRenderer(g, new FakeEl() as unknown as HTMLElement, surface());
    const fit = vi.spyOn((r as any).map, "fitBounds");
    r.fitBounds(stops, { padding: 30, maxZoom: 14 });
    // "Show my current location".
    r.setView({ lat: 42.5, lng: -83.2 }, 15);
    FakeResizeObserver.all.at(-1)!.size(760, 380);
    expect(fit).toHaveBeenCalledTimes(1);
    r.destroy();
  });

  // #773: a fresh org with one Detroit visit today has ONE point to fit. That
  // path went straight to setView, which is the location button's path: it
  // cleared the pending fit and never recorded one, so on a map adopted from
  // the pool the single pin was framed for the old box and never again.
  it("makes a one-pin fit again once measured, like any other fit", () => {
    const g = fakeGoogle();
    const r = createGoogleRenderer(g, new FakeEl() as unknown as HTMLElement, surface());
    const map = (r as any).map;
    const woodward = { lat: 42.3297, lng: -83.0458 };
    r.fitBounds([woodward], { padding: 30, maxZoom: 14 });
    // Google moves the camera when it re-measures an adopted map.
    map.setCenter({ lat: 42.49, lng: -83.14 });
    map.setZoom(11);
    FakeResizeObserver.all.at(-1)!.size(760, 380);
    expect(map.center).toEqual(woodward);
    expect(r.getZoom()).toBe(14);
    r.destroy();
  });

  it("a deliberate jump still outranks a one-pin fit made before measuring", () => {
    const g = fakeGoogle();
    const r = createGoogleRenderer(g, new FakeEl() as unknown as HTMLElement, surface());
    const map = (r as any).map;
    r.fitBounds([{ lat: 42.3297, lng: -83.0458 }], { padding: 30, maxZoom: 14 });
    const me = { lat: 42.49, lng: -83.14 };
    r.setView(me, 15);
    FakeResizeObserver.all.at(-1)!.size(760, 380);
    expect(map.center).toEqual(me);
    expect(r.getZoom()).toBe(15);
    r.destroy();
  });

  it("stops watching when the surface goes", () => {
    const g = fakeGoogle();
    const r = createGoogleRenderer(g, new FakeEl() as unknown as HTMLElement, surface());
    r.destroy();
    expect(FakeResizeObserver.all.at(-1)!.disconnected).toBe(true);
  });
});

describe("the options that keep a map load the only thing billed", () => {
  it("switches off Street View, place cards and the 45° tilt", () => {
    const o = mapOptions(surface({ style: "satellite" }));
    // The pegman opens Street View, a separate and pricier SKU.
    expect(o.streetViewControl).toBe(false);
    // A tap on a business icon opens Google's place card and swallows the
    // click a drawing surface was waiting for.
    expect(o.clickableIcons).toBe(false);
    // Oblique imagery puts a yard boundary on the roofs.
    expect(o.tilt).toBe(0);
    expect(o.mapTypeId).toBe("hybrid");
    // The 44px floor for Google's own +/- buttons.
    expect(o.controlSize).toBe(44);
  });

  it("keeps the corner to what the terms require (owner, 2026-10-03)", () => {
    // "Not a huge fan of the attribution list or the text in the bottom
    // right." The "Keyboard shortcuts" link and the scale bar are optional
    // and went; the zoom buttons stay, at 44px.
    const o = mapOptions(surface());
    expect(o.keyboardShortcuts).toBe(false);
    expect(o.scaleControl).toBe(false);
    expect(o.zoomControl).toBe(true);
    // The Google logo and "Map data / Terms" are REQUIRED by the Maps Platform
    // terms. Nothing may hide them: no option that removes the default UI
    // wholesale, and no CSS aimed at Google's attribution classes in the
    // renderer or the global stylesheet.
    const src = codeOnly(read("src/lib/maps/google-renderer.ts"));
    expect(src).not.toMatch(/gm-style-cc|gmnoprint|disableDefaultUI/);
    expect(read("src/styles.css")).not.toMatch(/gm-style-cc|gmnoprint/);
    // The Leaflet fallback drops only its own "Leaflet" prefix; the tile
    // credit ("© OpenStreetMap contributors", required by the ODbL) stays.
    const leaflet = codeOnly(read("src/lib/maps/leaflet-renderer.ts"));
    expect(leaflet).toMatch(/setPrefix\(false\)/);
    expect(leaflet).not.toMatch(/attributionControl:\s*false/);
  });

  it("never caps panning or zooming", () => {
    // The owner's condition. A restriction or a minZoom here would save money
    // by limiting people, which is the one trade that was ruled out.
    const src = codeOnly(read("src/lib/maps/google-renderer.ts"));
    expect(src).not.toMatch(/restriction\s*:/);
    expect(src).not.toMatch(/minZoom\s*:/);
    expect(src).not.toMatch(/gestureHandling:\s*"none"/);
  });

  it("pins the API version to a number", () => {
    expect(MAPS_JS_VERSION).toMatch(/^3\.\d+$/);
  });
});

describe("the key, and what happens without one", () => {
  it("prefers the key inlined at build time and asks the server for nothing", async () => {
    vi.stubEnv("VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY", "built-in-key");
    expect(await resolveBrowserKey()).toBe("built-in-key");
    expect(getMapsBrowserKey).not.toHaveBeenCalled();
  });

  it("asks the server once when the build has none", async () => {
    getMapsBrowserKey.mockResolvedValue({ key: "runtime-key" });
    expect(await resolveBrowserKey()).toBe("runtime-key");
    expect(await resolveBrowserKey()).toBe("runtime-key");
    expect(getMapsBrowserKey).toHaveBeenCalledTimes(1);
  });

  it("asks again later if the server could not be reached", async () => {
    getMapsBrowserKey.mockRejectedValueOnce(new Error("offline"));
    expect(await resolveBrowserKey()).toBe("");
    getMapsBrowserKey.mockResolvedValue({ key: "runtime-key" });
    expect(await resolveBrowserKey()).toBe("runtime-key");
  });

  it("draws with Leaflet when there is no key, and says so once", async () => {
    getMapsBrowserKey.mockResolvedValue({ key: null });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const a = await createMapRenderer(new FakeEl() as unknown as HTMLElement, surface());
    const b = await createMapRenderer(new FakeEl() as unknown as HTMLElement, surface());
    expect(a).toBe(fakeLeaflet);
    expect(b).toBe(fakeLeaflet);
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toMatch(/not configured/);
    // And no script was ever requested.
    expect(head.children).toHaveLength(0);
  });

  it("loads the script once however many maps ask at the same time", async () => {
    const calls = [loadGoogleMaps("k"), loadGoogleMaps("k"), loadGoogleMaps("k")];
    expect(head.children).toHaveLength(1);
    const script = head.children[0] as unknown as { src: string };
    const url = new URL(script.src);
    expect(url.host).toBe("maps.googleapis.com");
    expect(url.searchParams.get("v")).toBe(MAPS_JS_VERSION);
    expect(url.searchParams.get("loading")).toBe("async");
    // The script arrives and calls back.
    installFakeGoogleMaps(fakeWindow);
    fakeWindow[url.searchParams.get("callback")!]();
    const [g1, g2, g3] = await Promise.all(calls);
    expect(g1).toBe(g2);
    expect(g2).toBe(g3);
    expect(counters().scripts).toBe(1);
  });

  it("falls back to Leaflet when the script will not load, rather than leave a grey box", async () => {
    getMapsBrowserKey.mockResolvedValue({ key: "runtime-key" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pending = createMapRenderer(new FakeEl() as unknown as HTMLElement, surface());
    // Let the key resolve and the script tag go in.
    await vi.waitFor(() => expect(head.children).toHaveLength(1));
    (head.children[0] as any).onerror();
    expect(await pending).toBe(fakeLeaflet);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("swaps to Leaflet when Google refuses the key, and stops pooling refused maps", async () => {
    getMapsBrowserKey.mockResolvedValue({ key: "runtime-key" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const pending = createMapRenderer(new FakeEl() as unknown as HTMLElement, surface());
    await vi.waitFor(() => expect(head.children).toHaveLength(1));
    const url = new URL((head.children[0] as any).src);
    installFakeGoogleMaps(fakeWindow);
    fakeWindow[url.searchParams.get("callback")!]();
    const r = await pending;
    expect(r.provider).toBe("google");

    // A referrer that is not on the key's list: Google calls this global.
    fakeWindow.gm_authFailure();
    r.destroy();
    expect(googleMapPool(fakeWindow.google.maps).idle).toBe(0);
    expect(await createMapRenderer(new FakeEl() as unknown as HTMLElement, surface())).toBe(
      fakeLeaflet,
    );
  });

  // 2026-10-09: the dashboard's map sat on a grey box. Against a refused key
  // (reproduced with a real Maps script), Google tears the map down and
  // `getDiv()` on it returns undefined. The swap asked it for its div, threw
  // inside Google's gm_authFailure call — where a throw is swallowed without
  // a word — and never reached the Leaflet fallback.
  it("takes a map Google has torn down off the page, and never asks the map for its div", () => {
    const g = fakeGoogle();
    const container = new FakeEl();
    const r = createGoogleRenderer(g, container as unknown as HTMLElement, surface());
    r.addMarker({
      position: { lat: 42, lng: -83 },
      html: "<div>1</div>",
      size: [26, 26],
      anchor: [13, 13],
    });
    expect(container.children).toHaveLength(1);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // What Google leaves behind after a refusal.
    (r as any).map.getDiv = () => undefined;
    // The loader's refusal flag, set the way Google sets it: through the
    // global the loader installs when it puts the script on the page.
    const api = fakeWindow.google;
    delete fakeWindow.google;
    loadGoogleMaps("k").catch(() => {});
    fakeWindow.gm_authFailure();
    fakeWindow.google = api;
    expect(() => r.destroy()).not.toThrow();
    expect(container.children).toHaveLength(0);
    expect(googleMapPool(g).idle).toBe(0);
  });

  it("lets every surface swap even when one of them cannot", async () => {
    const { onGoogleRefused } = await import("@/lib/maps/google-loader");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const second = vi.fn();
    onGoogleRefused(() => {
      throw new Error("first surface");
    });
    onGoogleRefused(second);
    loadGoogleMaps("k").catch(() => {});
    fakeWindow.gm_authFailure();
    expect(second).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("draws with Leaflet when Google refuses the key before the map is built", async () => {
    getMapsBrowserKey.mockResolvedValue({ key: "runtime-key" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const container = new FakeEl();
    const pending = createMapRenderer(container as unknown as HTMLElement, surface());
    await vi.waitFor(() => expect(head.children).toHaveLength(1));
    const url = new URL((head.children[0] as any).src);
    installFakeGoogleMaps(fakeWindow);
    fakeWindow.gm_authFailure();
    fakeWindow[url.searchParams.get("callback")!]();
    expect(await pending).toBe(fakeLeaflet);
    // And no Google map was built into the container on the way.
    expect(container.children).toHaveLength(0);
  });

  it("never hands the browser a server key", () => {
    // GOOGLE_PLACES_API_KEY and GOOGLE_MAPS_API_KEY are server credentials
    // with no referrer restriction. The browser key endpoint is public.
    const src = codeOnly(read("src/lib/maps-key.functions.ts"));
    expect(src).toMatch(/GOOGLE_MAPS_BROWSER_KEY/);
    expect(src).not.toMatch(/GOOGLE_PLACES_API_KEY|GOOGLE_MAPS_API_KEY\b/);
  });
});

describe("one way onto a map", () => {
  const components = readdirSync(join(root, "src/components"))
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => `src/components/${f}`);

  it("lets nothing but the fallback renderer import Leaflet", () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p, out);
        else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
      }
      return out;
    };
    const offenders = walk("src").filter((f) =>
      /^import\s+(?!type\b)[^;]*from\s+["']leaflet["']|^import\s+["']leaflet\//m.test(
        codeOnly(read(f)),
      ),
    );
    // map-tiles.ts takes Leaflet as a parameter and imports only its TYPES.
    expect(offenders).toEqual(["src/lib/maps/leaflet-renderer.ts"]);
  });

  it("draws every map through the renderer hook", () => {
    const maps = [
      "src/components/BoundaryPreview.tsx",
      "src/components/BoundarySketch.tsx",
      "src/components/NeighborMap.tsx",
      "src/components/RouteMap.tsx",
      "src/components/StationMapPicker.tsx",
      "src/components/ZoneCoverageMap.tsx",
      "src/components/ZonesOverviewMap.tsx",
    ];
    for (const f of maps) expect(read(f), f).toMatch(/useMapRenderer\(/);
    // And nothing else in src/components reaches for a map library.
    for (const f of components) {
      expect(codeOnly(read(f)), f).not.toMatch(/google\.maps\.|\bL\.map\(/);
    }
  });

  it("keeps the route map on the read-only half of the interface (the native seam)", () => {
    // The owner may later draw the technician's route natively with
    // @capacitor/google-maps (free and unlimited). A native renderer can
    // satisfy ReadOnlyMapRenderer; it cannot satisfy the editing half. If
    // RouteMap starts needing editing calls, this is where that shows up.
    const src = codeOnly(read("src/components/RouteMap.tsx"));
    expect(src).toMatch(/const renderer: ReadOnlyMapRenderer \| null = useMapRenderer\(/);
    expect(src).not.toMatch(/[:<]\s*MapRenderer\b/);
  });
});
