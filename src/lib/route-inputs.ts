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
  routeClock,
  solveRoutes,
  type Solution,
  type SolverOptions,
  type SolverProblem,
  type SolverStop,
  type UnassignedReason,
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
    /** Services this person can do (staff_services, 20261010200000). Null or
     *  empty: no skills set, so any service -- the default every technician
     *  had before skills existed. */
    services?: string[] | null;
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
    group_walker_id?: string | null;
    /** The group walk this visit belongs to (walk_groups, 20261015200000),
     *  with the group's own window as HH:MM. Members of one group are planned
     *  as a single stop: see collapseWalkGroups. */
    walk_group?: { id: string; earliest: string | null; latest: string | null } | null;
    /** What the visit is (visits.service_id) and its name, for the skill
     *  check and the sentence that names a stop nobody can take. */
    service_id?: string | null;
    service?: string | null;
    /** The client's display name, for the same sentence. */
    client?: string | null;
  }>;
  dumps: Array<{ lat: number; lon: number }>;
  day_centroid: { lat: number; lon: number } | null;
  points: Array<[number, number]>;
  legs: Array<[number, number, number]>;
};

export type WalkGroupMember = {
  id: string;
  walkerId: string | null;
  /** The group, its window as HH:MM. Absent: membership is not known, so the
   *  visit is pinned to the walker and otherwise planned as a solo stop. */
  groupId?: string | null;
  earliest?: string | null;
  latest?: string | null;
};

/** Keep group members on their walker even when the dispatcher allows
 *  reassignment, and mark which group each belongs to. */
export function pinWalkGroupVisits(
  inputs: RouteDayInputs,
  members: ReadonlyArray<WalkGroupMember>,
): RouteDayInputs {
  const byId = new Map(members.map((m) => [m.id, m]));
  return {
    ...inputs,
    visits: inputs.visits.map((visit) => {
      const member = byId.get(visit.id);
      if (!member || (!member.walkerId && !member.groupId)) return visit;
      const out = { ...visit };
      if (member.walkerId) {
        out.fixed = true;
        out.assigned_staff_id = member.walkerId;
        out.group_walker_id = member.walkerId;
      }
      if (member.groupId) {
        out.walk_group = {
          id: member.groupId,
          earliest: member.earliest?.slice(0, 5) || null,
          latest: member.latest?.slice(0, 5) || null,
        };
      }
      return out;
    }),
  };
}

/** Minutes at each door of a group walk to collect or hand back a dog.
 *  apply_route_plan uses the same number (_pickup_min, 20261015200000). */
export const GROUP_PICKUP_MIN = 3;

/**
 * A group walk is one walk, so the planner sees it as one stop.
 *
 * Every group with two or more visits in play becomes a single stop at its
 * first member's door, taking: the walk once, GROUP_PICKUP_MIN per member,
 * the drive from door to door collecting the dogs, and the same drive back
 * handing them over. Its window is the group's own when the group has one,
 * otherwise the overlap of the members' windows. It stays on the group
 * walker when there is one.
 *
 * `members` maps the stop that stands for each group (its first member's id)
 * to every member id in pickup order: located members first, each in the
 * order route_day_inputs gave them, then any with no map location. planDay
 * puts them back in that order, consecutively, so each visit is saved with
 * its own sequence and ETA. A group with one visit in play is a solo walk.
 */
