// Real driving distances, from the road network, cached.
//
// ── WHY ──────────────────────────────────────────────────────────────────
//
// The planner minimised straight-line distance. Measured against OSRM on four
// consecutive legs of a real day, the road is 1.44x to 2.42x longer than the
// straight line, against a model that assumes a flat 1.45x. A straight line
// across the East River is not a road, and one multiplier cannot know that.
//
// Time was wrong in the other direction and by more: `dense_urban` assumes
// 11 km/h, so a hop OSRM drives in 22 minutes was costed at 66.7.
//
// The ETA being wrong is the visible part. The part that matters is that a
// solver minimising the wrong quantity picks the wrong ORDER, and no amount of
// 2-opt fixes an objective that disagrees with the road by 2.4x on one leg.
//
// ── HOW ──────────────────────────────────────────────────────────────────
//
// One Table request per day gives every pair at once -- for 21 stops and three
// start points that is a single call, not 576 -- and the rows land in
// `road_legs`, which drive_minutes() prefers over its estimate. Anything not
// measured still costs what it costed before, so a failure here degrades to
// yesterday's behaviour rather than to nothing.
//
// ── THE HOSTING DECISION, WHICH IS NOT MINE ──────────────────────────────
//
// router.project-osrm.org is the public demo server. It is free, needs no key,
// and its operators say plainly it is a demo and not for production use. This
// repo already depends on Nominatim on the same terms and says so in
// geocode.server.ts, so this is consistent rather than novel -- but both are
// the same bet, and it comes due at the same time. For a shipped product this
// wants a self-hosted OSRM or a paid provider, and the only thing that has to
// change is OSRM_URL.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const OSRM_URL = process.env.OSRM_URL ?? "https://router.project-osrm.org";

/** Region endpoints, for national coverage without a national graph.
 *
 *  Geofabrik's four US sub-extracts cover the whole country and sum to about
 *  what the national one weighs -- 1.67, 2.32, 3.83 and 3.16 GB against 11.27 --
 *  but each builds on a 32-64 GB box instead of one needing ~124 GB.
 *
 *  OSRM_ENDPOINTS is JSON: {"northeast":"http://ne:5000","south":"http://s:5000"}
 *  Anything unconfigured falls through to OSRM_URL, and anything unmatched
 *  falls through to the straight-line estimate, so partial coverage is a
 *  supported state rather than a broken one. That matters while regions are
 *  added as tenants appear in them. */
function endpointFor(lat: number, lon: number): string {
  let map: Record<string, string> = {};
  try {
    map = JSON.parse(process.env.OSRM_ENDPOINTS ?? "{}");
  } catch {
    console.error("[road-legs] OSRM_ENDPOINTS is not valid JSON; using OSRM_URL");
  }
  if (Object.keys(map).length === 0) return OSRM_URL;

  // Coarse, and deliberately so: it only has to pick a candidate, because
  // every answer is then checked against how far each point had to be snapped.
  // A wrong guess costs a wasted request, not a wrong route.
  const region =
    lon < -104
      ? "west"
      : lon < -87
        ? lat < 36.5
          ? "south"
          : "midwest"
        : lat < 39.5
          ? "south"
          : "northeast";
  return map[region] ?? map.default ?? OSRM_URL;
}
const USER_AGENT = "HoundStack/1.0 (pet-waste operations app; contact: support@houndstack.com)";

/** How many points one Table request may carry.
 *
 *  The public demo server caps this at 100, so 90 is the safe default. A
 *  self-hosted osrm-routed sets its own limit with --max-table-size, and
 *  infra/osrm/docker-compose.yml sets 200 -- so this is an env var rather than
 *  a constant, and raising the server without raising this would leave the
 *  extra capacity unused and silent. */
const MAX_POINTS = Number(process.env.OSRM_MAX_TABLE ?? 90);

type Point = { lat: number; lon: number };

/** Rounded exactly as the table stores them, so a lookup cannot miss by a tick. */
const r5 = (n: number) => Number(n.toFixed(5));

/**
 * Measure every pair among a day's stops and start points, and cache them.
 *
 * Best effort by design: returns the number of legs written, and 0 for every
 * failure path. The caller must not treat 0 as an error, because a planner
 * that refuses to run when a third-party router is down is worse than one that
 * falls back to an estimate.
 */
/**
 * Why a day got no measured road legs and is being planned on estimates.
 *
 * Named rather than boolean because the answers differ. `too_many_points` is a
 * deliberate refusal of ours and is fixed by raising MAX_POINTS or splitting
 * the day; `wrong_region` means OSRM_ENDPOINTS points at the wrong extract and
 * is a configuration fault; the router ones are an outage. Somebody reading
 * "this day was estimated" needs to know which before they can do anything.
 */
