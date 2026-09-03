// The configured driving speed had never been used by anybody.
//
// `drive_minutes` resolved it with `avg_speed_kmh IS NOT NULL AND <> 30`,
// because the column is `integer NOT NULL DEFAULT 30` and so cannot say
// "unset". Every organization in the database sat at exactly 30, so the branch
// was never taken; and 30 km/h is an ordinary answer for a van, so the first
// owner to measure their own average and type it would have been silently
// overridden by a lookup table.
//
// Measured on Demo Pet Waste Co's own 812 cached OSRM legs, on the day
// 20260903090000 was written — one uncached 5 km hop, by which tier answers:
//
//   the measured leg itself (OSRM)     16.6 min   <- ground truth
//   this workspace's own median         15.6 min   <- new
//   what the owner typed (30 km/h)      18.6 min   <- now honoured
//   the dense_urban table (11 km/h)     40.4 min   <- what always happened
//
// And over a whole 26-stop day with the leg cache cold:
//
//   before  672.9 drive minutes      (the table)
//   after   322.5 drive minutes      (this workspace's own roads)
//   truth   325.6 drive minutes      (every leg fetched from OSRM)

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..", "supabase/migrations");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const SQL = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");

/** Same tag-aware reader as the optimize suite: a body written `AS $fn$` does
 *  not contain `AS $$`, and a naive search runs on into the next function. */
function lastBody(name: string) {
  const at = SQL.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(at, `${name} is not defined`).toBeGreaterThan(-1);
  const open = /\sAS\s+(\$[A-Za-z_]*\$)/.exec(SQL.slice(at));
  expect(open, `${name} has no dollar-quoted body`).not.toBeNull();
  const bodyAt = at + open!.index + open![0].length;
  const end = SQL.indexOf(open![1], bodyAt);
  return SQL.slice(at, end === -1 ? undefined : end);
}
const code = (name: string) => lastBody(name).replace(/--[^\n]*/g, "");

describe("a sentinel that collided with a real answer", () => {
  it("no estimator reads 30 as silence", () => {
    // Comments stripped: the migration quotes the old expression in order to
    // say it is gone, and a guard answered by its own explanation is not one.
    for (const fn of ["drive_minutes", "road_km"]) {
      expect(code(fn), `${fn} still treats 30 as unset`).not.toMatch(/<>\s*30/);
    }
  });

  it("makes the column able to say nothing, and says it", () => {
    expect(SQL).toMatch(
      /ALTER TABLE public\.organizations ALTER COLUMN avg_speed_kmh DROP NOT NULL/,
    );
    expect(SQL).toMatch(
      /ALTER TABLE public\.organizations ALTER COLUMN avg_speed_kmh DROP DEFAULT/,
    );
    // The existing 30s carried the old meaning and must be migrated to the new
    // spelling of it, or every workspace silently acquires a 30 km/h estimate
    // it never chose.
    expect(SQL).toMatch(
      /UPDATE public\.organizations SET avg_speed_kmh = NULL WHERE avg_speed_kmh = 30/,
    );
  });

  it("prefers the roads, then the owner, then the table", () => {
    // Order matters and is the whole design: a workspace that has planned a day
    // knows more about its own roads than any dropdown, and an owner who typed
    // a number knows more than a default.
    const d = code("drive_minutes");
    const chain =
      /_speed\s*:=\s*COALESCE\(\s*_o\.measured_speed_kmh,\s*_o\.avg_speed_kmh,\s*public\.effective_speed_kmh\(/;
    expect(d).toMatch(chain);
  });

  it("keeps the kilometres and the minutes describing one journey", () => {
    // 20260831130000 established that travel_km and travel_min must come from
    // the same road. A detour factor that differs between the two estimators
    // reintroduces the "0.21 km in 7.1 min" pairing it removed.
    for (const fn of ["drive_minutes", "road_km"]) {
      expect(code(fn), `${fn} does not use the measured detour factor`).toMatch(
        /COALESCE\(\s*_?o?\.?measured_road_factor|measured_road_factor/,
      );
    }
    expect(code("road_km")).toMatch(/measured_road_factor, o\.road_factor, 1\.30/);
    expect(code("drive_minutes")).toMatch(/measured_road_factor, _o\.road_factor, 1\.30/);
  });

  it("still prefers a leg somebody actually drove", () => {
    // The estimate is the fallback and must stay the fallback. If this ever
    // inverts, a warmed cache stops being worth fetching.
    const d = code("drive_minutes");
    const cacheAt = d.indexOf("FROM public.road_legs");
    const estimateAt = d.indexOf("haversine_km");
    expect(cacheAt).toBeGreaterThan(-1);
    expect(estimateAt).toBeGreaterThan(cacheAt);
    expect(d).toMatch(/IF _secs IS NOT NULL THEN\s*RETURN _secs \/ 60\.0/);
  });
});

describe("the profile is measured, not typed", () => {
  it("refuses to average a handful of legs", () => {
    const p = code("refresh_road_profile");
    expect(p).toMatch(/_min_legs CONSTANT int := 50/);
    expect(p).toMatch(/IF _n < _min_legs THEN/);
    // And records the count even when it declines, so "not enough data" and
    // "never measured" do not look the same in the column.
    expect(p).toMatch(/measured_speed_kmh = NULL, measured_road_factor = NULL,\s*measured_legs = _n/);
  });

  it("throws out the legs whose implied speed means nothing", () => {
    // A 12-second hop across a car park is dominated by the router's own
    // start-up cost. It is still used AS a leg; it just does not get a vote on
    // what the roads are worth.
    const p = code("refresh_road_profile");
    expect(p).toMatch(/rl\.seconds > 30/);
    expect(p).toMatch(/rl\.meters > 0/);
  });

  it("takes the median, and clamps it", () => {
    const p = code("refresh_road_profile");
    expect(p).toMatch(/percentile_cont\(0\.5\)/);
    expect(p).not.toMatch(/\bavg\(/);
    expect(p).toMatch(/LEAST\(GREATEST\(_speed, 5\), 120\)/);
    expect(p).toMatch(/LEAST\(GREATEST\(_factor, 1\.0\), 3\.0\)/);
  });

  it("is re-measured whenever new legs are written", () => {
    // Otherwise the profile is whatever the backfill saw on the day this
    // shipped, and a workspace that moves city never finds out.
    const server = readFileSync(
      join(import.meta.dirname, "..", "src/lib/road-legs.server.ts"),
      "utf8",
    ).replace(/\/\/[^\n]*/g, "");
    expect(server).toMatch(/rpc\("refresh_road_profile", \{ _org_id: orgId \}\)/);
    // After the upsert: the legs are this function's product and a profile
    // failure must not be reported as a failure to measure them.
    expect(server.indexOf("refresh_road_profile")).toBeGreaterThan(
      server.indexOf('.from("road_legs")\n      .upsert'),
    );
  });

  it("says out loud when it had nothing to measure", () => {
    // A fresh replay has no organizations. The rule in CLAUDE.md is that a
    // check which could not run must not read like a check that passed.
    const backfill = SQL.slice(SQL.lastIndexOf("DO $backfill$"));
    expect(backfill).toMatch(/RAISE WARNING 'no organizations on this build/);
  });
});
