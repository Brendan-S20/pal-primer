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

  it("returns 0 rather than throwing on every failure path", () => {
    const paths = server.match(/return 0;/g) ?? [];
    expect(paths.length, "a failure path throws instead of degrading").toBeGreaterThanOrEqual(4);
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
    const rpc = visits.indexOf('rpc("plan_day_across_staff"');
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

  it("warns against starting with the whole country", () => {
    // Measured ratios: the graph is ~8x the PBF on disk and preprocessing
    // peaks near 30x it in RAM. The US is 11-13 GB of PBF, and a box that
    // cannot do it gets OOM-killed hours in rather than failing politely.
    expect(readme).toMatch(/Do NOT start with the whole United States/);
    expect(readme).toMatch(/Start with the states you actually serve/);
  });
});
