// Where a property's pin came from, and when Google-derived data expires.
//
// ── WHY ──────────────────────────────────────────────────────────────────
//
// Decision (Brendan, 2026-11-09, #529/#745): Google Maps Platform for
// geocoding and routing, and Google-derived data is refreshed or dropped
// after 30 days, to stay inside Google Maps Platform's caching terms. That
// needs two facts per stored point that the schema did not have: WHO produced
// it and WHEN. `properties.geocode_source` and `properties.geocoded_at`
// (20261109200000) hold them; `road_legs.source` and `fetched_at` already
// did.
//
// ── THE RULE THIS FILE IS THE ONE COPY OF ────────────────────────────────
//
//   * Only Google-derived values expire: "google" (Geocoding API, via
//     geocode.server.ts) and "google_places" (a Places Details lookup, the
//     address search box). Routes API drive times are road_legs rows with
//     source "google".
//   * Expiry is 30 days after the value was fetched.
//   * Everything else is NEVER touched by expiry: Geocodio, Nominatim, a pin a
//     person placed ("manual"), the demo seed, and -- deliberately -- a point
//     whose source is unknown (NULL: every row written before this column
//     existed). Clearing a point of unknown origin would be dropping a
//     coordinate that may not be Google's, which the decision rules out.
//
// Pure and dependency-free: imported by server code, the daily job, the UI
// and the tests alike.

export const GEOCODE_SOURCES = [
  "google",
  "google_places",
  "geocodio",
  "nominatim",
  "manual",
] as const;
export type GeocodeSource = (typeof GEOCODE_SOURCES)[number];

/** The sources whose coordinates Google's caching terms govern. */
export const GOOGLE_GEOCODE_SOURCES: readonly GeocodeSource[] = ["google", "google_places"];

/** road_legs.source for a Routes API answer (the routing adapter's id). */
export const GOOGLE_ROAD_LEG_SOURCE = "google";

/** How long a Google-derived value may be kept before it is refreshed or dropped. */
export const GOOGLE_CACHE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a due Google pin may wait for a geocoder that is FAILING (an
 *  outage, a refused key, an invalid setting) before it is cleared anyway.
 *  A pin is retried daily in that window rather than blanked on the first bad
 *  morning; past it, the 30-day rule wins over keeping the point. */
export const GOOGLE_RETRY_GRACE_DAYS = 7;

/** The instant before which a due pin is cleared even if the geocoder is
 *  failing: 30 + 7 days. */
export function googleHardCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - (GOOGLE_CACHE_DAYS + GOOGLE_RETRY_GRACE_DAYS) * DAY_MS);
}

/** The instant before which a Google-derived value is due. */
export function googleCacheCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - GOOGLE_CACHE_DAYS * DAY_MS);
}

/** A known source string, or null for anything else (an unregistered
 *  adapter's id, a typo from an old client). Null is "unknown", which expiry
 *  never touches. */
export function asGeocodeSource(v: unknown): GeocodeSource | null {
  return typeof v === "string" && (GEOCODE_SOURCES as readonly string[]).includes(v)
    ? (v as GeocodeSource)
    : null;
}

export function isGoogleGeocodeSource(v: unknown): boolean {
  return (GOOGLE_GEOCODE_SOURCES as readonly unknown[]).includes(v);
}

/** Is this stored property point due for refresh-or-clear? Exactly the filter
 *  the daily job's query applies (google-cache-expiry.server.ts). */
export function isGoogleGeocodeDue(
  row: { geocode_source?: string | null; geocoded_at?: string | null },
  now: Date = new Date(),
): boolean {
  if (!isGoogleGeocodeSource(row.geocode_source) || !row.geocoded_at) return false;
  const at = Date.parse(row.geocoded_at);
  return Number.isFinite(at) && at < googleCacheCutoff(now).getTime();
}

/** Is this road_legs row due for purge? Google rows older than 30 days; every
 *  other source keeps its existing rule (prune_road_legs, 90 days). */
export function isGoogleRoadLegDue(
  row: { source?: string | null; fetched_at?: string | null },
  now: Date = new Date(),
): boolean {
  if (row.source !== GOOGLE_ROAD_LEG_SOURCE || !row.fetched_at) return false;
  const at = Date.parse(row.fetched_at);
  return Number.isFinite(at) && at < googleCacheCutoff(now).getTime();
}

/** The provenance columns to write alongside a new point. `source` null means
 *  unknown -- still stamped with a time, so a later reader can tell "pinned
 *  on this date by something we did not record" from "never pinned". */
export function provenancePatch(
  source: GeocodeSource | null,
  now: Date = new Date(),
): { geocode_source: GeocodeSource | null; geocoded_at: string } {
  return { geocode_source: source, geocoded_at: now.toISOString() };
}

/** Where a point the BROWSER sent came from, when the browser did not say.
 *
 *  An address picked in the search box arrives with addressSource "matched",
 *  and that box is Google Places: Google-derived. Anything else the browser
 *  sends without a label is unknown, and unknown is kept. Old app builds
 *  (a native app updates when the store says so) send no label at all, which
 *  is why the "matched" signal is read rather than trusted to be absent. */
export function inferClientPointSource(
  claimed: unknown,
  addressSource: "matched" | "manual" | null | undefined,
): GeocodeSource | null {
  return asGeocodeSource(claimed) ?? (addressSource === "matched" ? "google_places" : null);
}