export type RoadLegProblem =
  | "too_many_points"
  | "router_unreachable"
  | "router_error"
  | "wrong_region"
  | "nothing_usable"
  | "save_failed";

/**
 * What a day's measurement actually achieved.
 *
 * This replaced a bare `number`, which collapsed six different situations into
 * the same 0 and threw away the difference between "nothing to measure" and
 * "the router is down". The caller discarded it anyway, so a dispatcher was
 * handed a plan built on straight-line estimates with nothing on screen saying
 * so -- and the header of this file is the argument for why that matters: the
 * road runs 1.44x to 2.42x the straight line against a flat 1.45x model, a hop
 * OSRM drives in 22 minutes is costed at 66.7, and a solver minimising the
 * wrong quantity picks the wrong ORDER. Falling back is right. Falling back
 * quietly is not.
 */
export type RoadLegResult = {
  /** Legs written to `road_legs`. */
  measured: number;
  /**
   * Set when the day got NO measured legs at all. Null both when the day was
   * measured and when there was nothing to measure -- a day with one point is
   * not a degraded day, and reporting it as one would put a warning on the
   * screen of every workspace with a single stop.
   */
  problem: RoadLegProblem | null;
  /**
   * Points that snapped too far to trust, whose legs stayed on estimates while
   * the rest of the day was measured. Zero normally. This is the PARTIAL case,
   * which a single problem code cannot express: the day is neither cleanly
   * measured nor cleanly estimated.
   */
  pointsOutsideGraph: number;
};

const nothingToMeasure: RoadLegResult = { measured: 0, problem: null, pointsOutsideGraph: 0 };
const failed = (problem: RoadLegProblem): RoadLegResult => ({
  measured: 0,
  problem,
  pointsOutsideGraph: 0,
});

