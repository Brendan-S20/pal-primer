// ETAs assumed a straight line at a flat 30 km/h with no parking time.
//
// ── THE VERIFICATION THAT WAS OUTSTANDING ─────────────────────────────────
//
// When the calibrated model shipped, this could not be checked. The demo
// organisation's properties spanned latitude 40.73 to 42.47 — Manhattan to
// Michigan — and no NYC figure could be trusted against a spread like that.
// That was recorded as unverified rather than claimed.
//
// It has since been measured, and the spread turned out to be a red herring:
// the 287 Michigan properties were imported later and have NO subscriptions,
// so they generate no visits at all. Every one of the 249 visits in that org
// is on the 10 Manhattan properties. The org is what it looked like from the
// outside, and the dense_urban calibration is right for it.
//
// Measured on the live database, 94 consecutive-stop legs from real demo
// routes:
//
//   average straight-line distance   3.65 km   (2.27 miles)
//   old model (30 km/h, flat)         7.3 min
//   calibrated model                 34.8 min
//   ratio                             4.8x
//   legs with no estimate               0
//
// 35 minutes for a 2.3-mile Manhattan hop including parking is the right
// order of magnitude; 7 minutes was not, and that gap is exactly what "a mile
// doesn't really take a mile drive time" describes. The arithmetic is
// reproducible from the constants below: 3.65 km x 1.45 road factor = 5.29 km,
// at 11 km/h = 28.9 min, plus 6 min to park and walk = 34.9.
//
// These assertions pin the pieces of that arithmetic. They are constants
// somebody will be tempted to "tidy" without knowing a real measurement sits
// behind them.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const migration = readFileSync(
  join(
    root,
    "supabase/migrations/20260805080000_a-straight-line-mile-is-not-a-mile-of-driving.sql",
  ),
  "utf8",
);

describe("the model has the three terms a real trip has", () => {
  it("road distance is not straight-line distance", () => {
    expect(migration).toMatch(/road_factor numeric NOT NULL DEFAULT 1\.30/);
  });

  it("speed depends on where you are driving", () => {
    // A flat 30 km/h describes nowhere: it is far too fast for Manhattan and
    // too slow for a rural route.
    expect(migration).toMatch(/dense_urban[^\n]*11\.0/);
    expect(migration).toMatch(/urban[^\n]*18\.0/);
    expect(migration).toMatch(/suburban[^\n]*28\.0/);
    expect(migration).toMatch(/rural[^\n]*45\.0/);
  });

  it("parking and walking are counted", () => {
    // Door-to-door is the number a dispatcher is promising a customer. In a
    // dense city this is a large fraction of a short hop.
    expect(migration).toMatch(/park_walk_min numeric NOT NULL DEFAULT 2/);
  });
});

describe("one seam, and it refuses to guess", () => {
  it("every estimate goes through drive_minutes", () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.drive_minutes/);
  });

  it("unknown coordinates return NULL rather than a default distance", () => {
    // Inventing a distance for a property nobody geocoded produces a
    // confident number with nothing behind it, and a route built on it.
    expect(migration).toMatch(
      /IF _lat1 IS NULL OR _lon1 IS NULL OR _lat2 IS NULL OR _lon2 IS NULL THEN\s*\n\s*RETURN NULL;/,
    );
  });

  it("a tenant who set their own speed keeps it", () => {
    // 30 is the untouched default. Anything else was a deliberate choice and
    // overriding it would silently discard a tenant's own calibration.
    expect(migration).toMatch(/avg_speed_kmh <> 30/);
  });
});
