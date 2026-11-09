// The daily expiry of Google-derived data (#529 / #745).
//
// Decision (Brendan, 2026-11-09): Google for geocoding and routing, and
// Google-derived data is refreshed or dropped after 30 days, for Google Maps
// Platform's caching terms. The rule -- what counts as Google, what is never
// touched -- is in src/lib/geocode-source.ts. This file applies it, once a
// day, from /api/public/hooks/google-cache-expiry (pg_cron, 20261109200100).
//
//   road_legs     Google rows (source 'google') fetched more than 30 days ago
//                 are DELETED. Their legs fall back to the planner's estimate
//                 until the next plan re-measures them. Every other source
//                 keeps its existing rule (prune_road_legs, 90 days, weekly).
//
//   properties    A pin with geocode_source 'google' or 'google_places' and
//                 geocoded_at more than 23 days ago is RE-GEOCODED with the
//                 configured provider. Found: new point, new source, new
//                 clock. A provider ANSWERED "no match": the point is
//                 CLEARED (latitude, longitude, source and time to NULL), and
//                 "Geocode addresses" on the Routes page will look for it
//                 again like any unpinned property. Nobody answered (an
//                 outage, a refused key, an invalid GEOCODING_PROVIDER, a
//                 thrown error): the pin is left and retried tomorrow while it
//                 is under 30 days old, and cleared at 30 whatever the
//                 geocoder says, so no Google pin is ever kept past 30 days.
//                 Product review 5828450331 caught the first version
//                 clearing on any failure (one typo in a setting would blank
//                 500 pins in a morning); 5829303569 caught the second
//                 holding failing pins to 37 days. The retry week is now
//                 inside the 30: refresh starts at 23 (GOOGLE_REFRESH_DAYS). A pin from any other source -- Geocodio,
//                 Nominatim, a person, the demo seed, or unknown -- is never
//                 selected.
//
// Each update is guarded on the geocoded_at it read, so a pin somebody
// changed while this ran is left as they left it.
//
// Bounded: at most `limit` pins per run and a wall-clock budget, because the
// fallback geocoder (Nominatim) answers once a second. Pins not reached are
// still due tomorrow; the oldest go first.
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  GOOGLE_GEOCODE_SOURCES,
  GOOGLE_ROAD_LEG_SOURCE,
  googleHardCutoff,
  googleCacheCutoff,
  provenancePatch,
} from "@/lib/geocode-source";
import type { AddressParts, SourcedGeocode } from "@/lib/geocode.server";

type Admin = Pick<SupabaseClient, "from">;

export type ExpirySummary = {
  cutoff: string;
  roadLegsDeleted: number;
  pinsDue: number;
  pinsRefreshed: number;
  pinsCleared: number;
  /** Changed by somebody else between the read and the write: left alone. */
  pinsSkipped: number;
  /** The geocoder did not answer; kept, and retried tomorrow (only while
   *  the pin is under 30 days old). */
  pinsRetrying: number;
  /** Due, but the run's time budget ran out first: still due tomorrow. */
  pinsDeferred: number;
  errors: string[];
};

/** Delete Google road legs older than 30 days. Returns how many. */
export async function purgeGoogleRoadLegs(
  admin: Admin,
  now: Date = new Date(),
): Promise<{ deleted: number; error: string | null }> {
  const { count, error } = await admin
    .from("road_legs")
    .delete({ count: "exact" })
    .eq("source", GOOGLE_ROAD_LEG_SOURCE)
    .lt("fetched_at", googleHardCutoff(now).toISOString());
  return { deleted: count ?? 0, error: error?.message ?? null };
}

export type DuePin = {
  id: string;
  street: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  geocode_source: string | null;
  geocoded_at: string | null;
};

