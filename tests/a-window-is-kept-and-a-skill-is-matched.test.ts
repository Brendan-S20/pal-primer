// A window is kept and a skill is matched (appointment routing, phase 4):
// the pure half. The solver (src/lib/route-solver.ts) and the problem builder
// (src/lib/route-inputs.ts) on synthetic days, no database.
//
// The owner's three requirements, each pinned here:
//
//   1. Windows are always honoured. A stop is never routed to arrive after
//      its window; one that cannot be reached in time on any route comes back
//      unassigned with the reason "window", never silently late or dropped.
//   2. Technicians have service skills. A stop goes only to someone who can
//      do its service; one nobody on the run can do comes back as
//      "no_eligible_tech".
//   3. Nothing changes for a business that has set no skills and has no
//      windows: the same day gives the same routes as before, move for move.
//
// The database half -- the skills table, the read that carries them and the
// write that takes the unassigned list -- is
// tests/a-window-is-kept-and-a-skill-is-matched-in-a-real-database.test.ts,
// and the whole pipeline on real inputs is tests/routing-trials.test.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allowedTechs,
  evaluateRoute,
  objective,
  prng,
  solveRoutes,
  type SolverProblem,
  type SolverStop,
} from "@/lib/route-solver";
import { buildDay, eligibleTechsFor, planDay, type RouteDayInputs } from "@/lib/route-inputs";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** A synthetic day: `n` stops and `k` trucks scattered on a plane, drive
 *  minutes = straight-line km at 30 km/h plus 2 minutes' park-and-walk. */
function day(
  n: number,
  k: number,
  seed: number,
  extra: Partial<SolverProblem> & { stops?: Partial<SolverStop>[] } = {},
): SolverProblem {
  const r = prng(seed);
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n + k; i++) pts.push([r() * 30, r() * 30]);
  const N = pts.length;
  const m = new Float64Array(N * N);
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
      m[i * N + j] = i === j ? 0 : (d / 30) * 60 + 2;
    }
  return {
    size: N,
    matrix: m,
    stops: Array.from({ length: n }, (_, i) => ({
      service: 8,
      earliest: null,
      latest: null,
      pref: null,
      fixedTech: null,
      ...(extra.stops?.[i] ?? {}),
    })),
    techs: Array.from({ length: k }, (_, t) => ({ start: n + t, end: null, capacity: 480 })),
    honourWindows: true,
    noon: 240,
    ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== "stops")),
  } as SolverProblem;
}

// Clock-free, not merely generous. The solver's one impure input is `now`:
// `deadline()` returns the best day so far the moment the budget is spent,
// and a search cut at round 17 is a different (and worse) day from one that
// ran its 150 rounds. On 2026-10-10 "routes the same day the same way whether
// skills are absent or say everyone" failed once on this machine at load
// average 38 (a CI job plus Spotlight) and passed on every rerun: a 1.7 s
// solve under `nice -n 15` on a saturated box can run past a 60 s limit, and
// a frozen clock is the only thing that makes "the same day, move for move"
// a statement about the algorithm rather than about the machine.
const DETERMINISTIC = { rounds: 150, timeLimitMs: 60_000, seed: 7, now: () => 0 };

/** One truck at the origin; stop 0 is 10 km east (20 minutes' drive) with a
 *  window closing `latest` minutes after the workday starts; stops 1-4 sit
 *  on the way west. */
function windowDay(latest: number, honour = true): SolverProblem {
  const pts: Array<[number, number]> = [
    [10, 0],
    [-2, 0],
    [-4, 0],
    [-6, 0],
    [-8, 0],
    [0, 0],
  ];
  const N = pts.length;
  const m = new Float64Array(N * N);
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++)
      m[i * N + j] = i === j ? 0 : Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) * 2;
  return {
    size: N,
    matrix: m,
    stops: pts.slice(0, 5).map((_, i) => ({
      service: 5,
      earliest: i === 0 ? 0 : null,
      latest: i === 0 ? latest : null,
      pref: null,
      fixedTech: null,
    })),
    techs: [{ start: 5, end: null, capacity: 480 }],
    honourWindows: honour,
    noon: 240,
  };
}

