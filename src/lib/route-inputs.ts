// From what Postgres says about a day to a problem the solver can search.
//
// route_day_inputs (20261002090700) returns everything the planner may know
// about one organization's day; this file turns it into a SolverProblem and
// the solver's answer back into "these stops, in this order, for this
// person" -- which apply_route_plan then checks, times and writes.
//
// Pure: no I/O, so the trials and the unit tests run exactly what the server
// function runs.
//
// ── THE ONE THING THAT MUST NOT DRIFT ────────────────────────────────────
//
// `driveModel` is drive_minutes (20261002090500), in TypeScript: the measured
// road leg when there is one, otherwise the straight line times the detour
// factor at the profile speed, plus the park-and-walk. The solver chooses the
// order on these numbers and Postgres times the day on its own, so if the two
// disagreed the solver would be optimising a day nobody drives. The routing
// trials compare this matrix against drive_minutes itself, pair by pair, on
// every scenario (tests/routing-trials.test.ts).

import { zonedTimeToUtc } from "@/lib/route-window";
import {
  polishRoute,
  solveRoutes,
  type Solution,
  type SolverOptions,
  type SolverProblem,
  type SolverStop,
} from "@/lib/route-solver";

export type LatLon = [number, number];

/** What route_day_inputs returns. */
export type RouteDayInputs = {
  org: {
    timezone: string;
    workday_start: string;
    workday_end: string;
    park_walk_min: number;
    road_factor: number;
    speed_kmh: number;
    measured_legs: number | null;
    max_drive_minutes: number;
    route_windows: "honour" | "ignore";
    latitude: number | null;
    longitude: number | null;
  };
  techs: Array<{
    id: string;
    capacity: number;
    start_lat: number | null;
    start_lon: number | null;
    end_lat: number | null;
    end_lon: number | null;
    current_min: number | null;
    current_stops: number | null;
    current_sequenced: boolean | null;
  }>;
  visits: Array<{
    id: string;
    lat: number | null;
    lon: number | null;
    service_min: number;
    earliest: string | null;
    latest: string | null;
    pref: string;
    assigned_staff_id: string | null;
    fixed: boolean;
  }>;
  dumps: Array<{ lat: number; lon: number }>;
  day_centroid: { lat: number; lon: number } | null;
  points: Array<[number, number]>;
  legs: Array<[number, number, number]>;
};

/** Rounded exactly as road_legs stores a coordinate. */
const r5 = (n: number) => Number(Number(n).toFixed(5));
const keyOf = (lat: number, lon: number) => `${r5(lat)},${r5(lon)}`;

/** public.haversine_km, the same formula. */
export function haversineKm(a: LatLon, b: LatLon): number {
  const R = 6371.0088;
  const rad = Math.PI / 180;
  const dlat = (b[0] - a[0]) * rad;
  const dlon = (b[1] - a[1]) * rad;
  const h =
    Math.sin(dlat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dlon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

const located = (lat: number | null | undefined, lon: number | null | undefined): LatLon | null =>
  lat == null || lon == null || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))
    ? null
    : [Number(lat), Number(lon)];

/** drive_minutes, for this organization, from the inputs it was read with. */
export function driveModel(inp: Pick<RouteDayInputs, "org" | "points" | "legs">) {
  const index = new Map<string, number>();
  inp.points.forEach(([lat, lon], i) => index.set(keyOf(lat, lon), i));
  const legs = new Map<number, number>();
  const P = inp.points.length;
  for (const [i, j, secs] of inp.legs) legs.set(i * P + j, Number(secs));
  const walk = Number(inp.org.park_walk_min ?? 2);
  const factor = Number(inp.org.road_factor ?? 1.35);
  const speed = Number(inp.org.speed_kmh);
  return (a: LatLon | null, b: LatLon | null): number | null => {
    if (!a || !b) return null;
    const i = index.get(keyOf(a[0], a[1]));
    const j = index.get(keyOf(b[0], b[1]));
    if (i != null && j != null) {
      const secs = legs.get(i * P + j);
      if (secs != null) return secs / 60 + walk;
    }
    if (!(speed > 0)) return null;
    return ((haversineKm(a, b) * factor) / speed) * 60 + walk;
  };
}

/** How a technician's start was resolved, as staff_start_point's tiers. */
export type StartTier = "staff" | "business" | "disposal" | "route" | "none";

export type BuiltDay = {
  problem: SolverProblem;
  /** visit id per stop index (located stops only). */
  stopIds: string[];
  techIds: string[];
  /** Coordinates of every node, stops first. */
  coords: LatLon[];
  startTier: StartTier[];
  /** Stops with no map location: not searched, placed last afterwards. */
  unlocated: Array<{ id: string; service: number; fixedTech: number | null }>;
  /** End points dropped because no stop of the day comes within max_drive. */
  endDropped: boolean[];
  drive: ReturnType<typeof driveModel>;
};