/** The Google-derived pins that are due, oldest first. */
export async function selectDueGooglePins(
  admin: Admin,
  now: Date = new Date(),
  limit = 500,
): Promise<{ rows: DuePin[]; error: string | null }> {
  const { data, error } = await admin
    .from("properties")
    .select("id, street, city, region, postal_code, geocode_source, geocoded_at")
    .in("geocode_source", [...GOOGLE_GEOCODE_SOURCES])
    .lt("geocoded_at", googleCacheCutoff(now).toISOString())
    .order("geocoded_at", { ascending: true })
    .limit(limit);
  return { rows: (data ?? []) as DuePin[], error: error?.message ?? null };
}

export type ExpiryDeps = {
  geocode: (parts: AddressParts) => Promise<SourcedGeocode>;
  now?: () => Date;
  /** Wall-clock budget for re-geocoding, in ms. */
  budgetMs?: number;
  limit?: number;
};

/** Refresh or clear every due Google-derived pin (within the budget). */
export async function refreshGooglePins(
  admin: Admin,
  deps: ExpiryDeps,
): Promise<Omit<ExpirySummary, "cutoff" | "roadLegsDeleted">> {
  const clock = deps.now ?? (() => new Date());
  const started = clock().getTime();
  const budget = deps.budgetMs ?? 50_000;
  const out = {
    pinsDue: 0,
    pinsRefreshed: 0,
    pinsCleared: 0,
    pinsSkipped: 0,
    pinsRetrying: 0,
    pinsDeferred: 0,
    errors: [] as string[],
  };
  const hardCutoff = googleHardCutoff(clock()).getTime();

  const { rows, error } = await selectDueGooglePins(admin, clock(), deps.limit ?? 500);
  if (error) {
    out.errors.push(`select: ${error}`);
    return out;
  }
  out.pinsDue = rows.length;

  for (const [i, row] of rows.entries()) {
    if (clock().getTime() - started >= budget) {
      out.pinsDeferred = rows.length - i;
      break;
    }
    let found: SourcedGeocode;
    try {
      found = await deps.geocode({
        street: row.street,
        city: row.city,
        region: row.region,
        postal_code: row.postal_code,
      });
    } catch (e) {
      // A thrown geocoder is "nobody answered", not "no such address".
      found = { point: null, source: null, failed: true };
      out.errors.push(`geocode ${row.id}: ${(e as Error).message}`);
    }
    if (!found.point && found.failed) {
      const at = Date.parse(String(row.geocoded_at));
      if (Number.isFinite(at) && at >= hardCutoff) {
        out.pinsRetrying += 1;
        continue;
      }
      // At 30 days the limit wins over keeping the point.
    }
    const patch = found.point
      ? {
          latitude: found.point.latitude,
          longitude: found.point.longitude,
          ...provenancePatch(found.source, clock()),
        }
      : { latitude: null, longitude: null, geocode_source: null, geocoded_at: null };

    const { data: written, error: uErr } = await admin
      .from("properties")
      .update(patch)
      .eq("id", row.id)
      .eq("geocoded_at", row.geocoded_at as string)
      .select("id");
    if (uErr) {
      out.errors.push(`update ${row.id}: ${uErr.message}`);
      continue;
    }
    if (!written || written.length === 0) {
      out.pinsSkipped += 1;
      continue;
    }
    if (found.point) out.pinsRefreshed += 1;
    else out.pinsCleared += 1;
  }
  return out;
}

/** The whole daily run. Never throws; failures are counted in `errors`. */
export async function expireGoogleDerivedData(
  admin: Admin,
  deps: ExpiryDeps,
): Promise<ExpirySummary> {
  const now = (deps.now ?? (() => new Date()))();
  const legs = await purgeGoogleRoadLegs(admin, now);
  const pins = await refreshGooglePins(admin, deps);
  return {
    cutoff: googleHardCutoff(now).toISOString(),
    roadLegsDeleted: legs.deleted,
    ...pins,
    errors: [...(legs.error ? [`road_legs: ${legs.error}`] : []), ...pins.errors],
  };
}
