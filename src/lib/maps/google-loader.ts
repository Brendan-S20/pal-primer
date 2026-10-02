/**
 * Loading the Google Maps JavaScript API: once per page lifetime, and never
 * in a way that can leave a map blank.
 *
 * ── WHERE THE KEY COMES FROM ──────────────────────────────────────────────
 *
 * Lovable's Google Maps connector exposes the browser key to the frontend as
 * `VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY` (docs.lovable.dev/
 * integrations/google-maps). @lovable.dev/vite-tanstack-config inlines every
 * `VITE_*` variable it can see at build time — its `envDefine` runs
 * `loadEnv(mode, cwd, "VITE_")` and turns each into an `import.meta.env.X`
 * define — so in a build that received it, the key is a string literal in the
 * bundle and costs no request. The connector originally wrote it into the
 * repo's `.env` (commit 5228322b, by the Lovable bot); `.env` has been
 * untracked since 2bfd19b1, so it now has to reach the build from Lovable's
 * environment, Xcode Cloud's, or a developer's own `.env`.
 *
 * The production secret is ALSO stored as `GOOGLE_MAPS_BROWSER_KEY`, and a
 * name without the `VITE_` prefix is never inlined into a browser bundle. So
 * when the build-time value is empty the browser asks the server once
 * (`getMapsBrowserKey`) before giving up. One small GET per page lifetime, and
 * only when a map is actually about to be drawn. Either path works; whichever
 * the deployment really has, the maps find it.
 *
 * ── VERSION ───────────────────────────────────────────────────────────────
 *
 * Pinned to a numbered release (the quarterly channel's number on 2026-10-02)
 * so a Google release cannot change these maps underneath us between deploys.
 * When Google retires a number, a request for it is "ignored, and you will
 * receive your default channel instead" (their versioning page) — so the pin
 * can go stale but it cannot break the map. Bump it deliberately.
 *
 * ── WHAT "UNAVAILABLE" MEANS ──────────────────────────────────────────────
 *
 * Three ways Google can fail, all of which fall back to Leaflet + OSM rather
 * than leave a grey box:
 *
 *   * no key at all — logged once at info level, because local dev, the unit
 *     tests and the viewport sweeps are all SUPPOSED to be here;
 *   * the script does not load (offline, blocked, timed out) — warned once,
 *     and retried by the next map after a cool-down, because a van that
 *     drives back into signal should get Google back without a reload;
 *   * Google loads and then REFUSES the key (`gm_authFailure`: a referrer
 *     not on the list, the API not enabled, billing off). Google draws its own
 *     "This page can't load Google Maps correctly" over the map; every live
 *     Google surface is swapped to Leaflet in place, and it stays that way
 *     for the page lifetime, because a refused key does not fix itself.
 */
import { getMapsBrowserKey } from "@/lib/maps-key.functions";
import type { GoogleMapsApi } from "./google-types";

export const MAPS_JS_VERSION = "3.65";

/** How long the script may take before the map gives up and draws with
 *  Leaflet. Generous: a phone on one bar of 4G is the normal case here. */
const LOAD_TIMEOUT_MS = 15_000;
/** After a failed load, how long before another map may try again. */
const RETRY_AFTER_MS = 60_000;

/** The build-time key, or "". */
export function buildTimeBrowserKey(): string {
  // Spelled out in full, no `?.`: the build replaces this exact text with the
  // key (a `define`), and `import.meta.env?.X` is not that text.
  const v = import.meta.env.VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY;
  return typeof v === "string" ? v.trim() : "";
}

let keyPromise: Promise<string> | null = null;

/** The key, from the build if it has one, else from the server. "" when
 *  neither knows it. Never rejects. */
export function resolveBrowserKey(): Promise<string> {
  const built = buildTimeBrowserKey();
  if (built) return Promise.resolve(built);
  if (!keyPromise) {
    keyPromise = getMapsBrowserKey()
      .then((r) => (typeof r?.key === "string" ? r.key.trim() : ""))
      .catch(() => {
        // Offline, most likely. Forget the failure so a later map asks again.
        keyPromise = null;
        return "";
      });
  }
  return keyPromise;
}

