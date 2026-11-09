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
import {
  pickProvider,
  providerContext,
  serverEnv,
  type ProviderContext,
  type ProviderEnv,
} from "@/lib/providers/config";
import { googleServerKey, recordGoogleMapsUsage } from "@/lib/providers/google-usage.server";

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
function osrmMaxPoints(): number {
  return Number(process.env.OSRM_MAX_TABLE ?? 90);
}

type Point = { lat: number; lon: number };

// ── THE ROUTING PROVIDER ─────────────────────────────────────────────────
//
// Everything below this block speaks OSRM's Table response: `code`, a
// `durations` and a `distances` matrix in input order, and `sources` /
// `destinations` carrying how far each point was snapped. A provider is an
// adapter that builds ONE request for every pair among `points` and turns
// whatever comes back into that shape, so the snap guard, the cache and the
// planner never learn there is more than one router.
//
// ROUTING_PROVIDER picks it (see src/lib/providers/config.ts). The owner's
// decision of 2026-11-09 is Google Maps Platform for now and OSRM when volume
// grows: that is ROUTING_PROVIDER=google, set deliberately once the $25
// budget alert exists -- a key being present selects nothing. Unset is
// "osrm", which is OSRM_URL / OSRM_ENDPOINTS / the public demo exactly as
// before. Switching back is ROUTING_PROVIDER=osrm plus OSRM_URL.
// Another provider is a new entry in ROUTING_PROVIDERS reading
// ROUTING_API_KEY and ROUTING_URL from its context -- and nothing else here.

/** OSRM's Table response, which every adapter's answer is normalised to. */
export type RoutingTable = {
  code: string;
  message?: string;
  /** Seconds, [from][to], null where no road connects the pair. */
  durations: Array<Array<number | null>>;
  /** Metres, [from][to], null where no road connects the pair. */
  distances: Array<Array<number | null>>;
  /** How far each point had to move to reach a road, in metres. */
  sources?: Array<{ distance?: number } | null>;
  destinations?: Array<{ distance?: number } | null>;
};

export type RoutingRequest = {
  url: string;
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  /** What may be written to a log. NEVER contains a key: a key that travels
   *  in the query string makes `url` itself a secret. */
  endpoint: string;
};

export type RoutingAdapter = {
  id: string;
  /** How the logs name it. */
  label: string;
  /** The most points one request may carry. */
  maxPoints(ctx: ProviderContext): number;
  tableRequest(points: Point[], ctx: ProviderContext): RoutingRequest;
  /** The response body as OSRM's Table, or null when it is not one.
   *  `points` are the ones the request was built from, in the same order. */
  parseTable(json: unknown, points: Point[]): RoutingTable | null;
};

const osrm: RoutingAdapter = {
  id: "osrm",
  label: "OSRM",
  maxPoints: () => osrmMaxPoints(),
  tableRequest(points) {
    // OSRM takes lon,lat. Getting this backwards routes through the Indian
    // Ocean and returns plausible-looking numbers, so it is written once, here.
    const coords = points.map((p) => `${p.lon},${p.lat}`).join(";");
    const base = endpointFor(points[0].lat, points[0].lon);
    return {
      url: `${base}/table/v1/driving/${coords}?annotations=duration,distance`,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      endpoint: base,
    };
  },
  parseTable: (json) => (json && typeof json === "object" ? (json as RoutingTable) : null),
};

// ── Google Maps Platform: Routes API, Compute Route Matrix ───────────────
//
// One POST for every pair, the key in a header (never in the URL), and a
// field mask so only the four fields read here are returned -- and billed at
// the Essentials tier. TRAFFIC_UNAWARE because it is both the cheapest tier
// and the only one that allows 625 elements (25 x 25) per request; a planner
// costing tomorrow's route has no use for this minute's traffic anyway.
//
// BILLED PER ELEMENT, origins x destinations: a 24-point day is 576 elements.
// That is the reason for the $25 budget alert in docs/google-maps-spend.md,
// and the reason every request is counted by recordGoogleMapsUsage. Days
// whose legs are all cached and fresh never reach this (everyLegIsFresh).
//
// Google has no "snap distance": it routes any point on land to the nearest
// road without saying how far that was. sources/destinations are reported as
// 0, so the wrong-region guard below is a no-op for Google -- correctly, as
// Google's graph is not a regional extract that can be the wrong one.
const GOOGLE_MATRIX_URL = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
/** 25 x 25 = 625, the per-request element ceiling for TRAFFIC_UNAWARE. */
const GOOGLE_MAX_POINTS = 25;