describe("a window is kept", () => {
  it("drives further rather than arrive late, and leaves nothing out, when the window can be kept", () => {
    const p = windowDay(30);
    const s = solveRoutes(p, DETERMINISTIC);
    expect(s.unassigned).toEqual([]);
    expect(s.routes[0][0]).toBe(0);
    expect(evaluateRoute(p, 0, s.routes[0]).late).toBe(0);
  });

  it("leaves out a stop no route can reach in time, names why, and routes the rest on time", () => {
    // 20 minutes' drive to a window that closes after 5: impossible from
    // the first minute of the day. Until 2026-10-10 this was planned 15
    // minutes late and flagged.
    const p = windowDay(5);
    const s = solveRoutes(p, DETERMINISTIC);
    expect(s.unassigned).toEqual([{ stop: 0, reason: "window" }]);
    expect(s.routes[0].slice().sort()).toEqual([1, 2, 3, 4]);
    expect(evaluateRoute(p, 0, s.routes[0]).late).toBe(0);
    // The objective reported is the cost of the routes returned.
    expect(objective(p, s.routes)).toBeCloseTo(s.objective, 6);
  });

  it("never puts a stop late to make room for another: two windows, one truck", () => {
    // Stop 0 must be first (window closes at 30); stop 1, 2 km further
    // east, closes at 20 -- reachable only by skipping stop 0, which the
    // search may not do either. One of them is left out, neither is late.
    const p = windowDay(30);
    p.stops[1] = { ...p.stops[1], earliest: 0, latest: 20 };
    const N = p.size;
    // Put stop 1 beyond stop 0 instead of west of the start.
    const pts: Array<[number, number]> = [
      [10, 0],
      [12, 0],
      [-4, 0],
      [-6, 0],
      [-8, 0],
      [0, 0],
    ];
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++)
        p.matrix[i * N + j] =
          i === j ? 0 : Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) * 2;
    const s = solveRoutes(p, DETERMINISTIC);
    expect(s.unassigned.map((u) => u.reason)).toEqual(["window"]);
    expect(s.unassigned).toHaveLength(1);
    expect(evaluateRoute(p, 0, s.routes[0]).late).toBe(0);
    expect(s.routes[0]).toHaveLength(4);
  });

  it("with windows set aside, the same impossible window is planned and still measurable (unchanged)", () => {
    const p = windowDay(5, false);
    const s = solveRoutes(p, DETERMINISTIC);
    expect(s.unassigned).toEqual([]);
    expect(s.routes[0].slice().sort()).toEqual([0, 1, 2, 3, 4]);
    expect(evaluateRoute({ ...p, honourWindows: true }, 0, s.routes[0]).late).toBeGreaterThan(0);
  });

  it("a second truck that can reach the window takes it rather than leaving it out", () => {
    // Same stops; a second truck starts right at the windowed stop.
    const p = windowDay(5);
    const pts: Array<[number, number]> = [
      [10, 0],
      [-2, 0],
      [-4, 0],
      [-6, 0],
      [-8, 0],
      [0, 0],
      [10.5, 0],
    ];
    const N = pts.length;
    const m = new Float64Array(N * N);
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++)
        m[i * N + j] = i === j ? 0 : Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) * 2;
    const q: SolverProblem = {
      ...p,
      size: N,
      matrix: m,
      techs: [
        { start: 5, end: null, capacity: 480 },
        { start: 6, end: null, capacity: 480 },
      ],
    };
    const s = solveRoutes(q, DETERMINISTIC);
    expect(s.unassigned).toEqual([]);
    expect(s.routes[1]).toContain(0);
    s.routes.forEach((r, t) => expect(evaluateRoute(q, t, r).late).toBe(0));
  });
});

