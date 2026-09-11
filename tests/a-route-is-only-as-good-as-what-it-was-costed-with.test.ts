/**
 * The harness has to be able to SEE a bad cost matrix.
 *
 * scripts/how-good-is-the-routing.mjs exists to answer a question nothing else
 * in this repo answers: is the order the planner picks any good? Its whole
 * method is to solve the same day three times against three cost matrices and
 * score every resulting order against one reference.
 *
 * That method has an obvious failure mode, and it is the one this file is
 * mostly about: if the harness reported a small penalty no matter what it was
 * given, it would be another green light that cannot go red. So the load
 * bearing test here is `a wrong matrix is caught`, which builds a cost matrix
 * that is deliberately, knowably wrong and asserts the harness charges it for
 * the worse order it picks.
 *
 * The rest pin the arithmetic the headline number rests on: an open tour is not
 * a closed one, Google's request limits are respected so a run bills what it
 * says it will, and an incomplete matrix is refused rather than scored.
 */
import { describe, it, expect } from "vitest";
import {
  solve,
  solveBest,
  tourCost,
  blocks,
  elementsFor,
  ratios,
  isComplete,
} from "../scripts/how-good-is-the-routing.mjs";

/** Minutes between points laid out on a line, at 1 minute per unit. */
function lineMatrix(xs: number[]): number[][] {
  return xs.map((a) => xs.map((b) => Math.abs(a - b)));
}

