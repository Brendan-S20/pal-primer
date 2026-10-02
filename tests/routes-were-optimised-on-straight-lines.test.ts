// The planner minimised the wrong quantity.
//
// ── THE EXPERIMENT ───────────────────────────────────────────────────────
//
// 23 real stops from a demo day, routed twice with the same nearest-neighbour
// and 2-opt, and both results scored by REAL road time from OSRM:
//
//   optimised on straight lines   159.2 min driving   60.7 miles
//   optimised on real roads       141.6 min driving   50.7 miles
//
// 17.6 minutes and 10 miles a day, per truck, thrown away by optimising a
// quantity that is not the one being spent. The two produce different ORDERS,
// which is the point: this is not an ETA display bug that a nicer label fixes.
//
// For scale, the same day's individual legs measured against OSRM:
//
//   leg    straight   model est   real road   ratio   OSRM min   model min
//   0->1    7.68 km    11.13 km    14.88 km   1.94x     22.0        66.7
//   3->4    2.93 km     4.25 km     7.10 km   2.42x     10.3        29.2
//
// road_factor is a single number, 1.45, against a real ratio of 1.44x to
// 2.42x. A straight line across the East River is not a road.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const migration = readdirSync(join(root, "supabase/migrations"))
  .filter((f) => f.includes("routes-were-optimised-on-straight-lines"))
  .map((f) => read(`supabase/migrations/${f}`))
  .join("\n");
const server = read("src/lib/road-legs.server.ts");
const visits = read("src/lib/visits.functions.ts");

describe("measured road legs are preferred, and the estimate still catches everything else", () => {
  it("drive_minutes consults the cache", () => {
    expect(migration).toMatch(/FROM public\.road_legs/);
  });

  it("and keeps the estimate underneath", () => {
    // This is the entire safety argument. Without a fallback every unmeasured
    // pair returns NULL, and plan_visits COALESCEs NULL travel to ZERO -- so a
    // routing outage would not degrade the plan, it would make every stop look
    // adjacent and produce confident nonsense.
    expect(migration).toMatch(/haversine_km/);
    expect(migration).toMatch(/drive_minutes lost its estimate fallback/);
  });

  it("the cache is row-level secured, because it is customer coordinates", () => {
    expect(migration).toMatch(/ALTER TABLE public\.road_legs ENABLE ROW LEVEL SECURITY/);
    expect(migration).toMatch(/is_org_member/);
    expect(migration).toMatch(/road_legs has RLS disabled/);
  });

  it("rounds coordinates the same way on write and on read", () => {
    // A lookup that misses by a rounding tick silently falls back to the
    // estimate for ever, and nothing anywhere reports a cache that never hits.
    expect(migration).toMatch(/round\(_lat1::numeric, 5\)/);
    expect(server).toMatch(/toFixed\(5\)/);
  });
});