describe("a skill is matched", () => {
  it("gives a stop only to a technician who can do its service, on every seed", () => {
    for (let seed = 1; seed <= 4; seed++) {
      const p = day(36, 3, seed * 17, {
        stops: [
          { eligibleTechs: [2] },
          { eligibleTechs: [2] },
          { eligibleTechs: [0, 1] },
          { eligibleTechs: [1] },
          { eligibleTechs: [0] },
        ],
      });
      const s = solveRoutes(p, { ...DETERMINISTIC, seed });
      expect(s.unassigned, `seed ${seed}`).toEqual([]);
      expect(s.routes.flat().sort((a, b) => a - b)).toEqual([...Array(36).keys()]);
      expect(s.routes[2]).toContain(0);
      expect(s.routes[2]).toContain(1);
      expect(s.routes[2]).not.toContain(2);
      expect(s.routes[1]).toContain(3);
      expect(s.routes[0]).toContain(4);
    }
  });

  it("reports a stop nobody on the run can do, and routes everything else", () => {
    const p = day(20, 2, 3, { stops: [{}, { eligibleTechs: [] }, {}, { eligibleTechs: [] }] });
    const s = solveRoutes(p, DETERMINISTIC);
    expect(s.unassigned).toEqual([
      { stop: 1, reason: "no_eligible_tech" },
      { stop: 3, reason: "no_eligible_tech" },
    ]);
    expect(s.routes.flat().sort((a, b) => a - b)).toEqual(
      [...Array(20).keys()].filter((i) => i !== 1 && i !== 3),
    );
  });

  it("folds the pin and the skill into one table, and a pin to someone without the skill is nobody", () => {
    const p = day(3, 2, 1, {
      stops: [{ fixedTech: 1 }, { eligibleTechs: [0] }, { fixedTech: 1, eligibleTechs: [0] }],
    });
    expect([...allowedTechs(p)]).toEqual([0, 1, 1, 0, 0, 0]);
    const s = solveRoutes(p, DETERMINISTIC);
    expect(s.routes[1]).toEqual([0]);
    expect(s.routes[0]).toEqual([1]);
    expect(s.unassigned).toEqual([{ stop: 2, reason: "no_eligible_tech" }]);
  });

  it("keeps skills and windows together on a bigger day inside the budget", () => {
    // Three kinds of work, each truck able to do two of them; a handful of
    // windows that can all be kept.
    const n = 90;
    const kinds = [
      [0, 1],
      [1, 2],
      [0, 2],
      [0, 1, 2],
    ];
    const r = prng(99);
    const stops: Partial<SolverStop>[] = [];
    for (let i = 0; i < n; i++) {
      const kind = Math.floor(r() * 3);
      const eligible = kinds.map((k, t) => (k.includes(kind) ? t : -1)).filter((t) => t >= 0);
      stops.push({ eligibleTechs: eligible, latest: i % 15 === 0 ? 300 : null });
    }
    const p = day(n, 4, 2026, { stops });
    const s = solveRoutes(p, { rounds: 300, timeLimitMs: 20_000, seed: 3, now: () => 0 });
    expect(s.unassigned).toEqual([]);
    expect(s.routes.flat()).toHaveLength(n);
    s.routes.forEach((route, t) => {
      for (const st of route) expect(p.stops[st].eligibleTechs, `stop ${st}`).toContain(t);
      expect(evaluateRoute(p, t, route).late).toBe(0);
    });
  }, 60_000);
});

describe("nothing changes for a business with no skills and no windows", () => {
  // Nine 40-stop solves. About 7s on a laptop, but past 30s on the shared Windows runner when other jobs load it.
  it("routes the same day the same way whether skills are absent or say everyone", () => {
    for (let seed = 1; seed <= 3; seed++) {
      const plain = day(40, 3, seed * 7);
      const spelled = day(40, 3, seed * 7, {
        stops: Array.from({ length: 40 }, () => ({ eligibleTechs: [0, 1, 2] })),
      });
      const nulled = day(40, 3, seed * 7, {
        stops: Array.from({ length: 40 }, () => ({ eligibleTechs: null })),
      });
      const a = solveRoutes(plain, DETERMINISTIC);
      const b = solveRoutes(spelled, DETERMINISTIC);
      const c = solveRoutes(nulled, DETERMINISTIC);
      expect(b.routes, `seed ${seed}`).toEqual(a.routes);
      expect(c.routes, `seed ${seed}`).toEqual(a.routes);
      expect(b.objective).toBe(a.objective);
      expect(a.unassigned).toEqual([]);
    }
  }, 120_000);

  it("routes a day with no windows identically whether windows are honoured or set aside", () => {
    // Without a window on any stop the clock does not enter the search at
    // all, so the hard rule cannot change a pet-waste day.
    const p = day(50, 3, 31);
    const honoured = solveRoutes({ ...p, honourWindows: true }, DETERMINISTIC);
    const ignored = solveRoutes({ ...p, honourWindows: false }, DETERMINISTIC);
    expect(honoured.routes).toEqual(ignored.routes);
    expect(honoured.unassigned).toEqual([]);
  });

  it("still routes every stop exactly once, keeps a pinned stop with its technician, and is deterministic", () => {
    const p = day(40, 3, 11, {
      stops: [{ fixedTech: 2 }, { fixedTech: 2 }, {}, {}, { fixedTech: 0 }],
    });
    const a = solveRoutes(p, DETERMINISTIC);
    const b = solveRoutes(p, DETERMINISTIC);
    expect(a.routes.flat().sort((x, y) => x - y)).toEqual([...Array(40).keys()]);
    expect(a.routes[2]).toContain(0);
    expect(a.routes[2]).toContain(1);
    expect(a.routes[0]).toContain(4);
    expect(a.routes).toEqual(b.routes);
  });
});