describe("the solver", () => {
  it("visits every stop exactly once, starting where the vehicle is", () => {
    const m = lineMatrix([0, 5, 2, 9, 1]);
    const order = solve(m);
    expect(order[0]).toBe(0);
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it("finds the sweep on a line, which is the known optimum", () => {
    // Stops at 0, 1, 2, 5, 9: the best open tour from 0 is simply left to
    // right, costing 9. Anything that backtracks costs more.
    const xs = [0, 1, 2, 5, 9];
    const order = solve(lineMatrix(xs));
    expect(order.map((i) => xs[i])).toEqual([0, 1, 2, 5, 9]);
    expect(tourCost(order, lineMatrix(xs))).toBe(9);
  });

  it("refuses an incomplete matrix instead of inventing a stop", () => {
    const m = lineMatrix([0, 1, 2]);
    m[0][1] = NaN;
    m[0][2] = NaN;
    expect(() => solve(m)).toThrow(/incomplete/);
  });
});

describe("the 2-opt actually runs", () => {
  /** Nearest neighbour with no improvement pass, to have something to beat. */
  function greedyOnly(m: number[][]): number[] {
    const n = m.length;
    const seen = new Set([0]);
    const tour = [0];
    while (tour.length < n) {
      const from = tour[tour.length - 1];
      let best = -1;
      let cost = Infinity;
      for (let j = 0; j < n; j++) {
        if (seen.has(j)) continue;
        if (m[from][j] < cost) {
          cost = m[from][j];
          best = j;
        }
      }
      seen.add(best);
      tour.push(best);
    }
    return tour;
  }

  it("improves on a greedy order that traps itself", () => {
    // Six real points, found by searching for a layout where nearest
    // neighbour commits early and cannot undo it. WITHOUT the 2-opt pass this
    // costs 27.1; with it, 26.5.
    //
    // This fixture exists because every other test in this file passed with
    // the improvement pass disabled -- on a line, or on the crafted matrices
    // above, greedy already finds the optimum, so nothing noticed. A solver
    // whose second half silently stopped running would have reported inflated
    // day lengths for all three cost models and looked entirely healthy.
    const pts = [
      [1, 15],
      [2, 17],
      [10, 3],
      [11, 15],
      [1, 18],
      [6, 14],
    ];
    const m = pts.map((a) =>
      pts.map((b) => Math.round(Math.hypot(a[0] - b[0], a[1] - b[1]) * 10) / 10),
    );

    const greedy = tourCost(greedyOnly(m), m);
    const improved = tourCost(solve(m), m);

    expect(greedy).toBeCloseTo(27.1, 5);
    expect(improved).toBeLessThan(greedy);
  });
});

describe("a tour is open, not a loop", () => {
  it("does not charge for driving back to the first stop", () => {
    // 0 -> 1 -> 2 on a line costs 2. A closed tour would cost 4.
    expect(tourCost([0, 1, 2], lineMatrix([0, 1, 2]))).toBe(2);
  });
});

describe("a wrong matrix is caught", () => {
  it("charges the penalty when the cost model picks the wrong order", () => {
    // Four stops. Truth: a line, so the best order is 0,1,2,3 costing 30.
    const truth = [
      [0, 10, 20, 30],
      [10, 0, 10, 20],
      [20, 10, 0, 10],
      [30, 20, 10, 0],
    ];
    // A liar that thinks stop 3 is next door to stop 0 -- the shape of the
    // fault road-legs.server.ts describes, where a straight line crosses water
    // the road has to go around.
    const liar = truth.map((r) => [...r]);
    liar[0][3] = 1;
    liar[3][0] = 1;

    const bestOrder = solve(truth);
    const liarOrder = solve(liar);
    const best = tourCost(bestOrder, truth);
    const penalty = tourCost(liarOrder, truth) - best;

    expect(best).toBe(30);
    expect(liarOrder).not.toEqual(bestOrder);
    // The harness's headline number. If this were 0, the whole script would be
    // reporting a verdict it cannot reach.
    expect(penalty).toBeGreaterThan(0);
  });

  it("reports no penalty when the cost model is merely scaled, not wrong", () => {
    // Doubling every leg changes every number and no decision. A harness that
    // showed a penalty here would be measuring its own noise.
    const truth = lineMatrix([0, 3, 7, 12]);
    const doubled = truth.map((r) => r.map((v) => v * 2));
    expect(tourCost(solve(doubled), truth)).toBe(tourCost(solve(truth), truth));
  });
});

describe("the seed is not allowed to be a variable", () => {
  /**
   * The defect this file did not catch until the harness was RUN.
   *
   * Solving once from index 0 made the headline penalty depend on which stop
   * sorted first. Measured on five real 20-stop days: the spread from moving
   * the start alone was 12-15% of the day, while the effect under test was
   * 3-6%. Two days reported a NEGATIVE penalty -- routing on the worse matrix
   * beating routing on the better one, which cannot be true of cost models and
   * is obvious as heuristic luck.
   */
  const line = (xs: number[]) => xs.map((a) => xs.map((b) => Math.abs(a - b)));

  it("beats the single-start solver where the start actually matters", () => {
    // Found by searching for a layout where starting at index 0 traps the
    // greedy pass somewhere 2-opt cannot recover from: 43.1 from index 0,
    // 33.4 trying every start. A 22% difference decided by nothing but which
    // property id sorted first.
    //
    // This fixture exists because every other test here passed with
    // multi-start reduced to a single start -- the earlier layouts were small
    // enough that index 0 already found the optimum, so nothing noticed. Same
    // hole as the 2-opt one above, found the same way.
    const pts = [
      [3, 16],
      [1, 3],
      [10, 18],
      [11, 1],
      [5, 6],
      [3, 2],
      [2, 12],
    ];
    const m = pts.map((a) =>
      pts.map((b) => Math.round(Math.hypot(a[0] - b[0], a[1] - b[1]) * 10) / 10),
    );
    expect(tourCost(solve(m), m)).toBeCloseTo(43.1, 1);
    expect(tourCost(solveBest(m), m)).toBeCloseTo(33.4, 1);
  });

  it("never returns a worse tour than the single-start solver", () => {
    const pts = [
      [1, 15],
      [2, 17],
      [10, 3],
      [11, 15],
      [1, 18],
      [6, 14],
      [14, 9],
      [3, 2],
    ];
    const m = pts.map((a) =>
      pts.map((b) => Math.round(Math.hypot(a[0] - b[0], a[1] - b[1]) * 10) / 10),
    );
    expect(tourCost(solveBest(m), m)).toBeLessThanOrEqual(tourCost(solve(m), m));
  });

  it("gives the same cost however the stops are numbered", () => {
    // The property that makes the comparison about the MATRIX. Relabelling the
    // stops is not a different day, and must not produce a different answer.
    const xs = [0, 9, 2, 14, 5, 11, 7];
    const m = line(xs);
    const perm = [3, 0, 6, 1, 5, 2, 4];
    const shuffled = perm.map((a) => perm.map((b) => m[a][b]));
    expect(tourCost(solveBest(shuffled), shuffled)).toBeCloseTo(tourCost(solveBest(m), m), 9);
  });

  it("still visits every stop exactly once", () => {
    const m = line([0, 9, 2, 14, 5, 11, 7]);
    expect([...solveBest(m)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("cannot let a worse matrix beat a better one by luck", () => {
    // The end-to-end property. Scored against truth, the tour chosen using
    // truth must never lose to the tour chosen using a liar.
    const truth = line([0, 3, 7, 12, 20, 26]);
    const liar = truth.map((r) => [...r]);
    liar[0][5] = 1;
    liar[5][0] = 1;
    const best = tourCost(solveBest(truth), truth);
    expect(tourCost(solveBest(liar), truth)).toBeGreaterThanOrEqual(best);
  });
});

describe("what a run bills", () => {
  it("covers every cell exactly once", () => {
    const n = 15;
    const seen = new Set<string>();
    for (const b of blocks(n))
      for (const i of b.rows) for (const j of b.cols) seen.add(`${i},${j}`);
    expect(seen.size).toBe(n * n);
  });

  it("stays inside Google's per-request limits", () => {
    for (const n of [1, 9, 10, 11, 25, 26, 40]) {
      for (const b of blocks(n)) {
        expect(b.rows.length).toBeLessThanOrEqual(25);
        expect(b.cols.length).toBeLessThanOrEqual(25);
        expect(b.rows.length * b.cols.length).toBeLessThanOrEqual(100);
      }
    }
  });

  it("counts elements the way the printed estimate does", () => {
    for (const n of [6, 12, 15]) {
      const fromBlocks = blocks(n).reduce((t, b) => t + b.rows.length * b.cols.length, 0);
      expect(elementsFor(n)).toBe(fromBlocks);
    }
  });
});

describe("the ratio report", () => {
  it("reports the tail rather than hiding it in a mean", () => {
    // Nine good legs and one terrible one. A mean would read about 1.3 and
    // suggest a systemic bias; the truth is one bad leg.
    const r = ratios([1, 1, 1, 1, 1, 1, 1, 1, 1, 4])!;
    expect(r.median).toBe(1);
    expect(r.worst).toBe(4);
    expect(r.n).toBe(10);
  });

  it("says nothing rather than something when there is nothing to say", () => {
    expect(ratios([])).toBeNull();
    expect(ratios([NaN, Infinity, -1, 0])).toBeNull();
  });
});

describe("an incomplete matrix is refused", () => {
  it("spots an unreachable pair", () => {
    const m = lineMatrix([0, 1, 2]);
    expect(isComplete(m)).toBe(true);
    m[1][2] = NaN;
    expect(isComplete(m)).toBe(false);
  });

  it("ignores the diagonal, which is never driven", () => {
    const m = lineMatrix([0, 1, 2]);
    m[1][1] = NaN;
    expect(isComplete(m)).toBe(true);
  });
});