describe("the fetcher is a cache warm, not a dependency", () => {
  it("sends lon,lat, which is the order OSRM wants", () => {
    // Reversed, this routes through the Indian Ocean and returns numbers that
    // look entirely plausible.
    expect(server).toMatch(/\$\{p\.lon\},\$\{p\.lat\}/);
  });

  it("degrades rather than throwing on every failure path", () => {
    // CHANGED 2026-09-08: the failure paths used to `return 0;` and this
    // counted those. They now return `failed("<cause>")`, because one number
    // could not tell "nothing to measure" from "the router is down" and the
    // caller was discarding it either way.
    //
    // The property is unchanged and is what is asserted: no failure path
    // throws, so a routing outage cannot take the planner down with it. Naming
    // the causes made that stronger rather than weaker -- a throw would now
    // also fail the exhaustive Record in AutoRoutingPanel.
    const paths = server.match(/return failed\("/g) ?? [];
    expect(paths.length, "a failure path stopped degrading").toBeGreaterThanOrEqual(4);
    const body = server.slice(server.indexOf("export async function refreshRoadLegs"));
    expect(body, "refreshRoadLegs throws instead of degrading").not.toMatch(/^\s*throw /m);
  });

  it("refuses to half-measure a day that is too big", () => {
    // A partial matrix measures some legs and estimates others, and mixing the
    // two is harder to reason about than estimating all of them.
    expect(server).toMatch(/MAX_POINTS/);
    expect(server).toMatch(/leaving this day on estimates/);
  });

  it("is called before planning, and cannot block it", () => {
    expect(visits).toMatch(/refreshRoadLegs\(orgId, day\)/);
    const at = visits.indexOf("refreshRoadLegs(orgId, day)");
    // CHANGED 2026-10-02: the planner is planAndApplyDay (read, solve,
    // write) rather than one plan_day_across_staff call; still after this.
    const rpc = visits.indexOf("planAndApplyDay(supabase");
    expect(rpc).toBeGreaterThan(0);
    expect(at, "the refresh runs after the planner, so it warms nothing").toBeLessThan(rpc);
    const region = visits.slice(at - 400, at + 200);
    expect(region, "the refresh is not wrapped in try/catch").toMatch(/try \{/);
  });

  it("the routing host is one constant, because the demo server is not forever", () => {
    // router.project-osrm.org is a demo and its operators say so. Swapping to
    // a self-hosted or paid engine must not be a code change.
    expect(server).toMatch(/process\.env\.OSRM_URL/);
    expect(server).toMatch(/not for production use/);
  });
});

// ── SELF-HOSTING ─────────────────────────────────────────────────────────
//
// Chosen over the public demo server, and the reasons are operational rather
// than ideological: no third-party on the dispatch path, a matrix cap we set,
// and customer home addresses not leaving our infrastructure.
describe("the routing engine can be ours", () => {
  const compose = read("infra/osrm/docker-compose.yml");
  const build = read("infra/osrm/build.sh");
  const readme = read("infra/osrm/README.md");
  const server = read("src/lib/road-legs.server.ts");

  it("the app points at it with one variable", () => {
    expect(server).toMatch(/process\.env\.OSRM_URL/);
  });

  it("the matrix cap is configurable, and the two ends agree", () => {
    // --max-table-size on the server and OSRM_MAX_TABLE in the app are the
    // same number seen from two sides. Raising one without the other either
    // wastes the capacity or asks for more than the server allows.
    expect(compose).toMatch(/--max-table-size/);
    expect(server).toMatch(/process\.env\.OSRM_MAX_TABLE/);
  });

  it("the healthcheck asks for a route, not a port", () => {
    // A container with no graph loaded is up, listening, and answers 400.
    expect(compose).toMatch(/route\/v1\/driving/);
    expect(compose).toMatch(/"code":"Ok"/);
  });

  it("uses MLD, so a monthly map refresh is a cron job", () => {
    expect(compose).toMatch(/--algorithm mld/);
    expect(build).toMatch(/osrm-partition/);
    expect(build).toMatch(/osrm-customize/);
  });

  it("documents national coverage without a national graph", () => {
    // CHANGED once tenants turned out to be nationwide. The advice used to be
    // "start with the states you serve", which stops being useful when you
    // cannot know which those are. Four Geofabrik sub-extracts cover the
    // country and sum to 10.98 GB against the national extract's 11.27, so
    // each builds on a 32-64 GB box rather than one needing ~124 GB.
    expect(readme).toMatch(/National coverage without a national graph/);
    expect(readme).toMatch(/us-northeast/);
    expect(readme).toMatch(/Partial coverage is a supported state/);
  });

  it("records the confident-zero failure, because it is the one that bites", () => {
    expect(readme).toMatch(/durations: \[\[0,0\],\[0,0\]\]/);
    expect(readme).toMatch(/Cross Road/);
  });
});

// ── THE CACHE HAS A LIFETIME, AND THE ROWS ARE ADDRESSES ─────────────────
//
// Measured on the demo org over 28 days: 412 visits, 110 distinct addresses,
// 11,990 directed pairs at most. That is a one-time cost -- recurring
// customers mean nearly every leg is a hit afterwards and the engine is barely
// consulted. Which is exactly why a cache with no expiry is a problem rather
// than a saving: it would answer with the road network of whatever day it was
// first measured, for ever, and never say so.
//
// And every row is a pair of coordinates where a customer lives.
describe("cached legs expire, and are pruned when the customer goes", () => {
  const expiry = readdirSync(join(root, "supabase/migrations"))
    .filter((f) => f.includes("a-cached-road-leg-with-no-expiry"))
    .map((f) => read(`supabase/migrations/${f}`))
    .join("\n");

  it("a hit must be recent, not merely present", () => {
    expect(expiry).toMatch(/fetched_at > now\(\) - interval '90 days'/);
    expect(expiry).toMatch(/consults the cache with no freshness bound/);
  });

  it("a stale row falls back rather than being trusted", () => {
    // Not deleted on read: it simply stops being consulted, the estimate
    // answers, and the next refresh overwrites it.
    expect(expiry).toMatch(/haversine_km/);
  });

  it("pruning drops rows whose customer is gone", () => {
    expect(expiry).toMatch(/prune_road_legs/);
    expect(expiry).toMatch(/NOT EXISTS[\s\S]*public\.properties/);
    // A technician's start address is a legitimate endpoint too, and deleting
    // those as orphans would evict half the cache every night.
    expect(expiry).toMatch(/NOT EXISTS[\s\S]*public\.staff/);
  });

  it("neither function is reachable by a tenant", () => {
    expect(expiry).toMatch(/FROM PUBLIC, anon, authenticated/);
    expect(expiry).toMatch(/executable by anon or authenticated/);
  });
});

// ── NATIONAL COVERAGE WITHOUT A NATIONAL GRAPH ───────────────────────────
//
// Tenants can be anywhere in the US, so coverage cannot be a hand-built list
// of states. Geofabrik's four sub-extracts cover the country and sum to about
// what the national one weighs -- 1.67 + 2.32 + 3.83 + 3.16 against 11.27 GB --
// but each builds on a 32-64 GB box rather than one needing ~124 GB.
//
// The hazard that makes this safe or not: OSRM does NOT refuse a coordinate
// outside its extract. Asking the Delaware graph about Los Angeles returns
// code "Ok", both points snapped 3,849 km to a lane called "Cross Road", and
// every duration ZERO. A planner reading that concludes every stop is next
// door to every other, and acts on it. Not an error, not a bad number -- a
// confident zero.
describe("a coordinate outside the graph cannot poison the plan", () => {
  const server = read("src/lib/road-legs.server.ts");

  it("checks how far each point had to be snapped", () => {
    expect(server).toMatch(/SNAP_LIMIT_M/);
    expect(server).toMatch(/json\.sources/);
  });

  it("drops only the legs that touch a bad point", () => {
    // Partial coverage is a supported state: one stop off the edge of the
    // extract should cost that stop's legs, not the whole day's.
    expect(server).toMatch(/if \(bad\.has\(i\) \|\| bad\.has\(j\)\) continue;/);
  });

  it("writes nothing at all when every point is outside", () => {
    // Almost certainly the wrong region. Writing any of it is writing fiction.
    // The cause is now named, which is also what the screen shows: "The
    // routing service has no map for these addresses" is actionable in a way
    // that a silent zero was not.
    expect(server).toMatch(/if \(bad\.size === points\.length\) return failed\("wrong_region"\);/);
  });

  it("says which endpoint it asked, because that is the misconfiguration", () => {
    expect(server).toMatch(/endpoint \$\{base\}/);
  });

  it("picks a regional endpoint, and falls back rather than guessing", () => {
    expect(server).toMatch(/OSRM_ENDPOINTS/);
    expect(server).toMatch(/map\[region\] \?\? map\.default \?\? OSRM_URL/);
  });
});

// ── A STREET CENTROID IS NOT A HOUSE ─────────────────────────────────────
//
// Six ordinary US addresses through Nominatim on 2026-08-26:
//
//   MISS     1247 Maple Ave, Plano TX
//   street   842 Oakwood Dr, Naperville IL
//   HOUSE    3315 Sunset Blvd, Los Angeles CA
//   MISS     17 Birch Ln, Concord NH
//   street   5620 Sherwood Rd, Little Rock AR
//   HOUSE    1100 Congress Ave, Austin TX
//
// A third matched a house. Two returned the STREET centroid, which on a long
// suburban road is hundreds of metres from the property, and the reply is
// shaped identically to a good one -- so it was stored as though somebody
// lived there and the router then optimised confidently around it.
//
// The same failure as an out-of-extract OSRM snap: not an error, not an
// obviously bad number, a plausible one that is wrong.
describe("the geocoder says how precisely it matched", () => {
  const geo = read("src/lib/geocode.server.ts");

  it("asks Nominatim which part it matched", () => {
    expect(geo).toMatch(/addressdetails=1/);
    expect(geo).not.toMatch(/addressdetails=0/);
  });

  it("reports house, street or area rather than just a point", () => {
    expect(geo).toMatch(/GeocodePrecision/);
    expect(geo).toMatch(/detail\.house_number/);
    expect(geo).toMatch(/precision: GeocodePrecision/);
  });

  it("warns on an imprecise match instead of refusing it", () => {
    // A street-level point still routes far better than nothing, and refusing
    // would block a signup over a road OSM has not house-numbered. The fault
    // was that it was invisible, not that it was used.
    expect(geo).toMatch(/console\.warn/);
    expect(geo).toMatch(/-level match only/);
  });
});

// ── The end of the day, added 2026-08-31 ──────────────────────────────────
//
// 20260831150000 made the planner cost the drive from the last stop to where
// the technician's day ends. That only works if the closing leg is MEASURED
// like every other leg. It was not: refreshRoadLegs collected visit properties
// and staff START points, so the one leg the new objective turns on was the one
// leg still priced by `dense_urban`'s 11 km/h.
//
// It is not a rounding error. On this org's own data an 8km hop costs 96
// minutes at that speed, and a solver trading real stop-legs against a closing
// leg inflated fourfold reorders the day to dodge a cost that is not there —
// measured, 90.9 stop-minutes became 103.8. Exactly the fault 20260826180000
// named and 20260831130000 finished fixing, reintroduced through the back door
// by the feature that needed it most.
describe("the leg home is measured like every other leg", () => {
  const src = read("src/lib/road-legs.server.ts");
  // Comments here name the columns in order to explain them; the question is
  // whether the QUERY selects them.
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

  it("asks staff for where the day ends, not only where it starts", () => {
    expect(code).toMatch(
      /\.select\(\s*"start_latitude,\s*start_longitude,\s*end_latitude,\s*end_longitude"\s*\)/,
    );
  });

  it("puts both staff points into the matrix", () => {
    expect(code).toMatch(
      /add\([^)]*\bstart_latitude\b[^)]*\bstart_longitude\b[^)]*\)/,
    );
    // The fields, not the cast syntax used to read them: those reads were
    // `(s as any).x` and are now typed rows, and either spelling puts the
    // same coordinate into the matrix. The test is about the coordinate.
    expect(code).toMatch(/add\([^)]*\bend_latitude\b[^)]*\bend_longitude\b[^)]*\)/);
  });

  it("includes the dump, which is the fallback end for anyone with no end address", () => {
    // staff_end_point falls back to an active, geocoded disposal facility. A
    // fallback the matrix has never heard of is a fallback priced at 11 km/h.
    expect(code).toMatch(/from\(\s*"waste_disposal_facilities"\s*\)/);
    expect(code).toMatch(/for \(const d of \(dumps \?\? \[\]\)[^)]*\) add\(/);
  });
});