export function collapseWalkGroups(inp: RouteDayInputs): {
  inputs: RouteDayInputs;
  members: Map<string, string[]>;
} {
  const groups = new Map<string, RouteDayInputs["visits"]>();
  for (const visit of inp.visits) {
    if (!visit.walk_group) continue;
    const list = groups.get(visit.walk_group.id) ?? [];
    list.push(visit);
    groups.set(visit.walk_group.id, list);
  }
  const members = new Map<string, string[]>();
  if (![...groups.values()].some((list) => list.length > 1)) return { inputs: inp, members };

  const drive = driveModel(inp);
  const stands = new Map<string, RouteDayInputs["visits"][number]>();
  const folded = new Set<string>();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const ordered = [
      ...list.filter((v) => located(v.lat, v.lon)),
      ...list.filter((v) => !located(v.lat, v.lon)),
    ];
    const doors = ordered.map((v) => located(v.lat, v.lon)).filter((c): c is LatLon => c != null);
    let collect = 0;
    let handBack = 0;
    for (let i = 1; i < doors.length; i++) {
      collect += drive(doors[i - 1], doors[i]) ?? 0;
      handBack += drive(doors[i], doors[i - 1]) ?? 0;
    }
    const walk = Math.max(...ordered.map((v) => Number(v.service_min ?? 8)));
    const head = ordered[0];
    const group = head.walk_group!;
    const ownWindow = group.earliest != null || group.latest != null;
    const starts = ordered.map((v) => v.earliest).filter((t): t is string => t != null);
    const ends = ordered.map((v) => v.latest).filter((t): t is string => t != null);
    const pinned = ordered.find((v) => v.fixed && v.assigned_staff_id) ?? head;
    stands.set(head.id, {
      ...head,
      service_min: walk + GROUP_PICKUP_MIN * ordered.length + collect + handBack,
      earliest: ownWindow ? group.earliest : (starts.sort()[starts.length - 1] ?? null),
      latest: ownWindow ? group.latest : (ends.sort()[0] ?? null),
      pref: ordered.every((v) => v.pref === head.pref) ? head.pref : "any",
      fixed: pinned.fixed,
      assigned_staff_id: pinned.assigned_staff_id,
      group_walker_id: pinned.group_walker_id ?? head.group_walker_id ?? null,
    });
    for (const v of ordered.slice(1)) folded.add(v.id);
    members.set(
      head.id,
      ordered.map((v) => v.id),
    );
  }
  return {
    inputs: {
      ...inp,
      visits: inp.visits.filter((v) => !folded.has(v.id)).map((v) => stands.get(v.id) ?? v),
    },
    members,
  };
}

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
  unlocated: Array<{
    id: string;
    service: number;
    fixedTech: number | null;
    eligibleTechs: number[] | null;
    /** Its window, in minutes after the workday start, as the stops have. */
    earliest: number | null;
    latest: number | null;
  }>;
  /** End points dropped because no stop of the day comes within max_drive. */
  endDropped: boolean[];
  drive: ReturnType<typeof driveModel>;
};

const minutesAfter = (day: string, hhmm: string, tz: string, start: number) =>
  (zonedTimeToUtc(day, hhmm.slice(0, 5), tz).getTime() - start) / 60_000;

/**
 * Who may take a visit, by service skill: the technicians whose
 * staff_services rows name the visit's service, and every technician who
 * has no rows at all (no skills set means any service). Null when that is
 * everyone -- which it is for every visit of a business that has never
 * opened the skills screen, so nothing changes for them. A visit that is
 * fixed to its technician (reassign off) is also null: the dispatcher's own
 * assignment stands, skills decide only what the planner may choose.
 */
