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
//   * Nothing Google-derived is kept past 30 days after it was fetched: the
//     daily job removes it at 29 days (one run's margin). A pin is
//     refreshed from 22 days on, so a failing geocoder gets a week of
//     daily retries INSIDE the limit; at 29 it is cleared regardless.
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

/** The limit in Brendan's decision and Google Maps Platform's caching terms:
 *  30 consecutive days. Nothing Google-derived may be older than this. */
export const GOOGLE_TERMS_DAYS = 30;

/** The age at which the daily job removes Google-derived data: ONE DAY
 *  inside the terms. Google road legs are deleted at it, and a Google pin is
 *  cleared at it whatever the geocoder is doing.
 *
 *  Why 29 and not 30 (Product review 5830897980): the job runs once a day
 *  and compares strictly. With the limit AT 30, a value written one second
 *  after a run is 29d 23:59:59 at the day-30 run (not yet over the line)
 *  and is first removed at the day-31 run, at almost 31 days. At 29, the
 *  day-30 run always removes it, so the oldest anything can get is just
 *  under 30 days. The margin is one run interval: if the schedule in
 *  20261109200100 becomes less frequent than daily, this has to move too. */
export const GOOGLE_CACHE_DAYS = GOOGLE_TERMS_DAYS - 1;
const DAY_MS = 24 * 60 * 60 * 1000;

/** When a Google pin starts being refreshed: 7 days BEFORE the removal age
 *  (22 days), so a failing geocoder (an outage, a refused key, an invalid
 *  setting) gets a week of daily retries inside the limit rather than after.
 *
 *  Product review 5829303569: the previous version put that week AFTER the
 *  30 days (pins due at 30, kept to 37 while failing), which knowingly held
 *  Google data past the limit during an outage. The window is inside now.
 *  The cost is a refresh every ~23 days instead of every 30. */
export const GOOGLE_REFRESH_DAYS = GOOGLE_CACHE_DAYS - 7;

/** The instant before which a Google-derived value is removed: 29 days. */
export function googleHardCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - GOOGLE_CACHE_DAYS * DAY_MS);
}

/** The instant before which a Google pin is due for refresh: 22 days. */
export function googleCacheCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - GOOGLE_REFRESH_DAYS * DAY_MS);
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

/** Is this stored property point due for refresh (22 days)? Exactly the
 *  filter the daily job's query applies (google-cache-expiry.server.ts). */
export function isGoogleGeocodeDue(
  row: { geocode_source?: string | null; geocoded_at?: string | null },
  now: Date = new Date(),
): boolean {
  if (!isGoogleGeocodeSource(row.geocode_source) || !row.geocoded_at) return false;
  const at = Date.parse(row.geocoded_at);
  return Number.isFinite(at) && at < googleCacheCutoff(now).getTime();
}

/** Is this road_legs row due for purge? Google rows older than 29 days; every
 *  other source keeps its existing rule (prune_road_legs, 90 days). */
export function isGoogleRoadLegDue(
  row: { source?: string | null; fetched_at?: string | null },
  now: Date = new Date(),
): boolean {
  if (row.source !== GOOGLE_ROAD_LEG_SOURCE || !row.fetched_at) return false;
  const at = Date.parse(row.fetched_at);
  return Number.isFinite(at) && at < googleHardCutoff(now).getTime();
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