type GoogleMatrixElement = {
  originIndex?: number;
  destinationIndex?: number;
  duration?: string;
  distanceMeters?: number;
  condition?: string;
  status?: { code?: number; message?: string };
};

const google: RoutingAdapter = {
  id: "google",
  label: "Google Routes",
  maxPoints: () => GOOGLE_MAX_POINTS,
  tableRequest(points, ctx) {
    const key = ctx.key ?? googleServerKey(ctx.env);
    if (!key) throw new Error("ROUTING_PROVIDER=google needs GOOGLE_MAPS_API_KEY (or ROUTING_API_KEY)");
    const waypoints = points.map((p) => ({
      waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lon } } },
    }));
    const url = ctx.url ?? GOOGLE_MATRIX_URL;
    return {
      url,
      method: "POST",
      body: JSON.stringify({
        origins: waypoints,
        destinations: waypoints,
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_UNAWARE",
      }),
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "originIndex,destinationIndex,duration,distanceMeters,condition,status",
      },
      endpoint: url,
    };
  },
  parseTable(json, points) {
    // An error is an object ({error: {code, message, status}}), never an array.
    if (!Array.isArray(json)) {
      const e = (json as { error?: { status?: string; message?: string } } | null)?.error;
      return {
        code: e?.status ?? "NotAMatrix",
        message: e?.message ?? "",
        durations: [],
        distances: [],
      };
    }
    const n = points.length;
    recordGoogleMapsUsage("route-matrix-elements", n * n);
    const empty = () => Array.from({ length: n }, () => Array<number | null>(n).fill(null));
    const durations = empty();
    const distances = empty();
    for (let i = 0; i < n; i++) {
      durations[i][i] = 0;
      distances[i][i] = 0;
    }
    for (const el of json as GoogleMatrixElement[]) {
      const i = el.originIndex ?? 0; // proto3 omits a zero index
      const j = el.destinationIndex ?? 0;
      if (i < 0 || j < 0 || i >= n || j >= n || i === j) continue;
      if (el.status?.code) continue; // a per-element error
      if (el.condition !== "ROUTE_EXISTS") continue; // no road between them
      const seconds = Number.parseFloat(String(el.duration ?? "").replace(/s$/, ""));
      const meters = Number(el.distanceMeters ?? 0); // omitted when 0
      if (!Number.isFinite(seconds) || !Number.isFinite(meters)) continue;
      durations[i][j] = seconds;
      distances[i][j] = meters;
    }
    const snapped = points.map(() => ({ distance: 0 }));
    return { code: "Ok", durations, distances, sources: snapped, destinations: snapped };
  },
};

const ROUTING_PROVIDERS = new Map<string, RoutingAdapter>([
  [osrm.id, osrm],
  [google.id, google],
]);

/** Add (or replace) a routing adapter. For a provider added in its own file,
 *  and for tests; ROUTING_PROVIDER then selects it by id. */
export function registerRoutingProvider(adapter: RoutingAdapter): void {
  ROUTING_PROVIDERS.set(adapter.id.toLowerCase(), adapter);
}

/** Remove an adapter registered with registerRoutingProvider. The built-ins
 *  stay. */
export function unregisterRoutingProvider(id: string): void {
  const k = id.toLowerCase();
  if (k !== osrm.id && k !== google.id) ROUTING_PROVIDERS.delete(k);
}

/** The adapter the environment selects. Throws ProviderConfigError for a
 *  ROUTING_PROVIDER nobody registered -- never the demo server instead. */
