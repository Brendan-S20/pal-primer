// The weather board was in Celsius, and nobody using it reads Celsius.
//
// Open-Meteo's defaults are Celsius, km/h and millimetres. The forecast
// request never asked for anything else, so the routes board showed a Texas
// dispatcher "36°" on a 97°F day, a bare "23" next to a wind icon with no unit
// at all, and a "hard freeze" warning wired to `temp_max <= -5` — twenty-three
// degrees Fahrenheit, written as a number no US forecast prints.
//
// ── THE PART THAT IS NOT A RELABEL ────────────────────────────────────────
//
// The audit item this came from asked for kilometres to be relabelled as
// miles. Two of the three places it pointed at could not be fixed that way,
// and one of them would have been made worse:
//
//   `organizations.avg_speed_kmh` is a real number in real arithmetic. The
//   settings input was labelled "(km/h)" and wrote what was typed straight to
//   the column. An American dispatcher enters 25 — meaning miles per hour —
//   and the ETA engine reads 25 km/h, or 15.5 mph, and every arrival time in
//   the app runs about 60% slow with no error anywhere. Relabelling that field
//   "mph" without converting would have locked the mistake in. It needs a
//   conversion at the boundary, which is what `measures.ts` is.
//
//   The forecast is not stored by this product at all, so nothing needed
//   converting: Open-Meteo will return Fahrenheit if asked. What needed
//   handling was the CACHE, which is the subject of the migration.
//
// ── THE TWO REQUESTS THAT HAVE TO AGREE ───────────────────────────────────
//
// The forecast is fetched twice in two files. `weather.functions.ts` tries
// Open-Meteo directly; `supabase/functions/weather-forecast` relays the same
// request from an environment with unrestricted egress. The relay is the path
// that actually runs — the direct fetch was failing in production, which is
// why the relay was written.
//
// So if only one of the two asks for Fahrenheit, the units of the board depend
// on which network path succeeded that afternoon. The previous version of this
// hazard was managed with a comment reading "Keep in sync with the server",
// which is not a mechanism. This file is.
//
// ── THE THRESHOLDS ARE THE SAME TEMPERATURES ──────────────────────────────
//
// -5°C is 23°F, 40 km/h is 25 mph, 5mm is 0.2in. A units change must not
// quietly become a policy change about what weather a crew will go out in,
// so the numbers below are checked as conversions rather than as new rules.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findRouteWarnings } from "@/lib/route-plausibility";

/** `measures.ts` is NEW in this change, so a static import of it would throw
 *  while resolving this file whenever the source is stashed — and vitest
 *  reports an import-time throw as "no tests", not as failures. A file that
 *  says "no tests" during a mutation check looks exactly like a file that
 *  passed. Imported per-test instead, where a missing module is a failure with
 *  a name on it. */
const measures = () => import("@/lib/measures");

const root = join(import.meta.dirname, "..");

/** Lazy. A read resolved in a `describe` body throws at import time when the
 *  file is stashed, and vitest reports "no tests" instead of the failures —
 *  which reads as a pass during a mutation check. */
const read = (p: string) => readFileSync(join(root, p), "utf8");

const codeOnly = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

const serverFetch = () => codeOnly(read("src/lib/weather.functions.ts"));
const edgeRelay = () => codeOnly(read("supabase/functions/weather-forecast/index.ts"));

const UNIT_PARAMS: Array<[string, string]> = [
  ["temperature_unit", "fahrenheit"],
  ["wind_speed_unit", "mph"],
  ["precipitation_unit", "inch"],
];

