import {
  googleRefused,
  loadGoogleMaps,
  logOnce,
  onGoogleRefused,
  resolveBrowserKey,
} from "./google-loader";
import { createGoogleRenderer, googleMapPool } from "./google-renderer";
import type { MapRenderer, MapSurfaceOptions } from "./types";

let poolDrainWired = false;

/**
 * A renderer for `container`: Google when a key is configured and Google
 * loads, Leaflet + OpenStreetMap otherwise. Never rejects — the fallback is
 * the point.
 */
export async function createMapRenderer(
  container: HTMLElement,
  opts: MapSurfaceOptions,
): Promise<MapRenderer> {
  const key = await resolveBrowserKey();
  if (!key) {
    logOnce(
      "not-configured",
      "info",
      "Google Maps is not configured (no VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY in the build " +
        "and none from the server); drawing with Leaflet + OpenStreetMap.",
    );
  } else if (!googleRefused()) {
    try {
      const g = await loadGoogleMaps(key);
      if (!poolDrainWired) {
        poolDrainWired = true;
        onGoogleRefused(() => googleMapPool(g).discardAll());
      }
      return createGoogleRenderer(g, container, opts);
    } catch (e) {
      logOnce(
        "load-failed",
        "warn",
        `Google Maps did not load (${(e as Error)?.message ?? e}); drawing with Leaflet + OpenStreetMap.`,
      );
    }
  }
  const { createLeafletRenderer } = await import("./leaflet-renderer");
  return createLeafletRenderer(container, opts);
}
