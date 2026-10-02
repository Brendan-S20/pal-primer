/**
 * Google as the referee: is HoundStack's route ORDER as good as an order built
 * on Google's drive times?
 *
 * For every truck in every trial scenario, three orders of the SAME stops from
 * the SAME start, all scored on Google's drive times:
 *
 *   planner    the order HoundStack's real planner wrote
 *   osrmBest   the best order found on the recorded OSRM (self-hosted router)
 *              times -- what the planner's data can at best produce
 *   googleBest the best order on Google's own times: EXACT (every order
 *              checked, Held-Karp) up to 12 stops, best-of-many-restarts above
 *
 * Two numbers answer the owner's question:
 *   planner vs googleBest   how much driving the shipped order costs over the
 *                           best order a Google-fed planner could pick
 *   osrmBest vs googleBest  how much of that is the ROAD DATA (OSRM vs Google)
 *                           rather than the solver
 *
 * Google's times come from a MatrixSource: either the key directly
 * (GOOGLE_MAPS_API_KEY) or the route-referee Edge Function that holds it in
 * Supabase (ROUTE_REFEREE_URL + ROUTE_REFEREE_TOKEN). Answers are cached in
 * .google-cache/ (git-ignored) only so a re-run during the same comparison
 * does not bill twice; delete the folder afterwards.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as M from "./metrics";
import type { TrialResult } from "./harness";

export type LatLon = [number, number];
/** Drive times in SECONDS, [from][to], null where Google has no route. */
export type MatrixSource = (points: LatLon[]) => Promise<(number | null)[][]>;

const CACHE_DIR = join(import.meta.dirname, ".google-cache");

/** Exact best open path from node 0 through every other node (Held-Karp).
 *  Exponential, so only for small days: n - 1 <= 12. */
export function exactOrder(m: M.Matrix): number[] {
  const n = m.length;
  const k = n - 1;
  if (k <= 0) return [];
  const FULL = 1 << k;
  const cost = new Float64Array(FULL * k).fill(Infinity);
  const prev = new Int16Array(FULL * k).fill(-1);
  for (let j = 0; j < k; j++) cost[(1 << j) * k + j] = m[0][j + 1];
  for (let mask = 1; mask < FULL; mask++) {
    for (let j = 0; j < k; j++) {
      if (!(mask & (1 << j))) continue;
      const c = cost[mask * k + j];
      if (c === Infinity) continue;
      for (let x = 0; x < k; x++) {
        if (mask & (1 << x)) continue;
        const nm = mask | (1 << x);
        const nc = c + m[j + 1][x + 1];
        if (nc < cost[nm * k + x]) {
          cost[nm * k + x] = nc;
          prev[nm * k + x] = j;
        }
      }
    }
  }
  let bestJ = 0;
  for (let j = 1; j < k; j++) {
    if (cost[(FULL - 1) * k + j] < cost[(FULL - 1) * k + bestJ]) bestJ = j;
  }
  const order: number[] = [];
  let mask = FULL - 1;
  let j = bestJ;
  while (j >= 0) {
    order.push(j + 1);
    const p = prev[mask * k + j];
    mask &= ~(1 << j);
    j = p;
  }
  return order.reverse();
}

/** The best order this file can find from node 0: exact when small enough. */
export function bestOrder(m: M.Matrix): number[] {
  const stops = [...Array(m.length - 1).keys()].map((i) => i + 1);
  if (stops.length <= 12) return exactOrder(m);
  return M.goodOrder(m, 0, stops, 40);
}

export type RefereeRow = {
  scenario: string;
  tech: string;
  stops: number;
  plannerMin: number;
  osrmBestMin: number | null;
  googleBestMin: number;
  exact: boolean;
};

function cached(source: MatrixSource): MatrixSource {
  return async (points) => {
    const key = createHash("sha256").update(JSON.stringify(points)).digest("hex").slice(0, 24);
    const file = join(CACHE_DIR, `${key}.json`);
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    const out = await source(points);
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(out));
    return out;
  };
}