describe("the forecast is requested in the units the reader uses", () => {
  it("asks Open-Meteo for fahrenheit, mph and inches", () => {
    const src = serverFetch();
    for (const [param, value] of UNIT_PARAMS) {
      expect(src).toContain(`url.searchParams.set("${param}", "${value}")`);
    }
  });

  it("asks for exactly the same thing from the relay that actually runs", () => {
    // Not "the relay also sets some units" — the same units. Two files each
    // internally consistent and different from each other is the failure this
    // is here for.
    const src = edgeRelay();
    for (const [param, value] of UNIT_PARAMS) {
      expect(src).toContain(`url.searchParams.set("${param}", "${value}")`);
    }
  });

  it("requests the same daily variables in both, too", () => {
    // The reason the relay exists is that it mirrors the request. A variable
    // list that drifts produces missing fields rather than wrong units, which
    // surfaced once already as an empty "No forecast available".
    //
    // Anchored on the `set("daily", ...)` call. A looser "comma-separated
    // lowercase string" pattern matched the upsert's `onConflict` target in
    // one file and nothing at all in the other, because the real variable
    // names contain digits (`temperature_2m_max`).
    const daily = (src: string) =>
      src.match(/set\(\s*"daily",\s*"([^"]+)"/)?.[1] ??
      src.match(/set\(\s*\n?\s*"daily",\s*\n?\s*"([^"]+)"/)?.[1];
    expect(daily(serverFetch())).toContain("temperature_2m_max");
    expect(daily(edgeRelay())).toBe(daily(serverFetch()));
  });
});

describe("the risk thresholds are the old ones, converted", () => {
  const src = () => serverFetch();

  it("freezes at 23°F, which is the -5°C it replaced", () => {
    expect(Math.round(-5 * 1.8 + 32)).toBe(23);
    expect(src()).toMatch(/temp_max <= 23/);
    // The old value would now mean 5 degrees below zero Fahrenheit, a
    // threshold that would essentially never fire.
    expect(src()).not.toMatch(/temp_max <= -5/);
  });

  it("calls 25 mph windy, which is the 40 km/h it replaced", async () => {
    const { kmToMiles } = await measures();
    expect(Math.round(kmToMiles(40))).toBe(25);
    expect(src()).toMatch(/wind_max >= 25/);
    expect(src()).not.toMatch(/wind_max >= 40/);
  });

  it("calls 0.2 inches rain, which is the 5mm it replaced", () => {
    expect(Number((5 / 25.4).toFixed(1))).toBe(0.2);
    expect(src()).toMatch(/precip_in >= 0\.2/);
    expect(src()).not.toMatch(/precip_mm/);
  });

  it("spells the units out in the reasons a dispatcher reads", () => {
    // "wind 31" and "0.4 rain" are how this failed the first time.
    expect(src()).toMatch(/wind \$\{Math\.round\(day\.wind_max\)\} mph/);
    expect(src()).not.toMatch(/km\/h/);
    expect(src()).not.toMatch(/mm rain/);
  });
});

describe("the cache cannot hand a Celsius payload to Fahrenheit code", () => {
  const src = () => serverFetch();

  it("keys the lookup on units", () => {
    // Without this the stale-on-error branch would serve a pre-change row of
    // any age, forever, as Fahrenheit.
    expect(src()).toMatch(/\.eq\("units", FORECAST_UNITS\)/);
  });

  it("writes the units it fetched, and conflicts on them", () => {
    expect(src()).toMatch(/units: FORECAST_UNITS/);
    // Must match the table's constraint exactly or every write errors.
    expect(src()).toMatch(/onConflict: "lat_key,lon_key,from_date,to_date,units"/);
  });

  it("has a migration that adds the column, purges, and re-keys", () => {
    const m = read(
      "supabase/migrations/20260809030000_a-freeze-warning-that-fires-at-twenty-three-below.sql",
    );
    expect(m).toMatch(/ADD COLUMN IF NOT EXISTS units text/);
    expect(m).toMatch(/DELETE FROM public\.weather_forecast_cache/);
    expect(m).toMatch(/UNIQUE \(lat_key, lon_key, from_date, to_date, units\)/);
    // Leaving the old constraint in place would give the upsert two candidate
    // targets and let a metric row overwrite an imperial one.
    expect(m).toMatch(
      /DROP CONSTRAINT IF EXISTS weather_forecast_cache_lat_key_lon_key_from_date_to_date_key/,
    );
  });
});

