// The route solver (src/lib/route-solver.ts), on its own: no database, no
// network, synthetic days. tests/routing-trials.test.ts runs it end to end
// against the real inputs and the real write; this file pins the parts of the
// search that are pure arithmetic, so a regression names the move that broke.
//
// Why the solver exists at all is in its header: the plpgsql planner took
// 7-23 seconds on a 200-stop day against an 8-second API limit.

import { describe, expect, it } from "vitest";
import {
  balanceCost,
  evaluateRoute,
  exactOrder,
  objective,
  prng,
  solveRoutes,
  type SolverProblem,
  type SolverStop,
} from "@/lib/route-solver";

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

/** The SQL planner's per-route method, in TypeScript: nearest neighbour from
 *  the start, then 2-opt to a local optimum. The floor the solver must clear. */
function nnTwoOpt(p: SolverProblem, t: number, stops: number[]): number[] {
  const N = p.size;
  const from = p.techs[t].start!;
  const left = new Set(stops);
  const order: number[] = [];
  let at = from;
  while (left.size) {
    let best = -1;
    for (const s of left) if (best < 0 || p.matrix[at * N + s] < p.matrix[at * N + best]) best = s;
    order.push(best);
    left.delete(best);
    at = best;
  }
  const cost = (o: number[]) => evaluateRoute(p, t, o).drive;
  let improved = true;
  let cur = order;
  while (improved) {
    improved = false;
    for (let i = 0; i < cur.length - 1; i++)
      for (let k = i + 1; k < cur.length; k++) {
        const cand = [...cur.slice(0, i), ...cur.slice(i, k + 1).reverse(), ...cur.slice(k + 1)];
        if (cost(cand) < cost(cur) - 1e-9) {
          cur = cand;
          improved = true;
        }
      }
  }
  return cur;
}

const DETERMINISTIC = { rounds: 150, timeLimitMs: 60_000, seed: 7 };

describe("Held-Karp gives the exact best order for a small route", () => {
  it("agrees with brute force over every permutation, open and closed", () => {
    for (let seed = 1; seed <= 6; seed++) {
      const p = day(7, 1, seed);
      const stops = [0, 1, 2, 3, 4, 5, 6];
      const start = 7;
      for (const end of [null, 3]) {
        const cost = (o: number[]) => {
          let c = 0;
          let at = start;
          for (const s of o) {
            c += p.matrix[at * p.size + s];
            at = s;
          }
          return c + (end == null ? 0 : p.matrix[at * p.size + end]);
        };
        let best = Infinity;
        const perm = (pre: number[], rest: number[]) => {
          if (!rest.length) best = Math.min(best, cost(pre));
          rest.forEach((x, i) => perm([...pre, x], [...rest.slice(0, i), ...rest.slice(i + 1)]));
        };
        perm([], stops);
        const got = exactOrder(p.matrix, p.size, start, end, stops);
        expect(got.slice().sort()).toEqual(stops);
        expect(cost(got)).toBeCloseTo(best, 9);
      }
    }
  });
});

describe("the solver's answer is a plan", () => {
  it("routes every stop exactly once, and a pinned stop stays with its technician", () => {
    const p = day(40, 3, 11, {
      stops: [{ fixedTech: 2 }, { fixedTech: 2 }, {}, {}, { fixedTech: 0 }],
    });
    const s = solveRoutes(p, DETERMINISTIC);
    const all = s.routes.flat().sort((a, b) => a - b);
    expect(all).toEqual([...Array(40).keys()]);
    expect(s.routes[2]).toContain(0);
    expect(s.routes[2]).toContain(1);
    expect(s.routes[0]).toContain(4);
  });

  it("is deterministic: the same day and seed give the same routes", () => {
    const p = day(60, 4, 5);
    const a = solveRoutes(p, DETERMINISTIC);
    const b = solveRoutes(p, DETERMINISTIC);
    expect(a.routes).toEqual(b.routes);
    expect(a.objective).toBe(b.objective);
  });

  it("reports the objective it actually achieved", () => {
    const p = day(30, 3, 9);
    const s = solveRoutes(p, DETERMINISTIC);
    expect(objective(p, s.routes)).toBeCloseTo(s.objective, 6);
  });
});

describe("the solver is no worse than the planner it replaced", () => {
  it("drives no further, per route, than nearest-neighbour + 2-opt on the same stops", () => {
    for (let seed = 1; seed <= 5; seed++) {
      const p = day(30, 2, seed * 13);
      const s = solveRoutes(p, DETERMINISTIC);
      s.routes.forEach((r, t) => {
        const mine = evaluateRoute(p, t, r).drive;
        const theirs = evaluateRoute(p, t, nnTwoOpt(p, t, r)).drive;
        expect(mine, `seed ${seed} truck ${t}`).toBeLessThanOrEqual(theirs + 1e-6);
      });
    }
  });

  it("finds the exact order for a single truck with twelve stops or fewer", () => {
    const p = day(10, 1, 3);
    const s = solveRoutes(p, DETERMINISTIC);
    const exact = exactOrder(p.matrix, p.size, p.techs[0].start, null, s.routes[0]);
    expect(evaluateRoute(p, 0, s.routes[0]).drive).toBeCloseTo(evaluateRoute(p, 0, exact).drive, 9);
  });
});