const logged = new Set<string>();
/** One line per reason per page lifetime. A map that logs on every mount is
 *  noise nobody reads; a map that never says why it is not Google is a
 *  mystery somebody spends an afternoon on. */
export function logOnce(reason: string, level: "info" | "warn", message: string): void {
  if (logged.has(reason)) return;
  logged.add(reason);
  console[level](`[maps] ${message}`);
}

/** What the loader reads and writes on `window`. */
type LoaderWindow = {
  google?: { maps?: { importLibrary?: (name: string) => Promise<unknown> } };
  gm_authFailure?: () => void;
} & Record<string, unknown>;

let loading: Promise<GoogleMapsApi> | null = null;
let failedAt = 0;
let refused = false;
const refusalListeners = new Set<() => void>();

/** Has Google refused the key on this page? */
export function googleRefused(): boolean {
  return refused;
}

/** Called once if Google refuses the key after loading. Returns an
 *  unsubscribe. */
export function onGoogleRefused(cb: () => void): () => void {
  refusalListeners.add(cb);
  return () => refusalListeners.delete(cb);
}

function markRefused() {
  if (refused) return;
  refused = true;
  logOnce(
    "refused",
    "warn",
    "Google refused the Maps JavaScript API key (gm_authFailure): this origin is " +
      `probably not in the key's website restrictions (${typeof location !== "undefined" ? location.origin : "?"}), ` +
      "or the API or billing is not enabled. Drawing with Leaflet + OpenStreetMap instead.",
  );
  for (const cb of [...refusalListeners]) cb();
}

/** Load the API once. Concurrent callers share one script tag and one promise. */
export function loadGoogleMaps(key: string): Promise<GoogleMapsApi> {
  if (refused) return Promise.reject(new Error("Google refused the key"));
  if (loading) return loading;
  if (failedAt && Date.now() - failedAt < RETRY_AFTER_MS) {
    return Promise.reject(new Error("Google Maps failed to load recently"));
  }

  const w = window as unknown as LoaderWindow;
  let script: HTMLScriptElement | null = null;
  const p = new Promise<GoogleMapsApi>((resolve, reject) => {
    const ready = async () => {
      try {
        // "maps" holds Map, OverlayView, the shapes and InfoWindow; "core"
        // holds LatLng, LatLngBounds, Point, Size and `event`. After these
        // resolve, all of them are also on the `google.maps` namespace.
        const maps = w.google!.maps!;
        await Promise.all([maps.importLibrary!("maps"), maps.importLibrary!("core")]);
        resolve(maps as unknown as GoogleMapsApi);
      } catch (e) {
        reject(e);
      }
    };
    // Already on the page (a previous successful load in this lifetime that
    // was followed by a reset, or a host that loaded it for us).
    if (w.google?.maps?.importLibrary) {
      void ready();
      return;
    }
    w.gm_authFailure = markRefused;
    const callback = "__houndstackMapsReady";
    const timer = setTimeout(() => reject(new Error("Google Maps timed out")), LOAD_TIMEOUT_MS);
    w[callback] = () => {
      clearTimeout(timer);
      void ready();
    };
    const params = new URLSearchParams({
      key,
      v: MAPS_JS_VERSION,
      // The dynamic-import bootstrap: the script defines importLibrary and
      // nothing else until a library is asked for.
      loading: "async",
      callback,
    });
    script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    script.async = true;
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Google Maps script failed to load"));
    };
    document.head.append(script);
  });
  loading = p;
  p.catch(() => {
    loading = null;
    failedAt = Date.now();
    script?.remove();
  });
  return p;
}

/** Test seam: forget everything this module remembers. */
export function __resetGoogleLoaderForTests(): void {
  loading = null;
  failedAt = 0;
  refused = false;
  keyPromise = null;
  logged.clear();
  refusalListeners.clear();
}