// ── From what Postgres says to what the solver is asked ─────────────────────

const WALK = "11111111-0000-4000-8000-000000000001";
const CLEAN = "11111111-0000-4000-8000-000000000002";
const GROOM = "11111111-0000-4000-8000-000000000003";

function inputs(over: Partial<RouteDayInputs> = {}): RouteDayInputs {
  return {
    org: {
      timezone: "America/Chicago",
      workday_start: "08:00",
      workday_end: "17:00",
      park_walk_min: 2,
      road_factor: 1.35,
      speed_kmh: 30,
      measured_legs: null,
      max_drive_minutes: 240,
      route_windows: "honour",
      latitude: null,
      longitude: null,
    },
    techs: [
      {
        id: "a",
        capacity: 480,
        start_lat: 41.9,
        start_lon: -87.65,
        end_lat: null,
        end_lon: null,
        current_min: null,
        current_stops: null,
        current_sequenced: null,
        services: [WALK],
      },
      {
        id: "b",
        capacity: 480,
        start_lat: 41.91,
        start_lon: -87.66,
        end_lat: null,
        end_lon: null,
        current_min: null,
        current_stops: null,
        current_sequenced: null,
        services: [CLEAN],
      },
    ],
    visits: [
      visit("v-walk", WALK, "30-minute walk", "Walk Client", 41.92, -87.65),
      visit("v-clean", CLEAN, "Pet waste removal", "Yard Client", 41.93, -87.66),
      visit("v-groom", GROOM, "Full groom", "Groom Client", 41.94, -87.67),
    ],
    dumps: [],
    day_centroid: null,
    points: [],
    legs: [],
    ...over,
  };
}

function visit(
  id: string,
  service_id: string | null,
  service: string | null,
  client: string,
  lat: number | null,
  lon: number | null,
  more: Partial<RouteDayInputs["visits"][number]> = {},
): RouteDayInputs["visits"][number] {
  return {
    id,
    lat,
    lon,
    service_min: 10,
    earliest: null,
    latest: null,
    pref: "any",
    assigned_staff_id: null,
    fixed: false,
    service_id,
    service,
    client,
    ...more,
  };
}

describe("who may take a visit, from the skills route_day_inputs carries", () => {
  const techs = [{ services: [WALK] }, { services: null }, { services: [] }, { services: [CLEAN] }];

  it("is everyone (null) when no technician has skills, or the visit names no service", () => {
    expect(
      eligibleTechsFor({ service_id: WALK }, [{ services: null }, { services: [] }]),
    ).toBeNull();
    expect(eligibleTechsFor({ service_id: null }, techs)).toBeNull();
    expect(eligibleTechsFor({}, techs)).toBeNull();
  });

  it("is the skilled and the unrestricted, by index", () => {
    expect(eligibleTechsFor({ service_id: WALK }, techs)).toEqual([0, 1, 2]);
    expect(eligibleTechsFor({ service_id: CLEAN }, techs)).toEqual([1, 2, 3]);
    expect(eligibleTechsFor({ service_id: GROOM }, techs)).toEqual([1, 2]);
    expect(eligibleTechsFor({ service_id: GROOM }, [{ services: [WALK] }])).toEqual([]);
  });

  it("stands aside for a visit fixed to its technician: the dispatcher's assignment wins", () => {
    expect(eligibleTechsFor({ service_id: GROOM, fixed: true }, [{ services: [WALK] }])).toBeNull();
  });

  it("is null when every technician qualifies, so the solver sees the day it always saw", () => {
    expect(
      eligibleTechsFor({ service_id: WALK }, [{ services: [WALK] }, { services: null }]),
    ).toBeNull();
  });
});

