// The Google referee's "best order" has to BE the best order, or every gap it
// reports is measured against the wrong thing. Held-Karp is checked here
// against brute force on random asymmetric days, offline.

import { describe, expect, it } from "vitest";
import { bestOrder, exactOrder } from "../scripts/routing-trials/google-referee";
import { pathCost, type Matrix } from "../scripts/routing-trials/metrics";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

function randomDay(n: number, seed: number): Matrix {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : 1 + r() * 30)),
  );
}

function bruteForce(m: Matrix): number {
  const stops = [...Array(m.length - 1).keys()].map((i) => i + 1);
  let best = Infinity;
  const go = (left: number[], order: number[]) => {
    if (!left.length) {
      best = Math.min(best, pathCost(m, 0, order));
      return;
    }
    for (const s of left)
      go(
        left.filter((x) => x !== s),
        [...order, s],
      );
  };
  go(stops, []);
  return best;
}

describe("the referee's best order", () => {
  it("matches brute force on small asymmetric days", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const m = randomDay(2 + (seed % 7), seed); // 1 to 7 stops
      const order = exactOrder(m);
      expect(new Set(order).size).toBe(m.length - 1);
      expect(pathCost(m, 0, order)).toBeCloseTo(bruteForce(m), 9);
    }
  });

  it("is a permutation of every stop at the 12-stop limit and beyond", () => {
    for (const n of [13, 16]) {
      const order = bestOrder(randomDay(n, n));
      expect([...order].sort((a, b) => a - b)).toEqual([...Array(n - 1).keys()].map((i) => i + 1));
    }
  });
});
