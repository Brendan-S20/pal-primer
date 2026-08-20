import L from "leaflet";

/**
 * Centralized Leaflet tile-layer definitions so every map on the app renders
 * against consistent tiles. Two variants:
 *  - "street" (default) — OpenStreetMap, used everywhere except yard sketching.
 *  - "satellite" — Esri World Imagery, used by BoundarySketch where seeing
 *    the actual yard matters. A labels overlay is added on top so streets
 *    and place names remain legible.
 */

/** Base styles a user can pick between.
 *
 *  All free and keyless. MapTiler Basic and OSM Bright — the two originally
 *  asked for — are MapTiler-hosted styles requiring an account key, and a map
 *  that silently stops drawing when a key expires or hits its quota is a worse
 *  failure than a slightly different palette. CARTO's Positron IS the style
 *  usually meant by "Positron", and Voyager is its close counterpart to OSM
 *  Bright, so the visual intent survives with nothing to sign up for.
 *
 *  If MAPTILER_KEY is ever set, swapping these three URLs is the whole change. */
export type TileVariant = "street" | "positron" | "voyager" | "satellite";

/** Styles offered in the picker, in display order. `satellite` is deliberately
 *  absent: it is chosen by the SURFACE (yard sketching needs imagery), not by
 *  preference, and offering it as a route basemap makes stop pins unreadable. */
export const BASE_STYLES: Array<{ value: TileVariant; label: string; hint: string }> = [
  { value: "positron", label: "Light", hint: "Muted greys, so pins and routes read loudest" },
  { value: "voyager", label: "Standard", hint: "Gentle colour, street names stay legible" },
  { value: "street", label: "Detailed", hint: "Full OpenStreetMap detail" },
];

export const DEFAULT_BASE_STYLE: TileVariant = "positron";

const CARTO_ATTR =
  '&copy; OpenStreetMap contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';
// `{r}` resolves to "@2x" on retina displays; Leaflet fills it in.
const POSITRON_URL = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
const VOYAGER_URL = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";

const OSM_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTR = "&copy; OpenStreetMap contributors";

const ESRI_IMAGERY_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const ESRI_IMAGERY_ATTR = "Imagery &copy; Esri";

const ESRI_LABELS_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";

// Roads + street names over imagery (UX round 4: "a map that lists street
// numbers and streets"). House-number and parcel/lot-line layers need paid
// data (e.g. Regrid) — planned as a config-keyed overlay later.
const ESRI_TRANSPORT_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}";

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
    L.tileLayer(ESRI_TRANSPORT_URL, {
      maxZoom: 22,
      maxNativeZoom: 19,
      opacity: 0.9,
    }).addTo(map);
    L.tileLayer(ESRI_LABELS_URL, {
      maxZoom: 22,
      maxNativeZoom: 19,
      opacity: 0.85,
    }).addTo(map);
    return;
  }
  if (variant === "positron") {
    L.tileLayer(POSITRON_URL, { attribution: CARTO_ATTR, maxZoom: 20 }).addTo(map);
    return;
  }
  if (variant === "voyager") {
    L.tileLayer(VOYAGER_URL, { attribution: CARTO_ATTR, maxZoom: 20 }).addTo(map);
    return;
  }
  L.tileLayer(OSM_URL, { attribution: OSM_ATTR, maxZoom: 19 }).addTo(map);
}

/** The user's chosen base style, or the default.
 *
 *  Read from localStorage rather than the database on purpose: it is a display
 *  preference, it must apply on the very first paint before any query resolves,
 *  and a map that flickers from one basemap to another while a fetch lands
 *  looks broken. */
export function storedBaseStyle(): TileVariant {
  if (typeof localStorage === "undefined") return DEFAULT_BASE_STYLE;
  const v = localStorage.getItem("map.baseStyle");
  return v === "positron" || v === "voyager" || v === "street" ? v : DEFAULT_BASE_STYLE;
}

export function storeBaseStyle(v: TileVariant): void {
  try {
    localStorage.setItem("map.baseStyle", v);
  } catch {
    /* private mode */
  }
}