export function routingProvider(env: ProviderEnv = serverEnv()): RoutingAdapter {
  return pickProvider("routing", env, ROUTING_PROVIDERS, osrm.id);
}

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
  /** HTTP 429 twice: asked to slow down, waited as told (up to 5 s), and was
   *  refused again. The free public demo does this under load; it is an
   *  outage of minutes, not a configuration fault, and retrying later fixes it. */
  | "router_busy"
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
  /**
   * True when every leg the day needs was already in `road_legs` and younger
   * than 90 days, so the router was not asked at all. `measured` is then 0
   * (nothing was written) and `problem` is null: a cached day is a MEASURED
   * day -- drive_minutes reads the same rows either way -- and must not be
   * reported as degraded.
   */
  cached: boolean;
};

const nothingToMeasure: RoadLegResult = {
  measured: 0,
  problem: null,
  pointsOutsideGraph: 0,
  cached: false,
};
const failed = (problem: RoadLegProblem): RoadLegResult => ({
  measured: 0,
  problem,
  pointsOutsideGraph: 0,
  cached: false,
});
const alreadyCached: RoadLegResult = {
  measured: 0,
  problem: null,
  pointsOutsideGraph: 0,
  cached: true,
};

// ── BEING A POLITE GUEST ON A FREE SERVER ────────────────────────────────
//
// The public demo's usage policy asks for at most one request per second, and
// a multi-day applyOptimize calls refreshRoadLegs once per day in a loop -- a
// week planned at once was seven requests in as long as the planner took
// between them, which on a small org is well under a second. So requests to
// the demo host are spaced DEMO_GAP_MS apart within this process. A
// self-hosted OSRM_URL is ours to hammer and is not paced.
//
// Per process, not global: two server instances each keep their own clock.
// That is a known limit, accepted because the alternative is a shared lock
// on the dispatch path for the sake of a server we intend to replace.
const PUBLIC_DEMO_HOST = "router.project-osrm.org";
const DEMO_GAP_MS = 1100;
/** A Retry-After longer than this is not waited for: the dispatcher is
 *  watching a spinner, and an estimate now beats a measurement in a minute. */
const RETRY_AFTER_CAP_MS = 5000;
/** A 429 with no usable Retry-After waits this long before its one retry. */
const RETRY_AFTER_DEFAULT_MS = 1000;

/** The clock this file waits on. Injectable so tests and the routing-trials
 *  harness do not sleep for real; see setRoadLegTiming. */
export type RoadLegTiming = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** False turns off demo-server pacing (Retry-After is still honoured). */
  paceDemo: boolean;
};
const realTiming: RoadLegTiming = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  paceDemo: true,
};
let timing: RoadLegTiming = realTiming;
let lastDemoRequestAt = Number.NEGATIVE_INFINITY;

/**
 * Replace the clock (or turn pacing off), for tests and the trial harness.
 * Pass null to restore the real clock. Either way the pacing memory is reset,
 * so one test's last request does not delay the next test's first.
 */
export function setRoadLegTiming(t: Partial<RoadLegTiming> | null): void {
  timing = t ? { ...realTiming, ...t } : realTiming;
  lastDemoRequestAt = Number.NEGATIVE_INFINITY;
}

function isPublicDemo(base: string): boolean {
  try {
    return new URL(base).hostname === PUBLIC_DEMO_HOST;
  } catch {
    return false;
  }
}

/** Wait for this request's slot on the demo server. The slot is RESERVED
 *  before sleeping, so two days measured concurrently queue behind each other
 *  rather than both reading the same last-request time and firing together. */
async function paceFor(base: string): Promise<void> {
  if (!timing.paceDemo || !isPublicDemo(base)) return;
  const now = timing.now();
  const slot = Math.max(now, lastDemoRequestAt + DEMO_GAP_MS);
  lastDemoRequestAt = slot;
  if (slot > now) await timing.sleep(slot - now);
}