describe("balance is a share of each person's own capacity", () => {
  it("gives a 120-minute part-timer a quarter of a full-timer's day, not an equal one", () => {
    const p = day(36, 3, 21);
    p.techs[2].capacity = 120;
    const s = solveRoutes(p, DETERMINISTIC);
    const load = s.routes.map((r, t) => evaluateRoute(p, t, r).load);
    expect(load[2]).toBeLessThanOrEqual(120);
    expect(load[2]).toBeGreaterThan(0);
    // Mutation: with capacity ignored the three loads come out equal.
    expect(load[2]).toBeLessThan(Math.min(load[0], load[1]) * 0.6);
  });

  it("costs nothing for one truck or equal shares, and grows with the spread", () => {
    expect(balanceCost([300], [480])).toBe(0);
    expect(balanceCost([315, 315], [480, 480])).toBe(0);
    expect(balanceCost([330, 300], [480, 480])).toBeGreaterThan(0);
    expect(balanceCost([400, 230], [480, 480])).toBeGreaterThan(
      balanceCost([330, 300], [480, 480]),
    );
    // A 120-minute day of 60 is the same share as a 480-minute day of 240.
    expect(balanceCost([240, 60], [480, 120])).toBe(0);
    expect(balanceCost([150, 150], [480, 120])).toBeGreaterThan(0);
    // Past the 10-minute tolerance each minute of spread costs more.
    const step = (a: number) => balanceCost([300 + a, 300], [480, 480]);
    expect(step(30) - step(20)).toBeGreaterThan(step(10) - step(0));
  });

  it("never 'balances' a day by driving it in a worse order", () => {
    // A spread rewards making the emptiest day fuller by ANY means, and the
    // first version of the search found one: a stop inserted badly into the
    // part-timer's day, undone by 2-opt, redone by the next move, round and
    // round (55 s on this day). Moves between routes are now judged after
    // both are re-ordered, so every route that comes back is as short as its
    // own stops allow -- no 2-opt move shortens any of them.
    const p = day(36, 3, 21);
    p.techs[2].capacity = 120;
    const s = solveRoutes(p, DETERMINISTIC);
    expect(s.ms).toBeLessThan(20_000);
    s.routes.forEach((r, t) => {
      const mine = evaluateRoute(p, t, r).drive;
      expect(evaluateRoute(p, t, nnTwoOpt(p, t, r)).drive, `truck ${t}`).toBeGreaterThanOrEqual(
        mine - 1e-6,
      );
      for (let i = 0; i < r.length - 1; i++)
        for (let k = i + 1; k < r.length; k++) {
          const flipped = [...r.slice(0, i), ...r.slice(i, k + 1).reverse(), ...r.slice(k + 1)];
          expect(evaluateRoute(p, t, flipped).drive).toBeGreaterThanOrEqual(mine - 1e-6);
        }
    });
  });
});

describe("arrival windows: honoured, or set aside and still counted", () => {
  // One truck, start at the origin. Stop 0 is far east with an 08:00-08:30
  // window (latest 30 minutes after the workday start); stops 1-4 sit on the
  // way west. Shortest driving goes west first and reaches stop 0 late.
  function windowDay(honour: boolean): SolverProblem {
    const pts: Array<[number, number]> = [
      [10, 0], // 0: east, the window
      [-2, 0],
      [-4, 0],
      [-6, 0],
      [-8, 0],
      [0, 0], // 5: start
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
        latest: i === 0 ? 30 : null,
        pref: null,
        fixedTech: null,
      })),
      techs: [{ start: 5, end: null, capacity: 480 }],
      honourWindows: honour,
      noon: 240,
    };
  }

  it("drives further rather than arrive late when windows are honoured", () => {
    const p = windowDay(true);
    const s = solveRoutes(p, DETERMINISTIC);
    expect(s.routes[0][0]).toBe(0);
    expect(evaluateRoute(p, 0, s.routes[0]).late).toBe(0);
  });

  it("takes the shortest drive when they are set aside, and the lateness is still measurable", () => {
    const honoured = solveRoutes(windowDay(true), DETERMINISTIC);
    const p = windowDay(false);
    const s = solveRoutes(p, DETERMINISTIC);
    expect(s.routes[0][0]).not.toBe(0);
    expect(evaluateRoute(p, 0, s.routes[0]).drive).toBeLessThan(
      evaluateRoute(p, 0, honoured.routes[0]).drive,
    );
    // The same route timed with windows on: late. The write reports it.
    const timed = evaluateRoute({ ...p, honourWindows: true }, 0, s.routes[0]);
    expect(timed.late).toBeGreaterThan(0);
  });
});

describe("a 200-stop, six-truck day fits the time budget", () => {
  it("returns its best-so-far inside the budget it was given", () => {
    const p = day(200, 6, 20261014);
    const s = solveRoutes(p, { timeLimitMs: 2000, seed: 1 });
    expect(s.routes.flat()).toHaveLength(200);
    // The budget is checked between moves, so it can be overrun by one
    // local-search pass -- not by seconds.
    expect(s.ms).toBeLessThan(6000);
    const loads = s.routes.map((r, t) => evaluateRoute(p, t, r).load);
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(60);
    console.log(
      `200 stops / 6 trucks: ${s.ms} ms, ${s.rounds} rounds, stopped by ${s.stoppedBy}, ` +
        `drive ${s.costs.reduce((a, c) => a + c.drive, 0).toFixed(1)} min`,
    );
  }, 30_000);
});
