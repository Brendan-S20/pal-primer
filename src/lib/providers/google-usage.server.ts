// Counting what this server asks Google Maps Platform for (#529).
//
// ── WHAT THIS IS, AND WHAT IT IS NOT ─────────────────────────────────────
//
// The owner's decision on 2026-11-09 was to stay on Google for geocoding and
// routing, and to know if Google Maps spend passes $25 a month. The thing that
// actually tells him is a BUDGET ALERT on the Google Cloud billing account --
// docs/google-maps-spend.md says how to create it, and until someone has, no
// alert exists, whatever this file logs.
//
// This file is the cheap half that can live in the repo: every billable call
// the server makes is counted here, and a line is logged on the first call of
// each month per API and every LOG_EVERY units after that. Those lines are
// what to search the server logs for when the budget email arrives and the
// question is "which of our features did that".
//
// The counts are PER PROCESS and in memory. Several server instances each keep
// their own, and a restart starts from zero, so they are a trail, not a meter.
// Google's billing report is the meter. Nothing is written to the database:
// a table for this would be a migration and a write on every geocode, for a
// number Google already keeps exactly.
//
// Not counted, because the server never sees them: the Maps JavaScript API
// loads in the browser (src/lib/maps/google-loader.ts). The budget covers
// those; these logs do not.

/** The billable calls this server makes, by the SKU they are billed under. */
export type GoogleMapsApi =
  /** Geocoding API, one unit per request. */
  | "geocoding"
  /** Routes API Compute Route Matrix, one unit per ELEMENT (origins x destinations). */
  | "route-matrix-elements"
  /** Places API (New) Autocomplete, one unit per request. */
  | "places-autocomplete"
  /** Places API (New) Place Details, one unit per request. */
  | "places-details";

/** One log line per API per this many units, after the month's first call. */
export const LOG_EVERY = 500;

const counts = new Map<string, number>();

function monthOf(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/** Count `units` of `api` against the current UTC month, and log when the
 *  month's first unit or another LOG_EVERY units has been reached. Never
 *  throws: counting must not be the reason a geocode fails. */
export function recordGoogleMapsUsage(api: GoogleMapsApi, units = 1, now = new Date()): void {
  try {
    if (!(units > 0)) return;
    const k = `${monthOf(now)}|${api}`;
    const before = counts.get(k) ?? 0;
    const after = before + units;
    counts.set(k, after);
    if (before === 0 || Math.floor(after / LOG_EVERY) > Math.floor(before / LOG_EVERY)) {
      console.info(
        `[google-maps-usage] month=${monthOf(now)} api=${api} units_this_process=${after} ` +
          `(per-process count; Google's billing report is authoritative)`,
      );
    }
  } catch {
    /* never let counting break the call it counts */
  }
}

/** This process's counts for a month, for tests and for a support look. */
export function googleMapsUsage(
  month = monthOf(new Date()),
): Partial<Record<GoogleMapsApi, number>> {
  const out: Partial<Record<GoogleMapsApi, number>> = {};
  for (const [k, v] of counts) {
    const [m, api] = k.split("|");
    if (m === month) out[api as GoogleMapsApi] = v;
  }
  return out;
}

/** Forget every count. Tests only. */
export function resetGoogleMapsUsage(): void {
  counts.clear();
}

/** The server-side Google Maps Platform key for geocoding and routing:
 *  GOOGLE_MAPS_API_KEY, the name scripts/routing-trials already uses. Never
 *  the browser key, and never sent to the browser. */
export function googleServerKey(env: Readonly<Record<string, string | undefined>>): string | null {
  const v = env.GOOGLE_MAPS_API_KEY?.trim();
  return v ? v : null;
}