const minutesAfter = (day: string, hhmm: string, tz: string, start: number) =>
  (zonedTimeToUtc(day, hhmm.slice(0, 5), tz).getTime() - start) / 60_000;

/** The matrix over `coords`, by drive_minutes. A pair it cannot price (no
 *  coordinates) costs nothing, as plan_visits' COALESCE(..., 0) made it. */
export function matrixFor(coords: LatLon[], drive: ReturnType<typeof driveModel>): Float64Array {
  const N = coords.length;
  const m = new Float64Array(N * N);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      m[i * N + j] = drive(coords[i], coords[j]) ?? 0;
    }
  }
  return m;
}

export function buildDay(
  inp: RouteDayInputs,
  opts: { day: string; honourWindows: boolean },
): BuiltDay {
  const tz = inp.org.timezone;
  const dayStart = zonedTimeToUtc(opts.day, inp.org.workday_start.slice(0, 5), tz).getTime();
  const drive = driveModel(inp);
  const techIds = inp.techs.map((t) => t.id);
  const techIndex = new Map(techIds.map((id, i) => [id, i]));

  const stopIds: string[] = [];
  const stops: SolverStop[] = [];
  const coords: LatLon[] = [];
  const unlocated: BuiltDay["unlocated"] = [];
  for (const v of inp.visits) {
    const fixedTech =
      v.fixed && v.assigned_staff_id ? (techIndex.get(v.assigned_staff_id) ?? null) : null;
    const at = located(v.lat, v.lon);
    const service = Number(v.service_min ?? 8);
    if (!at) {
      unlocated.push({ id: v.id, service, fixedTech });
      continue;
    }
    stopIds.push(v.id);
    coords.push(at);
    stops.push({
      service,
      earliest: v.earliest ? minutesAfter(opts.day, v.earliest, tz, dayStart) : null,
      latest: v.latest ? minutesAfter(opts.day, v.latest, tz, dayStart) : null,
      pref: v.pref === "morning" || v.pref === "afternoon" ? v.pref : null,
      fixedTech,
    });
  }

  const business = located(inp.org.latitude, inp.org.longitude);
  const dumps = inp.dumps.map((d) => [Number(d.lat), Number(d.lon)] as LatLon);
  const nearestDump = (c: LatLon | null): LatLon | null => {
    if (!c || dumps.length === 0) return null;
    let best: LatLon | null = null;
    let bestKm = Infinity;
    for (const d of dumps) {
      const km = haversineKm(c, d);
      if (km < bestKm) {
        bestKm = km;
        best = d;
      }
    }
    return best;
  };
  const dayCentroid = inp.day_centroid
    ? ([Number(inp.day_centroid.lat), Number(inp.day_centroid.lon)] as LatLon)
    : null;

  const startTier: StartTier[] = [];
  const endDropped: boolean[] = [];
  const techs = inp.techs.map((t) => {
    // staff_start_point: the technician's own address, then the business.
    // The two tiers after that depend on which stops the person is given, so
    // they are provisional here and settled in planDay once that is known.
    let start: LatLon | null = located(t.start_lat, t.start_lon);
    let tier: StartTier = "staff";
    if (!start && business) {
      start = business;
      tier = "business";
    } else if (!start) {
      start = nearestDump(dayCentroid);
      tier = start ? "disposal" : "route";
    }
    startTier.push(tier);
    let end = located(t.end_lat, t.end_lon);
    // plan_visits' rule: if the closest stop of the day cannot reach the end
    // point inside max_drive_minutes, the end point is data entry, not a
    // destination, and the day is an open path.
    if (end && coords.length) {
      let nearest = Infinity;
      for (const c of coords) nearest = Math.min(nearest, drive(c, end) ?? Infinity);
      if (nearest > Number(inp.org.max_drive_minutes ?? 240)) end = null;
    }
    endDropped.push(Boolean(located(t.end_lat, t.end_lon)) && !end);
    return { start, end, capacity: Number(t.capacity ?? 480) };
  });

  // Nodes: stops, then each tech's start and end (where they have one).
  const nodeCoords: LatLon[] = [...coords];
  const solverTechs = techs.map((t) => {
    let s: number | null = null;
    let e: number | null = null;
    if (t.start) {
      s = nodeCoords.length;
      nodeCoords.push(t.start);
    }
    if (t.end) {
      e = nodeCoords.length;
      nodeCoords.push(t.end);
    }
    return { start: s, end: e, capacity: t.capacity };
  });

  const problem: SolverProblem = {
    size: nodeCoords.length,
    matrix: matrixFor(nodeCoords, drive),
    stops,
    techs: solverTechs,
    honourWindows: opts.honourWindows,
    noon: minutesAfter(opts.day, "12:00", tz, dayStart),
  };
  return { problem, stopIds, techIds, coords: nodeCoords, startTier, unlocated, endDropped, drive };
}