describe("planDay names what it could not place", () => {
  it("puts the walk on the walker, the cleanup on the scooper, and names the groom nobody does", () => {
    const plan = planDay(inputs(), {
      day: "2026-10-14",
      honourWindows: true,
      solver: DETERMINISTIC,
    });
    const by = Object.fromEntries(plan.routes.map((r) => [r.staff_id, r.visit_ids]));
    expect(by.a).toEqual(["v-walk"]);
    expect(by.b).toEqual(["v-clean"]);
    expect(plan.unassigned).toEqual([
      {
        visit_id: "v-groom",
        reason: "no_eligible_tech",
        client: "Groom Client",
        service: "Full groom",
        earliest: null,
        latest: null,
      },
    ]);
  });

  it("names a visit whose window no route can keep, with the window", () => {
    const inp = inputs({
      visits: [
        visit("v-walk", WALK, "30-minute walk", "Walk Client", 41.92, -87.65),
        // 50 km from both starts, window closing five minutes into the day.
        visit("v-far", CLEAN, "Pet waste removal", "Far Client", 42.3, -87.65, {
          earliest: "08:00",
          latest: "08:05",
        }),
      ],
    });
    const plan = planDay(inp, { day: "2026-10-14", honourWindows: true, solver: DETERMINISTIC });
    expect(plan.unassigned).toEqual([
      {
        visit_id: "v-far",
        reason: "window",
        client: "Far Client",
        service: "Pet waste removal",
        earliest: "08:00",
        latest: "08:05",
      },
    ]);
    expect(plan.routes.flatMap((r) => r.visit_ids)).toEqual(["v-walk"]);
  });

  it("gives a stop with no map location only to someone who can do it, else names it", () => {
    // With the scooper unrestricted (no skill rows), anyone may take the
    // lost walk and only the scooper may take the lost groom.
    const inp = inputs({
      techs: inputs().techs.map((t) => (t.id === "b" ? { ...t, services: null } : t)),
      visits: [
        visit("v-walk", WALK, "30-minute walk", "Walk Client", 41.92, -87.65),
        visit("u-walk", WALK, "30-minute walk", "Lost Walk Client", null, null),
        visit("u-groom", GROOM, "Full groom", "Lost Groom Client", null, null),
      ],
    });
    const built = buildDay(inp, { day: "2026-10-14", honourWindows: true });
    expect(built.unlocated.map((u) => [u.id, u.eligibleTechs])).toEqual([
      ["u-walk", null],
      ["u-groom", [1]],
    ]);
    // With the scooper restricted to cleanups, the lost walk goes to the
    // walker and the lost groom to nobody.
    const inp2 = inputs({ visits: inp.visits });
    const plan = planDay(inp2, { day: "2026-10-14", honourWindows: true, solver: DETERMINISTIC });
    const by = Object.fromEntries(plan.routes.map((r) => [r.staff_id, r.visit_ids]));
    expect(by.a).toEqual(["v-walk", "u-walk"]);
    expect(by.b).toEqual([]);
    expect(plan.unassigned.map((u) => [u.visit_id, u.reason])).toEqual([
      ["u-groom", "no_eligible_tech"],
    ]);
  });

  it("changes nothing for a day with no skills and no windows: every visit placed, nothing named", () => {
    const inp = inputs({
      techs: inputs().techs.map((t) => ({ ...t, services: null })),
      visits: inputs().visits.map((v) => ({ ...v, service_id: null, service: null })),
    });
    const plan = planDay(inp, { day: "2026-10-14", honourWindows: true, solver: DETERMINISTIC });
    expect(plan.unassigned).toEqual([]);
    expect(plan.routes.flatMap((r) => r.visit_ids).sort()).toEqual([
      "v-clean",
      "v-groom",
      "v-walk",
    ]);
    const built = buildDay(inp, { day: "2026-10-14", honourWindows: true });
    for (const s of built.problem.stops) expect(s.eligibleTechs).toBeNull();
  });
});