/** Retry-After is either delta-seconds or an HTTP-date (RFC 9110 §10.2.3). */
function retryAfterMs(header: string | null): number {
  const v = header?.trim();
  if (!v) return RETRY_AFTER_DEFAULT_MS;
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(v)) ms = Number(v) * 1000;
  else {
    const at = Date.parse(v);
    if (Number.isNaN(at)) return RETRY_AFTER_DEFAULT_MS;
    ms = at - timing.now();
  }
  return Math.min(Math.max(ms, 0), RETRY_AFTER_CAP_MS);
}

/**
 * Measure every pair among a day's stops and start points, and cache them --
 * then count what happened in `road_leg_runs`, for the platform console.
 *
 * The count is best-effort and after the fact: a failed insert is logged and
 * never changes the result, because a planner that refuses to run when its
 * own bookkeeping fails is worse than a counter that missed one.
 */
export async function refreshRoadLegs(orgId: string, day: string): Promise<RoadLegResult> {
  const tally = { points: 0 };
  const result = await measureDay(orgId, day, tally);
  await countRun(orgId, day, result, tally.points);
  return result;
}

/** Retention for road_leg_runs, matching how long a road leg itself is trusted. */
const RUN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

async function countRun(
  orgId: string,
  day: string,
  result: RoadLegResult,
  points: number,
): Promise<void> {
  // A day with nothing to measure is not a routing outcome; see the migration.
  let outcome: "measured" | "cached" | "estimated";
  let reason: string | null = null;
  if (result.cached) outcome = "cached";
  else if (result.problem) {
    outcome = "estimated";
    reason = result.problem;
  } else if (result.measured > 0) {
    outcome = "measured";
    if (result.pointsOutsideGraph > 0) reason = "points_outside_graph";
  } else return;

  try {
    // Typed, unlike the reads above: road_leg_runs and its RPCs are in types.ts.
    const admin = supabaseAdmin;
    const { error } = await admin
      .from("road_leg_runs")
      .insert({ organization_id: orgId, day, outcome, reason, points });
    if (error) {
      console.error("[road-legs] could not count this run", error.message);
      return;
    }
    // The writer is the pruner: see 20261002090600.
    const cutoff = new Date(Date.now() - RUN_RETENTION_MS).toISOString();
    const { error: pruneError } = await admin
      .from("road_leg_runs")
      .delete()
      .eq("organization_id", orgId)
      .lt("at", cutoff);
    if (pruneError) console.error("[road-legs] could not prune old runs", pruneError.message);
  } catch (err) {
    console.error("[road-legs] could not count this run", (err as Error).message);
  }
}

/**
 * Is every ordered pair among these points already measured, and fresh?
 *
 * One RPC (count_fresh_road_legs) rather than a PostgREST filter: 90 points is
 * 8,010 pairs, and either the URL or `max_rows` gives out long before that. Any
 * failure answers "no", which costs one request to a router -- the behaviour
 * before this check existed -- and never a day planned on missing legs.
 */
async function everyLegIsFresh(orgId: string, points: Point[]): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin.rpc("count_fresh_road_legs", {
      _org_id: orgId,
      _lats: points.map((p) => p.lat),
      _lons: points.map((p) => p.lon),
    });
    if (error) {
      console.error("[road-legs] cache check failed; asking the router", error.message);
      return false;
    }
    return typeof data === "number" && data >= points.length * (points.length - 1);
  } catch (err) {
    console.error("[road-legs] cache check failed; asking the router", (err as Error).message);
    return false;
  }
}