export function eligibleTechsFor(
  visit: { service_id?: string | null; fixed?: boolean; group_walker_id?: string | null },
  techs: Array<{ id?: string; services?: string[] | null }>,
): number[] | null {
  if (visit.group_walker_id) {
    const index = techs.findIndex((tech) => tech.id === visit.group_walker_id);
    return index < 0 ? [] : [index];
  }
  if (visit.fixed || !visit.service_id) return null;
  const out: number[] = [];
  techs.forEach((t, i) => {
    const skills = t.services ?? [];
    if (skills.length === 0 || skills.includes(visit.service_id!)) out.push(i);
  });
  return out.length === techs.length ? null : out;
}

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
    const eligibleTechs = eligibleTechsFor(v, inp.techs);
    const at = located(v.lat, v.lon);
    const service = Number(v.service_min ?? 8);
    const earliest = v.earliest ? minutesAfter(opts.day, v.earliest, tz, dayStart) : null;
    const latest = v.latest ? minutesAfter(opts.day, v.latest, tz, dayStart) : null;
    if (!at) {
      unlocated.push({ id: v.id, service, fixedTech, eligibleTechs, earliest, latest });
      continue;
    }
    stopIds.push(v.id);
    coords.push(at);
    stops.push({
      service,
      earliest,
      latest,
      pref: v.pref === "morning" || v.pref === "afternoon" ? v.pref : null,
      fixedTech,
      eligibleTechs,
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

export type UnassignedVisit = {
  visit_id: string;
  reason: UnassignedReason;
  client: string | null;
  service: string | null;
  /** The window that could not be kept, as HH:MM on the business's clock. */
  earliest: string | null;
  latest: string | null;
};

export type DayPlan = {
  routes: Array<{ staff_id: string; visit_ids: string[] }>;
  /** Visits on no route: nobody on the run can do the service, or no route
   *  keeps the window. apply_route_plan is told, so the day still checks out;
   *  the panel names each one. */
  unassigned: UnassignedVisit[];
  solution: Solution;
  startTier: StartTier[];
  /** Solver drive minutes per technician, the leg home included. */
  driveMin: number[];
};

/** Plan one day: fold each group walk into one stop, build, solve, settle
 *  the starts that depend on the answer, put the stops with no location
 *  last, and give each group's stop back as its member visits. */
export function planDay(
  given: RouteDayInputs,
  opts: { day: string; honourWindows: boolean; solver?: SolverOptions },
): DayPlan {
  const { inputs: inp, members } = collapseWalkGroups(given);
  const plan = planCollapsedDay(inp, opts);
  if (members.size === 0) return plan;
  const visits = new Map(given.visits.map((v) => [v.id, v]));
  const expand = (id: string) => members.get(id) ?? [id];
  return {
    ...plan,
    routes: plan.routes.map((r) => ({ ...r, visit_ids: r.visit_ids.flatMap(expand) })),
    // Every member is named, each with its own client, under the window the
    // group was planned with.
    unassigned: plan.unassigned.flatMap((u) =>
      expand(u.visit_id).map((id) => ({
        ...u,
        visit_id: id,
        client: visits.get(id)?.client ?? null,
        service: visits.get(id)?.service ?? null,
      })),
    ),
  };
}

function planCollapsedDay(
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
  // The problem each technician's day is finally timed with: the one solved,
  // or the one with their settled start.
  const timed: SolverProblem[] = routes.map(() => problem);
  // Stops the settling below had to take off a route (by stop index).
  const droppedLate: number[] = [];
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
    timed[t] = p2;
    routes[t] = polishRoute(p2, t, routes[t]);
    // The solver costed this person's first leg at nothing (no start to
    // drive from); from the settled start that leg is real, and a window
    // kept with a free first leg can be missed with a 40-minute one.
    // polishRoute re-orders for the new start but cannot drop a stop, so
    // whatever is still late comes off the route here, first late stop
    // first, re-ordering each time: under "Keep windows" no stop is ever
    // written late. (The reviewer's case on #397: latest 15, solved on time
    // from a null start, re-polished from a start 40 minutes away.)
    if (opts.honourWindows) {
      let late = routeClock(p2, t, routes[t]).late;
      while (late.length) {
        droppedLate.push(late[0]);
        routes[t] = polishRoute(
          p2,
          t,
          routes[t].filter((s) => s !== late[0]),
        );
        late = routeClock(p2, t, routes[t]).late;
      }
    }
  }

  // ── Stops the search left out, named ──
  const byId = new Map(inp.visits.map((v) => [v.id, v]));
  const name = (id: string, reason: UnassignedReason): UnassignedVisit => {
    const v = byId.get(id);
    return {
      visit_id: id,
      reason,
      client: v?.client ?? null,
      service: v?.service ?? null,
      earliest: v?.earliest ?? null,
      latest: v?.latest ?? null,
    };
  };
  const unassigned = [
    ...solution.unassigned.map((u) => name(built.stopIds[u.stop], u.reason)),
    ...droppedLate.map((s) => name(built.stopIds[s], "window")),
  ];

  // ── Stops with no location ──
  // Last on whichever route they belong to: pinned ones on their own person,
  // the rest one at a time to whoever has the least of their day used among
  // those who can do the service. Nobody knows the drive to them, so the
  // write puts each at the end of the day with a free leg: it arrives when
  // the last located stop finishes (or waits for its earliest time). That
  // clock is replayed here, and a tail stop whose window that clock cannot
  // keep is named rather than written late. With windows set aside nothing
  // is checked, as for every other stop.
  const load = solution.costs.map((c) => c.load);
  const clock = routes.map((r, t) => routeClock(timed[t], t, r).end);
  const tail: string[][] = routes.map(() => []);
  /** When the write would reach this stop on technician t, or null when
   *  that is after its window. */
  const arrival = (t: number, u: BuiltDay["unlocated"][number]): number | null => {
    const at = Math.max(clock[t], u.earliest ?? 0);
    return opts.honourWindows && u.latest != null && at > u.latest ? null : at;
  };
  for (const u of built.unlocated) {
    let t = u.fixedTech;
    if (t == null) {
      const may = (u.eligibleTechs ?? [...Array(load.length).keys()]).filter(
        (k) => arrival(k, u) != null,
      );
      if (may.length === 0) {
        const can = u.eligibleTechs ?? [...Array(load.length).keys()];
        unassigned.push(name(u.id, can.length === 0 ? "no_eligible_tech" : "window"));
        continue;
      }
      t = may[0];
      for (const k of may) {
        if (load[k] / problem.techs[k].capacity < load[t] / problem.techs[t].capacity) t = k;
      }
    } else if (arrival(t, u) == null) {
      unassigned.push(name(u.id, "window"));
      continue;
    }
    tail[t].push(u.id);
    load[t] += u.service;
    clock[t] = arrival(t, u)! + u.service;
  }

  return {
    routes: routes.map((r, t) => ({
      staff_id: built.techIds[t],
      visit_ids: [...r.map((s) => built.stopIds[s]), ...tail[t]],
    })),
    unassigned,
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