describe("speed converts, because a relabel would have made it worse", () => {
  it("round-trips every value the settings input allows", async () => {
    const { MIN_SPEED_MPH, MAX_SPEED_MPH, mphFromStoredKmh, mphToStoredKmh } = await measures();
    // This is the property the settings blur handler depends on. If showing a
    // stored speed and writing it back unchanged could shift it, tabbing
    // through the field would edit the org's routing model.
    for (let mph = MIN_SPEED_MPH; mph <= MAX_SPEED_MPH; mph++) {
      expect(mphFromStoredKmh(mphToStoredKmh(mph))).toBe(mph);
    }
  });

  it("keeps both ends of the input inside the server's 5..120 guard", async () => {
    const { MIN_SPEED_MPH, MAX_SPEED_MPH, mphToStoredKmh } = await measures();
    // visits.functions.ts and the RPC both reject outside that range. A
    // browser that accepts 75 mph and a server that rejects 121 km/h is a
    // form that fails on save with no explanation.
    expect(mphToStoredKmh(MIN_SPEED_MPH)).toBeGreaterThanOrEqual(5);
    expect(mphToStoredKmh(MAX_SPEED_MPH)).toBeLessThanOrEqual(120);
    // And they are the widest such bounds — one step out on either side
    // leaves the window, which is why they are these odd-looking numbers.
    expect(mphToStoredKmh(MIN_SPEED_MPH - 1)).toBeLessThan(5);
    expect(mphToStoredKmh(MAX_SPEED_MPH + 1)).toBeGreaterThan(120);
  });

  it("shows a measured speed as the mph a dispatcher would recognise", async () => {
    const { mphFromStoredKmh, mphToStoredKmh } = await measures();
    // The round trip is lossy: 30 km/h shows as 19 mph and 19 mph stores as
    // 31. Since 2026-10 nothing is typed back, so it is only a display.
    expect(mphFromStoredKmh(30)).toBe(19);
    expect(mphToStoredKmh(19)).toBe(31);
  });

  it("asks for no common speed at all (the owner, 2026-10-02)", async () => {
    // "I don't think it looks good to ask for a common speed (it shouldn't
    // be based on that)." The field is gone from the screen, the server no
    // longer accepts it, and drive_minutes no longer reads it, so a speed
    // typed before the change cannot keep steering estimates from a setting
    // nobody can see.
    const settings = codeOnly(read("src/routes/_authenticated/settings.scheduling.tsx"));
    expect(settings).not.toMatch(/Average speed/);
    expect(settings).not.toMatch(/avg_speed_kmh/);
    const fns = codeOnly(read("src/lib/visits.functions.ts"));
    expect(fns).not.toMatch(/avg_speed_kmh/);
    const migration = read("supabase/migrations/20261002090500_drive-times-are-not-a-typed-speed.sql");
    const body = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION public.drive_minutes"));
    expect(body).toMatch(/_speed\s*:=\s*COALESCE\(\s*_o\.measured_speed_kmh,\s*public\.effective_speed_kmh\(/);
    expect(body.slice(0, body.indexOf("$function$;"))).not.toMatch(/_o\.avg_speed_kmh/);
  });

  it("shows what the roads turned out to be worth", async () => {
    // The estimate's first source is now this workspace's own measured legs.
    // An owner reading an arrival time should be able to find out where the
    // number under it came from; "dense urban" was not an answer.
    const settings = codeOnly(read("src/routes/_authenticated/settings.scheduling.tsx"));
    expect(settings).toMatch(/settings\.measured_speed_kmh/);
    expect(settings).toMatch(/settings\.measured_legs/);
    expect(settings).toMatch(/Drive times come from real road data/);
    const fns = codeOnly(read("src/lib/visits.functions.ts"));
    expect(fns).toMatch(/measured_speed_kmh, measured_road_factor, measured_legs, measured_at/);
  });

  it("uses the exact mile, not a rounded one", async () => {
    const { KM_PER_MILE } = await measures();
    expect(KM_PER_MILE).toBe(1.609344);
  });
});

describe("the drive-too-far warning is measured in miles", () => {
  it("converts the stored kilometres in the sentence only", () => {
    const [w] = findRouteWarnings([
      {
        id: "v1",
        clientName: "Far Away Co",
        travel_km: 1854.2,
        travel_min: 3708,
        scheduled_on: "2026-07-08",
      },
    ]);
    expect(w.message).toContain("1152 mi");
    expect(w.message).not.toMatch(/\bkm\b/);
    // The structured field is untouched: it is the stored unit, and consumers
    // that do their own arithmetic must not silently change basis.
    expect(w.travelKm).toBe(1854.2);
  });
});