async function measureDay(
  orgId: string,
  day: string,
  tally: { points: number },
): Promise<RoadLegResult> {
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

  // Where a technician with no start address STARTS. staff_start_point's
  // second tier is the business location, so for every such technician the
  // first leg of the day runs from here -- and nothing measured it, because
  // only staff and dump coordinates were collected. The routing trials found
  // the first leg of a Plano technician with no address always on the
  // straight-line estimate while the rest of the day was measured.
  const { data: business } = await admin
    .from("organizations")
    .select("latitude, longitude")
    .eq("id", orgId)
    .maybeSingle();

  const seen = new Set<string>();
  const points: Point[] = [];
  const add = (lat: unknown, lon: unknown) => {
    if (typeof lat !== "number" || typeof lon !== "number") return;
    // One impossible coordinate must not cost the whole day. OSRM rejects the
    // ENTIRE table request when any point is out of range (a latitude of
    // -96.7 is a longitude typed into the wrong box), so every other stop
    // fell back to estimates with it. 0,0 is not out of range, but it is
    // nobody's house: it is what a missing value becomes on its way through
    // a spreadsheet. Both are left to the planner's estimate, alone.
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return;
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
  add((business as Coord | null)?.latitude, (business as Coord | null)?.longitude);

  tally.points = points.length;
  // One point is a matrix of itself; nothing to measure.
  if (points.length < 2) return nothingToMeasure;

  // Every leg already measured and still trusted: do not ask a free server a
  // question we already hold the answer to. Before the size check on purpose --
  // a day too big to measure in one request is still fully measured if its
  // legs were (by a bigger self-hosted router, or over earlier smaller days).
  //
  // A point the router cannot place (snapped too far, or no road to it) never
  // gets a row, so a day containing one is never "cached" and is re-asked on
  // every plan. That is one request per such day, and the honest answer: its
  // other legs might be stale, and nothing here can tell.
  if (await everyLegIsFresh(orgId, points)) return alreadyCached;

  let provider: RoutingAdapter;
  try {
    provider = routingProvider();
  } catch (err) {
    // A misspelt ROUTING_PROVIDER. Estimates, loudly -- not the demo server.
    console.error("[road-legs]", (err as Error).message, "Leaving this day on estimates.");
    return failed("router_error");
  }
  const ctx = providerContext("routing", serverEnv());
  const MAX_POINTS = provider.maxPoints(ctx);

  if (points.length > MAX_POINTS) {
    // Deliberately not silently truncating: a partial matrix would measure some
    // legs and estimate others, and the mix is harder to reason about than
    // estimating all of them. Say so and leave it alone.
    console.warn(
      `[road-legs] ${points.length} points for ${orgId} on ${day} exceeds ${MAX_POINTS}; leaving this day on estimates`,
    );
    return failed("too_many_points");
  }

  let request: RoutingRequest;
  try {
    request = provider.tableRequest(points, ctx);
  } catch (err) {
    // A provider chosen without what it needs (a key, a URL).
    console.error("[road-legs]", (err as Error).message, "Leaving this day on estimates.");
    return failed("router_error");
  }
  const base = request.endpoint;
  const who = provider.label;

  const ask = async () => {
    await paceFor(request.url);
    return fetch(request.url, {
      method: request.method ?? "GET",
      body: request.body,
      headers: request.headers,
      signal: AbortSignal.timeout(20_000),
    });
  };

  let json: any;
  try {
    let res = await ask();
    // Too Many Requests: wait as told (capped), ask ONCE more, and then stop.
    // A second refusal means the server is shedding load, and the dispatcher
    // is better served by an estimate now than by a loop.
    if (res.status === 429) {
      const wait = retryAfterMs(res.headers.get("retry-after"));
      await res.body?.cancel().catch(() => {});
      console.warn(`[road-legs] ${who} 429 for ${orgId} ${day}; retrying once in ${wait} ms`);
      await timing.sleep(wait);
      res = await ask();
      if (res.status === 429) {
        console.error(
          `[road-legs] ${who} 429 again for ${orgId} ${day}; leaving this day on estimates`,
        );
        return failed("router_busy");
      }
    }
    if (!res.ok) {
      console.error(`[road-legs] ${who} ${res.status} for ${orgId} ${day}`);
      return failed("router_error");
    }
    json = provider.parseTable(await res.json(), points);
  } catch (err) {
    console.error(`[road-legs] ${who} unreachable`, (err as Error).message);
    return failed("router_unreachable");
  }

  if (json?.code !== "Ok" || !Array.isArray(json.distances) || !Array.isArray(json.durations)) {
    console.error(`[road-legs] ${who} returned`, json?.code, json?.message ?? "");
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
        source: provider.id,
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

  return { measured: rows.length, problem: null, pointsOutsideGraph: bad.size, cached: false };
}
