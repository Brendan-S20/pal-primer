import type * as Leaflet from "leaflet";

/**
 * THE FALLBACK BASEMAP. Since 2026-10-02 every map is drawn by the Google
 * Maps JavaScript API (src/lib/maps/), and these tiles are used only when no
 * browser key is configured or Google refuses to load — local dev, the unit
 * tests, the viewport sweeps behind their network fence, a misconfigured
 * build. The owner moved off these hosts because OpenStreetMap's tile usage
 * policy lets them block a commercial app and Esri's free imagery has similar
 * terms; they stay here so that a missing key degrades to a map rather than a
 * grey box. Only src/lib/maps/leaflet-renderer.ts calls into this file.
 *
 * Leaflet arrives as a PARAMETER rather than an import, so that importing the
 * style list (routes.tsx does) does not pull Leaflet into a chunk that, in
 * production, never draws with it.
 *
 * Two variants:
 *  - "street" (default) — OpenStreetMap, used everywhere except yard sketching.
 *  - "satellite" — Esri World Imagery, used by BoundarySketch where seeing
 *    the actual yard matters. A labels overlay is added on top so streets
 *    and place names remain legible.
 */

/** Base styles a user can pick between.
 *
 *  ── CARTO NOW REQUIRES A KEY, AND THE PREMISE OF THIS FILE FAILED ────────
 *
 *  This block used to say "all free and keyless", and chose CARTO's Positron
 *  and Voyager over MapTiler on exactly that reasoning: "a map that silently
 *  stops drawing when a key expires or hits its quota is a worse failure than
 *  a slightly different palette."
 *
 *  The reasoning was right and the bet lost. CARTO now stamps
 *  "API KEY REQUIRED  carto.com/basemaps/apikey" diagonally across every tile
 *  it serves us. Verified 2026-08-31 by fetching a Detroit tile
 *  (13/2206/3030) from both styles and LOOKING at the returned PNG, with a
 *  browser User-Agent, Referer and Origin set — the watermark is identical
 *  with and without them, so it is not a user-agent artifact. It failed worse
 *  than the failure mode the comment was written to avoid: the map kept
 *  drawing, so nothing alerted, and it was the DEFAULT style.
 *
 *  Both are removed rather than key-gated. Adding an `?api_key=` path nobody
 *  has a key for would be config that reads as working and is never exercised,
 *  which is the same shape of mistake. Restoring a choice of styles needs a
 *  keyed provider (MapTiler, or the Google Maps migration under discussion),
 *  and that is a decision rather than a patch.
 *
 *  OpenStreetMap and Esri were re-verified the same way and are both clean.
 *  A 418 "Access blocked" from OSM during that check turned out to be curl's
 *  default user agent tripping OSM's tile usage policy, not the app: with a
 *  browser UA it returns a normal tile. Written down because it looked like a
 *  second outage and was not one. */
export type TileVariant = "street" | "satellite";

/** Styles offered in the picker, in display order. `satellite` is deliberately
 *  absent: it is chosen by the SURFACE (yard sketching needs imagery), not by
 *  preference, and offering it as a route basemap makes stop pins unreadable. */
export const BASE_STYLES: Array<{ value: TileVariant; label: string; hint: string }> = [
  { value: "street", label: "Detailed", hint: "Streets and place names" },
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
export function addBaseTiles(
  L: typeof Leaflet,
  map: Leaflet.Map,
  variant: TileVariant = "street",
): void {
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
  // Anything not currently offered falls back, which is what silently retires a
  // stored "positron" or "voyager". Without this, every user who ever opened
  // the picker keeps their watermarked choice forever: the tiles are the
  // broken thing, not the preference, and nothing would ever clear it.
  return BASE_STYLES.some((b) => b.value === v) ? (v as TileVariant) : DEFAULT_BASE_STYLE;
}

export function storeBaseStyle(v: TileVariant): void {
  try {
    localStorage.setItem("map.baseStyle", v);
  } catch {
    /* private mode */
  }
}
