import L from "leaflet";

/**
 * Centralized Leaflet tile-layer definitions so every map on the app renders
 * against consistent tiles. Two variants:
 *  - "street" (default) — OpenStreetMap, used everywhere except yard sketching.
 *  - "satellite" — Esri World Imagery, used by BoundarySketch where seeing
 *    the actual yard matters. A labels overlay is added on top so streets
 *    and place names remain legible.
 */

export type TileVariant = "street" | "satellite";

const OSM_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTR = "&copy; OpenStreetMap contributors";

const ESRI_IMAGERY_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const ESRI_IMAGERY_ATTR = "Imagery &copy; Esri";

const ESRI_LABELS_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";

/**
 * Add the standard tile layer(s) for the given variant to a Leaflet map.
 * Callers should not add tile layers by hand — use this so all maps stay
 * visually consistent.
 */
export function addBaseTiles(map: L.Map, variant: TileVariant = "street"): void {
  if (variant === "satellite") {
    L.tileLayer(ESRI_IMAGERY_URL, {
      attribution: ESRI_IMAGERY_ATTR,
      maxZoom: 22,
      maxNativeZoom: 19,
    }).addTo(map);
    L.tileLayer(ESRI_LABELS_URL, {
      maxZoom: 22,
      maxNativeZoom: 19,
      opacity: 0.85,
    }).addTo(map);
    return;
  }
  L.tileLayer(OSM_URL, { attribution: OSM_ATTR, maxZoom: 19 }).addTo(map);
}