describe("the settled start and the tail keep the rule too (review of #397)", () => {
  it("drops a stop the settled start makes late, rather than writing it late", () => {
    // The reviewer's case: a technician with no start address and a business
    // with no location. The solver costs the first leg at nothing and keeps
    // the 15-minute window by going there first; the start is then settled
    // on the stop furthest from the round, 67 km away, and from there the
    // window cannot be kept by any order. Until this the re-polish returned
    // that order and the write stamped it late.
    const inp = inputs({
      techs: [{ ...inputs().techs[0], start_lat: null, start_lon: null, services: null }],
      visits: [
        visit("v-window", WALK, "30-minute walk", "Window Client", 41.9, -87.65, {
          earliest: "08:00",
          latest: "08:15",
        }),
        visit("v-mid", WALK, "30-minute walk", "Mid Client", 42.1, -87.65),
        visit("v-far", WALK, "30-minute walk", "Far Client", 42.5, -87.65),
      ],
    });
    const plan = planDay(inp, { day: "2026-10-14", honourWindows: true, solver: DETERMINISTIC });
    expect(plan.startTier).toEqual(["route"]);
    expect(plan.unassigned.map((u) => [u.visit_id, u.reason, u.latest])).toEqual([
      ["v-window", "window", "08:15"],
    ]);
    expect(plan.routes[0].visit_ids.slice().sort()).toEqual(["v-far", "v-mid"]);
    // With windows set aside the same day is written whole, as before.
    const aside = planDay(inp, { day: "2026-10-14", honourWindows: false, solver: DETERMINISTIC });
    expect(aside.unassigned).toEqual([]);
    expect(aside.routes[0].visit_ids).toHaveLength(3);
  });

  it("puts a stop with no map location at the end of the day only where its window survives that", () => {
    // The write gives a tail stop a free leg: it arrives when the last
    // located stop finishes. The walker's located stop is 11 km out (about
    // 30 minutes' drive, 10 on site), so her day ends past 08:20 and the
    // lost 08:20 walk is named; the lost 09:30 walk is fine on her tail; the
    // scooper has nothing located, so his clock is 08:00 and the lost 08:05
    // cleanup fits.
    const inp = inputs({
      visits: [
        visit("v-walk", WALK, "30-minute walk", "Walk Client", 42.0, -87.65),
        visit("u-early", WALK, "30-minute walk", "Lost Early Client", null, null, {
          latest: "08:20",
        }),
        visit("u-later", WALK, "30-minute walk", "Lost Later Client", null, null, {
          latest: "09:30",
        }),
        visit("u-clean", CLEAN, "Pet waste removal", "Lost Yard Client", null, null, {
          latest: "08:05",
        }),
      ],
    });
    const plan = planDay(inp, { day: "2026-10-14", honourWindows: true, solver: DETERMINISTIC });
    const by = Object.fromEntries(plan.routes.map((r) => [r.staff_id, r.visit_ids]));
    expect(by.a).toEqual(["v-walk", "u-later"]);
    expect(by.b).toEqual(["u-clean"]);
    expect(plan.unassigned.map((u) => [u.visit_id, u.reason, u.latest])).toEqual([
      ["u-early", "window", "08:20"],
    ]);
    // Set aside, the tail is not checked and every stop is placed.
    const aside = planDay(inp, { day: "2026-10-14", honourWindows: false, solver: DETERMINISTIC });
    expect(aside.unassigned).toEqual([]);
  });

  it("keeps the 60-stop insertion estimate for a day with preferences and no window", () => {
    // Owner's rule 3: a pet-waste day over 60 stops is built exactly as it
    // was. The timed insertion scan is only forced past 60 stops when some
    // stop has a latest time; a preference alone cannot make a route late.
    const solver = read("src/lib/route-solver.ts");
    expect(solver).toMatch(/if \(st\.timeline && \(st\.hard \|\| n <= 60\)\)/);
    expect(solver).toMatch(
      /return p\.honourWindows && p\.stops\.some\(\(s\) => s\.latest != null\)/,
    );
  });
});

describe("the list reaches the write and the screen", () => {
  it("is handed to apply_route_plans with each day, so a left-out stop is not 'the day changed'", () => {
    const plan = read("src/lib/route-plan.server.ts");
    expect(plan).toMatch(/unassigned: p\.unassigned\.map\(\(u\) => u\.visit_id\)/);
    const sql = read(
      "supabase/migrations/20261010200000_a-window-is-kept-and-a-skill-is-matched.sql",
    );
    expect(sql).toMatch(/_unassigned uuid\[\] DEFAULT NULL/);
    expect(sql).toMatch(/_p->'unassigned'/);
  });

  it("is named to the dispatcher by the panel, with the reason", () => {
    const run = read("src/lib/auto-routing.server.ts");
    expect(run).toMatch(/unassignable: unassignable\.slice\(0, 50\)/);
    const ui = read("src/components/routes/AutoRoutingPanel.tsx");
    expect(ui).toMatch(/left unassigned/);
    expect(ui).toMatch(/nobody on this run does/);
    expect(ui).toMatch(/no route reaches it between/);
  });
});