export async function refreshRoadLegs(orgId: string, day: string): Promise<RoadLegResult> {
  const admin = supabaseAdmin as any;

  const { data: visits } = await admin
    .from("visits")
    .select("property_id, properties!inner(latitude, longitude)")
    .eq("organization_id", orgId)
    .eq("scheduled_on", day)
    .eq("status", "scheduled");

  const { data: staff } = await admin
    .from("staff")
    .select("start_latitude, start_longitude, end_latitude, end_longitude")
    .eq("organization_id", orgId)
    .eq("active", true)
    .eq("routing_available", true);

  // Where the day ENDS, which the planner started costing in 20260831150000.
  // Without these two the closing leg is the only leg on the route that is not
  // measured, and drive_minutes falls back to `dense_urban`'s 11 km/h -- which
  // on this org's own data turns an 8km hop into 96 minutes. A solver that
  // trades real measured stop-legs against a closing leg inflated fourfold does
  // not merely mis-report, it reorders the day to avoid a cost that is not
  // there. That is the same fault 20260826180000 named and 20260831130000
  // finished fixing, and it would have been reintroduced by the end point
  // itself. Measured before this line existed: 90.9 stop-minutes became 103.8.
  const { data: dumps } = await admin
    .from("waste_disposal_facilities")
    .select("latitude, longitude")
    .eq("organization_id", orgId)
    .eq("active", true);

  const seen = new Set<string>();
  const points: Point[] = [];
  const add = (lat: unknown, lon: unknown) => {
    if (typeof lat !== "number" || typeof lon !== "number") return;
    const p = { lat: r5(lat), lon: r5(lon) };
    const k = `${p.lat},${p.lon}`;
    if (seen.has(k)) return;
    seen.add(k);
    points.push(p);
  };

  // Row shapes rather than an `as any` per field. `admin` is untyped, so every
  // read out of it used to cast at the point of use; naming the three shapes
  // once says what came back, and stops each new column adding another cast to
  // a lint baseline that is already red.
  type Coord = { latitude?: number | null; longitude?: number | null };
  type VisitRow = { properties?: Coord | null };
  type StaffRow = {
    start_latitude?: number | null;
    start_longitude?: number | null;
    end_latitude?: number | null;
    end_longitude?: number | null;
  };

  for (const v of (visits ?? []) as VisitRow[])
    add(v.properties?.latitude, v.properties?.longitude);
  for (const s of (staff ?? []) as StaffRow[]) {
    add(s.start_latitude, s.start_longitude);
    add(s.end_latitude, s.end_longitude);
  }
  for (const d of (dumps ?? []) as Coord[]) add(d.latitude, d.longitude);

  // One point is a matrix of itself; nothing to measure.
  if (points.length < 2) return nothingToMeasure;
  if (points.length > MAX_POINTS) {
    // Deliberately not silently truncating: a partial matrix would measure some
    // legs and estimate others, and the mix is harder to reason about than
    // estimating all of them. Say so and leave it alone.
    console.warn(
      `[road-legs] ${points.length} points for ${orgId} on ${day} exceeds ${MAX_POINTS}; leaving this day on estimates`,
    );
    return failed("too_many_points");
  }

  // OSRM takes lon,lat. Getting this backwards routes through the Indian Ocean
  // and returns plausible-looking numbers, so it is written once, here.
  const coords = points.map((p) => `${p.lon},${p.lat}`).join(";");
  const base = endpointFor(points[0].lat, points[0].lon);
  const url = `${base}/table/v1/driving/${coords}?annotations=duration,distance`;

  let json: any;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      console.error(`[road-legs] OSRM ${res.status} for ${orgId} ${day}`);
      return failed("router_error");
    }
    json = await res.json();
  } catch (err) {
    console.error("[road-legs] OSRM unreachable", (err as Error).message);
    return failed("router_unreachable");
  }

  if (json?.code !== "Ok" || !Array.isArray(json.distances) || !Array.isArray(json.durations)) {
    console.error("[road-legs] OSRM returned", json?.code, json?.message ?? "");
    return failed("router_error");
  }

  // ── THE GUARD THAT MAKES A WRONG GRAPH HARMLESS ────────────────────────
  //
  // OSRM does not refuse a coordinate outside its extract. It snaps to the
  // nearest road it HAS and answers Ok. Asking a Delaware graph about Los
  // Angeles returns code "Ok", both points snapped 3,849 km to a lane called
  // "Cross Road", and every duration ZERO -- which the planner would read as
  // "every stop is next door to every other" and act on.
  //
  // That is the worst possible failure: not an error, not a bad number, but a
  // confident zero. So every point is checked against how far it had to be
  // snapped, and any leg touching a bad one is dropped to the estimate.
  const SNAP_LIMIT_M = 2000; // generous: a rural driveway can be a long way off a mapped road
  const snapped = [...(json.sources ?? []), ...(json.destinations ?? [])];
  const worst = snapped.reduce((m: number, p: any) => Math.max(m, p?.distance ?? 0), 0);
  const bad = new Set<number>();
  (json.sources ?? []).forEach((p: any, i: number) => {
    if ((p?.distance ?? 0) > SNAP_LIMIT_M) bad.add(i);
  });
  if (bad.size) {
    console.error(
      `[road-legs] ${bad.size}/${points.length} points for ${orgId} on ${day} are outside this graph ` +
        `(worst snap ${Math.round(worst)} m, endpoint ${base}); those legs stay on estimates`,
    );
  }
  // Nothing in this extract at all: almost certainly the wrong region, and
  // writing any of it would be writing fiction.
  if (bad.size === points.length) return failed("wrong_region");

  const rows: any[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = 0; j < points.length; j++) {
      if (i === j) continue;
      const meters = json.distances[i]?.[j];
      const seconds = json.durations[i]?.[j];
      // OSRM returns null for a pair it cannot connect. Skipping leaves the
      // estimate in charge for that leg, which is the right answer for two
      // points with no road between them.
      if (typeof meters !== "number" || typeof seconds !== "number") continue;
      if (bad.has(i) || bad.has(j)) continue;
      rows.push({
        organization_id: orgId,
        from_lat: points[i].lat,
        from_lon: points[i].lon,
        to_lat: points[j].lat,
        to_lon: points[j].lon,
        meters,
        seconds,
        source: "osrm",
        fetched_at: new Date().toISOString(),
      });
    }
  }
  if (rows.length === 0) return failed("nothing_usable");

  const { error } = await admin
    .from("road_legs")
    .upsert(rows, { onConflict: "organization_id,from_lat,from_lon,to_lat,to_lon" });
  if (error) {
    console.error("[road-legs] upsert failed", error.message);
    return failed("save_failed");
  }

  // Re-measure what this workspace's roads are actually worth, now that there
  // are more of them to measure.
  //
  // The estimator underneath drive_minutes used to reach for a hardcoded table
  // keyed on `area_type` -- 11 km/h for `dense_urban` against the 37.5 km/h
  // this org's own 1262 legs record. Every leg written above is evidence about
  // the real road network, and it costs one statement per day planned to turn
  // it into the constant the fallback uses. See 20260903090000.
  //
  // Deliberately after the upsert and deliberately not awaited into the return
  // value: the legs are the product of this function and they are already
  // safe. A failure here leaves the previous profile in place, which is a
  // slightly staler estimate for legs nobody has driven -- not a reason to
  // report that the measurement failed.
  const { error: profileError } = await admin.rpc("refresh_road_profile", { _org_id: orgId });
  if (profileError) {
    console.error("[road-legs] road profile refresh failed", profileError.message);
  }

  return { measured: rows.length, problem: null, pointsOutsideGraph: bad.size };
}
