/**
 * Pure measurements over a planned day. No database, no network.
 *
 * Everything the trials report about QUALITY is computed here, from the rows
 * the real planner wrote and the cost matrix it planned against, so the
 * arithmetic can be tested on its own and cannot quietly lean on the planner's
 * own opinion of itself.
 */

export type Matrix = number[][];

/** Cost of visiting `order` (indices into `m`) starting from `from`. Open path. */
export function pathCost(m: Matrix, from: number, order: number[]): number {
  let total = 0;
  let at = from;
  for (const i of order) {
    total += m[at][i];
    at = i;
  }
  return total;
}

/** Nearest neighbour from a fixed start: what a dispatcher does by eye. */
export function nearestNeighbour(m: Matrix, from: number, stops: number[]): number[] {
  const left = new Set(stops);
  const out: number[] = [];
  let at = from;
  while (left.size) {
    let best = -1;
    let bestCost = Infinity;
    for (const j of left) {
      if (m[at][j] < bestCost) {
        bestCost = m[at][j];
        best = j;
      }
    }
    out.push(best);
    left.delete(best);
    at = best;
  }
  return out;
}

/** 2-opt to a local optimum, from a fixed start, open path, asymmetric-safe. */
export function twoOpt(m: Matrix, from: number, order: number[]): number[] {
  let best = [...order];
  let bestCost = pathCost(m, from, best);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const cand = [...best.slice(0, i), ...best.slice(i, k + 1).reverse(), ...best.slice(k + 1)];
        const c = pathCost(m, from, cand);
        if (c < bestCost - 1e-9) {
          best = cand;
          bestCost = c;
          improved = true;
        }
      }
    }
  }
  return best;
}

/** A seeded shuffle, so a "best of N restarts" reference is the same every run. */
function shuffled<T>(xs: T[], seed: number): T[] {
  let a = seed >>> 0;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The best order this file can find for one truck's stops: NN then 2-opt,
 *  plus seeded random restarts. Not optimal; a fair "good" reference. */
export function goodOrder(m: Matrix, from: number, stops: number[], restarts = 6): number[] {
  let best = twoOpt(m, from, nearestNeighbour(m, from, stops));
  let bestCost = pathCost(m, from, best);
  for (let s = 1; s <= restarts && stops.length > 3; s++) {
    const o = twoOpt(m, from, shuffled(stops, s * 7919));
    const c = pathCost(m, from, o);
    if (c < bestCost - 1e-9) {
      best = o;
      bestCost = c;
    }
  }
  return best;
}

type XY = { x: number; y: number };

/** Equirectangular projection around a latitude, good enough to ask "do these
 *  two legs cross on the map". */
export function project(lat: number, lon: number, lat0: number): XY {
  return { x: lon * Math.cos((lat0 * Math.PI) / 180), y: lat };
}

function segmentsCross(a: XY, b: XY, c: XY, d: XY): boolean {
  const o = (p: XY, q: XY, r: XY) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(a, b, c);
  const d2 = o(a, b, d);
  const d3 = o(c, d, a);
  const d4 = o(c, d, b);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** How many times a route's drawn line crosses itself. A good open path on
 *  the plane crosses itself zero times; every crossing is a zig-zag a person
 *  looking at the map would undo by hand. (Road networks can force a few.) */
export function selfCrossings(points: Array<[number, number]>): number {
  if (points.length < 4) return 0;
  const lat0 = points.reduce((n, p) => n + p[0], 0) / points.length;
  const xy = points.map(([la, lo]) => project(la, lo, lat0));
  let n = 0;
  for (let i = 0; i < xy.length - 1; i++) {
    for (let j = i + 2; j < xy.length - 1; j++) {
      if (segmentsCross(xy[i], xy[i + 1], xy[j], xy[j + 1])) n++;
    }
  }
  return n;
}

/** Times a route changes side of a water barrier, against the fewest it could. */
export function sideChanges(sides: string[]): { changes: number; minimum: number } {
  let changes = 0;
  for (let i = 1; i < sides.length; i++) if (sides[i] !== sides[i - 1]) changes++;
  return { changes, minimum: Math.max(0, new Set(sides).size - 1) };
}

export function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371.0088;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a[0] * Math.PI) / 180) * Math.cos((b[0] * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Share of stops whose nearest other stop (straight line) belongs to a
 *  DIFFERENT truck. Near zero means tidy territories; high means the trucks'
 *  rounds are interleaved and both are driving through each other's streets. */
export function interleave(stops: Array<{ at: [number, number]; tech: string | null }>): number {
  const pts = stops.filter((s) => s.tech);
  if (pts.length < 2) return 0;
  let foreign = 0;
  for (const p of pts) {
    let best = Infinity;
    let owner: string | null = null;
    for (const q of pts) {
      if (q === p) continue;
      const d = haversineKm(p.at, q.at);
      if (d < best) {
        best = d;
        owner = q.tech;
      }
    }
    if (owner !== p.tech) foreign++;
  }
  return foreign / pts.length;
}

export const pct = (a: number, b: number) => (b > 0 ? ((a - b) / b) * 100 : 0);