export type DayPlan = {
  routes: Array<{ staff_id: string; visit_ids: string[] }>;
  solution: Solution;
  startTier: StartTier[];
  /** Solver drive minutes per technician, the leg home included. */
  driveMin: number[];
};

/** Plan one day: build, solve, settle the starts that depend on the answer,
 *  and put the stops with no location last. */
export function planDay(
  inp: RouteDayInputs,
  opts: { day: string; honourWindows: boolean; solver?: SolverOptions },
): DayPlan {
  const built = buildDay(inp, opts);
  const { problem } = built;
  const solution = solveRoutes(problem, opts.solver);
  const routes = solution.routes.map((r) => [...r]);
  const startTier = [...built.startTier];

  // ── Starts that depend on the stops given ──
  //
  // staff_start_point's third and fourth tiers are measured from the centre
  // of the person's own stops: the nearest disposal site to it, else the
  // stop furthest from it. apply_route_plan resolves them the same way from
  // the set it is handed, so the order is re-polished from the start the day
  // will actually be timed from.
  const dumps = inp.dumps.map((d) => [Number(d.lat), Number(d.lon)] as LatLon);
  for (let t = 0; t < routes.length; t++) {
    const tier = startTier[t];
    if (tier !== "disposal" && tier !== "route") continue;
    const mine = routes[t].map((s) => built.coords[s]);
    const centre: LatLon | null = mine.length
      ? [
          mine.reduce((a, c) => a + c[0], 0) / mine.length,
          mine.reduce((a, c) => a + c[1], 0) / mine.length,
        ]
      : inp.day_centroid
        ? [Number(inp.day_centroid.lat), Number(inp.day_centroid.lon)]
        : null;
    let start: LatLon | null = null;
    if (centre && dumps.length) {
      start = dumps.reduce((b, d) => (haversineKm(centre, d) < haversineKm(centre, b) ? d : b));
      startTier[t] = "disposal";
    } else if (centre && mine.length) {
      start = mine.reduce((b, c) => (haversineKm(centre, c) > haversineKm(centre, b) ? c : b));
      startTier[t] = "route";
    } else {
      startTier[t] = "none";
    }
    if (!start || routes[t].length === 0) continue;
    const coords = [...built.coords, start];
    const at = coords.length - 1;
    const p2: SolverProblem = {
      ...problem,
      size: coords.length,
      matrix: matrixForExtended(problem, built.coords, start, built.drive),
      techs: problem.techs.map((x, k) => (k === t ? { ...x, start: at } : x)),
    };
    routes[t] = polishRoute(p2, t, routes[t]);
  }

  // ── Stops with no location ──
  // Last on whichever route they belong to: pinned ones on their own person,
  // the rest one at a time to whoever has the least of their day used.
  const load = solution.costs.map((c) => c.load);
  const tail: string[][] = routes.map(() => []);
  for (const u of built.unlocated) {
    let t = u.fixedTech;
    if (t == null) {
      t = 0;
      for (let k = 1; k < load.length; k++) {
        if (load[k] / problem.techs[k].capacity < load[t] / problem.techs[t].capacity) t = k;
      }
    }
    tail[t].push(u.id);
    load[t] += u.service;
  }

  return {
    routes: routes.map((r, t) => ({
      staff_id: built.techIds[t],
      visit_ids: [...r.map((s) => built.stopIds[s]), ...tail[t]],
    })),
    solution,
    startTier,
    driveMin: solution.costs.map((c) => c.drive),
  };
}

/** The problem's matrix with one more node appended. */
function matrixForExtended(
  p: SolverProblem,
  coords: LatLon[],
  extra: LatLon,
  drive: ReturnType<typeof driveModel>,
): Float64Array {
  const N = p.size;
  const M = N + 1;
  const m = new Float64Array(M * M);
  for (let i = 0; i < N; i++) m.set(p.matrix.subarray(i * N, i * N + N), i * M);
  for (let i = 0; i < N; i++) {
    m[i * M + N] = drive(coords[i], extra) ?? 0;
    m[N * M + i] = drive(extra, coords[i]) ?? 0;
  }
  m[N * M + N] = 0;
  return m;
}