/** Google's Distance Matrix with the key in this process's environment. */
export function directSource(key: string): MatrixSource {
  return async (points) => {
    const n = points.length;
    const out: (number | null)[][] = Array.from({ length: n }, () => Array(n).fill(null));
    const fmt = (p: LatLon) => `${p[0]},${p[1]}`;
    for (let oi = 0; oi < n; oi += 10) {
      for (let di = 0; di < n; di += 10) {
        const origins = points.slice(oi, oi + 10);
        const dests = points.slice(di, di + 10);
        const url =
          "https://maps.googleapis.com/maps/api/distancematrix/json?mode=driving&units=metric" +
          `&origins=${encodeURIComponent(origins.map(fmt).join("|"))}` +
          `&destinations=${encodeURIComponent(dests.map(fmt).join("|"))}&key=${key}`;
        const body = await (await fetch(url)).json();
        if (body.status !== "OK")
          throw new Error(`Google said ${body.status}: ${body.error_message ?? ""}`);
        body.rows.forEach(
          (row: { elements: Array<{ status: string; duration?: { value: number } }> }, r: number) =>
            row.elements.forEach((el, c) => {
              out[oi + r][di + c] = el.status === "OK" && el.duration ? el.duration.value : null;
            }),
        );
      }
    }
    return out;
  };
}

/** The route-referee Edge Function, which holds the key inside Supabase. */
export function functionSource(url: string, token: string): MatrixSource {
  return async (points) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-referee-token": token },
      body: JSON.stringify({ points }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`route-referee ${res.status}: ${JSON.stringify(body)}`);
    return body.durations;
  };
}

/** Whichever source the environment configures, cached; null when none is. */
export function sourceFromEnv(): MatrixSource | null {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (key) return cached(directSource(key));
  const url = process.env.ROUTE_REFEREE_URL;
  const token = process.env.ROUTE_REFEREE_TOKEN;
  if (url && token) return cached(functionSource(url, token));
  return null;
}

const same = (a: LatLon, b: LatLon) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

export async function referee(results: TrialResult[], source: MatrixSource): Promise<RefereeRow[]> {
  const rows: RefereeRow[] = [];
  for (const r of results) {
    for (const t of r.techs) {
      const route = t.route;
      if (!route?.start || route.planner.length < 2) continue;
      const points: LatLon[] = [route.start, ...route.planner];
      if (points.length > 25) continue; // one call's worth; the 200-stop day is not this question
      const secs = await source(points);
      if (secs.some((row) => row.some((v) => v == null))) continue; // Google could not route a leg
      // Minutes, with the planner's per-stop park-and-walk left out: it is the
      // same on every leg, so it cannot change which order wins.
      const G: M.Matrix = secs.map((row) => row.map((v) => (v as number) / 60));
      const plannerIdx = route.planner.map((_, i) => i + 1);
      const plannerMin = M.pathCost(G, 0, plannerIdx);
      const best = bestOrder(G);
      const googleBestMin = M.pathCost(G, 0, best);
      let osrmBestMin: number | null = null;
      if (route.osrmBest) {
        const idx = route.osrmBest.map((p) => points.findIndex((q, i) => i > 0 && same(p, q)));
        if (idx.every((i) => i > 0)) osrmBestMin = M.pathCost(G, 0, idx);
      }
      rows.push({
        scenario: r.sc.id,
        tech: t.name,
        stops: route.planner.length,
        plannerMin,
        osrmBestMin,
        googleBestMin,
        exact: route.planner.length <= 12,
      });
    }
  }
  return rows;
}

const pct = (a: number, b: number) => (b > 0 ? ((a - b) / b) * 100 : 0);

export function formatReferee(rows: RefereeRow[]): string {
  const lines = [
    "",
    "Google as referee: minutes of driving, every order scored on Google's times",
    "scenario            tech                 stops  planner  osrm-best  google-best  planner+%  data+%",
  ];
  let p = 0;
  let o = 0;
  let g = 0;
  for (const r of rows) {
    p += r.plannerMin;
    g += r.googleBestMin;
    o += r.osrmBestMin ?? r.plannerMin;
    lines.push(
      [
        r.scenario.padEnd(19),
        r.tech.slice(0, 20).padEnd(20),
        String(r.stops).padStart(5),
        r.plannerMin.toFixed(1).padStart(8),
        (r.osrmBestMin?.toFixed(1) ?? "-").padStart(10),
        (r.googleBestMin.toFixed(1) + (r.exact ? "" : "~")).padStart(12),
        pct(r.plannerMin, r.googleBestMin).toFixed(1).padStart(10),
        (r.osrmBestMin == null ? "-" : pct(r.osrmBestMin, r.googleBestMin).toFixed(1)).padStart(7),
      ].join(" "),
    );
  }
  lines.push(
    "",
    `All trucks: planner ${p.toFixed(1)} min vs Google-best ${g.toFixed(1)} min ` +
      `(+${pct(p, g).toFixed(1)}%); OSRM-best ${o.toFixed(1)} min (+${pct(o, g).toFixed(1)}%).`,
    "planner+% = extra driving in the shipped order; data+% = extra from using OSRM's times instead of Google's.",
    "~ = best of many restarts rather than exact (over 12 stops).",
    "",
  );
  return lines.join("\n");
}
