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
 *  Free and keyless, which is still the requirement — but "keyless" now has to
 *  mean "serves usable tiles without a key", not merely "accepts a request
 *  without one". CARTO met the second and stopped meeting the first; see the
 *  note on BASE_STYLES. OSM meets both, and the same fetch that caught CARTO
 *  returns a clean tile from it.
 *
 *  Anything added here needs checking the same way: request a tile over a
 *  populated area, at the zoom the app actually uses, and LOOK at the image.
 *  A 200 and a valid PNG is what the watermark also returns. */
export type TileVariant = "street" | "satellite";

/** Styles offered in the picker, in display order. `satellite` is deliberately
 *  absent: it is chosen by the SURFACE (yard sketching needs imagery), not by
 *  preference, and offering it as a route basemap makes stop pins unreadable.
 *
 *  ── CARTO IS GONE, AND IT WAS THE DEFAULT ────────────────────────────────
 *
 *  Positron and Voyager were removed on 2026-08-30. The comment above them
 *  said they were chosen because they are "free and keyless", over MapTiler,
 *  on the reasoning that "a map that silently stops drawing when a key expires
 *  or hits its quota is a worse failure than a slightly different palette".
 *
 *  The reasoning was right and the fact underneath it stopped being true.
 *  CARTO now stamps unkeyed tiles rather than refusing them, so it did not
 *  stop drawing — it kept drawing, with API KEY REQUIRED across the middle of
 *  every one. Fetched from the live CDN this morning, 200 OK, a perfectly
 *  valid PNG of Detroit with the watermark diagonally through it. Positron was
 *  DEFAULT_BASE_STYLE, so that is what a customer saw on the Schedule page
 *  unless they had gone looking in the style picker.
 *
 *  That is the failure the original note feared, in the one form it did not
 *  anticipate: not a blank map, which anybody would report, but a working map
 *  wearing someone else's advertisement, which reads as our bug. */
export const BASE_STYLES: Array<{ value: TileVariant; label: string; hint: string }> = [
  { value: "street", label: "Detailed", hint: "Full OpenStreetMap detail" },
];

export const DEFAULT_BASE_STYLE: TileVariant = "street";

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
  // Anyone who ever opened the style picker has "positron" or "voyager" sitting
  // in their browser. Deleting the styles alone would leave exactly those
  // people — the ones who cared enough to choose — on a watermarked basemap,
  // because this read would fall through to the default only for values it
  // does not recognise, and it used to recognise both. So the retired names
  // are named here to be discarded, not merely left out.
  if (v === "positron" || v === "voyager") {
    try {
      localStorage.removeItem("map.baseStyle");
    } catch {
      /* private mode */
    }
    return DEFAULT_BASE_STYLE;
  }
  return v === "street" ? v : DEFAULT_BASE_STYLE;
}

export function storeBaseStyle(v: TileVariant): void {
  try {
    localStorage.setItem("map.baseStyle", v);
  } catch {
    /* private mode */
  }
}
