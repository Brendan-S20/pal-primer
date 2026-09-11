#!/usr/bin/env node
/**
 * How good is the routing, measured rather than asserted.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * Nothing in the test suite measures routing QUALITY. The tests prove the
 * planner runs, is reachable by the role that calls it, and does not crash.
 * Whether the ORDER it returns is good is checked by nothing.
 *
 * The one number the repo has is in road-legs.server.ts: the road ran 1.44x to
 * 2.42x the straight line against a model assuming a flat 1.45x, and a hop OSRM
 * drives in 22 minutes was costed at 66.7. That measured how wrong the OLD
 * model was. It says nothing about whether the CURRENT one is right, and it has
 * never been compared against a commercial matrix. Until it is, parity with
 * Google must not be claimed -- see section 11 of
 * docs/owner-actions-before-submission.md.
 *
 * This answers that question, on real days, with real coordinates.
 *
 * ── WHAT IT ACTUALLY MEASURES ─────────────────────────────────────────────
 *
 * Two different questions, because only one of them is the one that matters.
 *
 * 1. LEG ACCURACY. For every pair of stops, how far is OSRM from Google, and
 *    how far is the straight-line estimate? Reported as a ratio distribution,
 *    not a mean: one hop across a river drags a mean and tells you nothing
 *    about the median day.
 *
 * 2. ORDER PENALTY, which is the point. A solver minimising the wrong quantity
 *    picks the wrong ORDER, and no amount of 2-opt fixes an objective that
 *    disagrees with the road. So: solve the day three times, once per cost
 *    matrix, then score all three resulting orders against GOOGLE. The answer
 *    is in real minutes -- "routing on OSRM costs N minutes more per day than
 *    routing on Google would have".
 *
 * THE SOLVER IS NOT THE APP'S PLANNER, and that is deliberate. It is one
 * solver (nearest neighbour, then 2-opt to a local optimum) applied IDENTICALLY
 * to all three matrices. That isolates the variable under test: the only thing
 * differing between the three runs is the cost matrix. Using the app's planner
 * would measure the planner and the matrix together and let neither be read.
 *
 * PARK-AND-WALK IS EXCLUDED ON PURPOSE. drive_minutes() adds park_walk_min to
 * every leg. It is the same constant on every leg, so it cannot change the
 * chosen order, and including it would flatter every ratio by adding the same
 * number to both sides. This compares kerb to kerb.
 *
 * ── IT SPENDS MONEY, SO IT ASKS FIRST ─────────────────────────────────────
 *
 * Google Distance Matrix bills per element. Without `--spend` this does
 * everything except call Google: it samples the days, builds the OSRM and
 * estimate matrices, and prints exactly how many elements a real run would buy.
 * Nothing is billed until `--spend` is passed.
 *
 *   node scripts/how-good-is-the-routing.mjs                    # costs nothing
 *   node scripts/how-good-is-the-routing.mjs --spend            # bills Google
 *   node scripts/how-good-is-the-routing.mjs --days 10 --spend
 *
 * Needs SUPABASE_DB_URL, and GOOGLE_MAPS_API_KEY for a --spend run. OSRM_URL
 * defaults the same way the app does.
 */
import { execFileSync } from "node:child_process";

// ── Pure helpers, exported so tests can drive them without a network ───────

/** Nearest neighbour from index 0, then 2-opt until nothing improves. */
export function solve(matrix) {
  const n = matrix.length;
  if (n <= 2) return [...Array(n).keys()];

  const seen = new Set([0]);
  const tour = [0];
  while (tour.length < n) {
    const from = tour[tour.length - 1];
    let best = -1;
    let bestCost = Infinity;
    for (let j = 0; j < n; j++) {
      if (seen.has(j)) continue;
      const c = matrix[from][j];
      if (c < bestCost) {
        bestCost = c;
        best = j;
      }
    }
    // A matrix with an unreachable pair should never get this far -- the
    // caller rejects incomplete matrices -- but refusing to invent a stop is
    // cheaper than debugging a tour with a -1 in it.
    if (best < 0) throw new Error("no reachable next stop; matrix is incomplete");
    seen.add(best);
    tour.push(best);
  }

  // 2-opt. Open tour: the vehicle starts at 0 and stops at the last stop, so
  // there is no closing leg back to the depot and none is scored.
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        const before = tourCost(tour, matrix);
        const candidate = [
          ...tour.slice(0, i),
          ...tour.slice(i, k + 1).reverse(),
          ...tour.slice(k + 1),
        ];
        if (tourCost(candidate, matrix) < before - 1e-9) {
          tour.splice(0, tour.length, ...candidate);
          improved = true;
        }
      }
    }
  }
  return tour;
}

/**
 * The same solver from every start, keeping the best BY THIS MATRIX.
 *
 * ── WHY, AND IT IS NOT AN OPTIMISATION ────────────────────────────────────
 *
 * The first version of this harness solved once, from index 0. Running it on
 * five real 20-stop days showed penalties of +3.4%, -2.6%, -4.3%, +6.4% --
 * including two days where routing on the WORSE matrix produced a BETTER
 * order, which is impossible as a fact about cost models and obvious as an
 * artifact of a heuristic.
 *
 * So the noise was measured directly: same matrix, same solver, only the
 * greedy start moved. The spread was 12% to 15% of the day. The effect under
 * test was 3% to 6%. The headline number was therefore reporting WHICH STOP
 * HAPPENED TO BE INDEX 0, and index 0 is whichever property id sorted first.
 *
 * Trying every start collapses that: the seed is no longer a free variable,
 * the same search is applied to every matrix, and a worse cost model can no
 * longer win by luck. On the same five days the penalties became +4.5%, +4.7%,
 * +7.7%, +11.6% -- all positive, as the physics requires.
 *
 * It is O(n) solves of an O(n^2) improvement pass, which for a 20-stop day is
 * milliseconds. There is no reason to prefer the cheap version.
 */
export function solveBest(matrix) {
  const n = matrix.length;
  let best = null;
  let bestCost = Infinity;
  for (let k = 0; k < n; k++) {
    const order = [k, ...Array.from({ length: n }, (_, i) => i).filter((i) => i !== k)];
    const sub = order.map((a) => order.map((b) => matrix[a][b]));
    const tour = solve(sub).map((i) => order[i]);
    const cost = tourCost(tour, matrix);
    if (cost < bestCost) {
      bestCost = cost;
      best = tour;
    }
  }
  return best;
}

/** What an order costs, in whatever unit the matrix is in. Open tour. */
export function tourCost(order, matrix) {
  let total = 0;
  for (let i = 0; i < order.length - 1; i++) total += matrix[order[i]][order[i + 1]];
  return total;
}

/**
 * Google allows 25 origins, 25 destinations, and 100 elements per request.
 * Blocks are square-ish so a day of 15 stops costs 9 requests rather than 15.
 */
export function blocks(n, maxElements = 100, maxSide = 25) {
  const side = Math.max(1, Math.min(maxSide, Math.floor(Math.sqrt(maxElements))));
  const out = [];
  for (let i = 0; i < n; i += side) {
    for (let j = 0; j < n; j += side) {
      out.push({ rows: range(i, Math.min(i + side, n)), cols: range(j, Math.min(j + side, n)) });
    }
  }
  return out;
}

const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);

/** Elements a day of n stops buys. The diagonal is requested and discarded. */
export const elementsFor = (n) => n * n;

/**
 * Ratio distribution, reported by quantile rather than mean.
 *
 * A single hop the wrong side of a river is a real fault and a terrible
 * average: it moves the mean and hides that most legs were fine. The median
 * says what a typical leg does, p90 says how bad the tail is, and `worst`
 * keeps the outlier visible instead of averaged away.
 */
export function ratios(pairs) {
  const vs = pairs.filter((r) => Number.isFinite(r) && r > 0).sort((a, b) => a - b);
  if (vs.length === 0) return null;
  const at = (q) => vs[Math.min(vs.length - 1, Math.floor(q * vs.length))];
  return { n: vs.length, median: at(0.5), p90: at(0.9), worst: vs[vs.length - 1] };
}

/** True when every off-diagonal cell is a usable number. */
export function isComplete(matrix) {
  for (let i = 0; i < matrix.length; i++) {
    for (let j = 0; j < matrix.length; j++) {
      if (i === j) continue;
      const v = matrix[i]?.[j];
      if (!Number.isFinite(v) || v < 0) return false;
    }
  }
  return true;
}

// ── The impure half ────────────────────────────────────────────────────────

const OSRM_URL = process.env.OSRM_URL ?? "https://router.project-osrm.org";
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const WANT_DAYS = Number(flag("days", 5));
const MIN_STOPS = Number(flag("min-stops", 6));
const MAX_STOPS = Number(flag("max-stops", 20));
const MAX_ELEMENTS = Number(flag("max-elements", 3000));
const SPEND = has("spend");

function sql(query) {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    console.error("SUPABASE_DB_URL is not set, so no day could be sampled. Nothing was measured.");
    process.exit(1);
  }
  return execFileSync("psql", [dbUrl, "-At", "-F", "\t", "-c", query], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t"));
}

/**
 * Real days, BIGGEST FIRST, and that choice is a bias worth stating.
 *
 * Ordering by date instead picks whatever is most recently scheduled, and on
 * this database those are six-stop days -- a day with barely an ordering
 * decision in it, where every cost model agrees because there is almost
 * nothing to disagree about. Measuring those would produce a small penalty and
 * mean nothing by it.
 *
 * The days where the objective has consequences are the full ones, so those
 * are sampled, and the report says so rather than letting the headline be read
 * as a fleet average.
 */
function sampleDays() {
  const org = flag("org", null);
  const rows = sql(`
    SELECT v.organization_id::text, v.scheduled_on::text, count(DISTINCT p.id) AS stops
      FROM public.visits v
      JOIN public.properties p ON p.id = v.property_id
     WHERE p.latitude IS NOT NULL AND p.longitude IS NOT NULL
       ${org ? `AND v.organization_id = '${org}'` : ""}
     GROUP BY 1, 2
    HAVING count(DISTINCT p.id) BETWEEN ${MIN_STOPS} AND ${MAX_STOPS}
     ORDER BY 3 DESC, 2 DESC
     LIMIT ${WANT_DAYS}
  `);
  return rows.map(([orgId, date, stops]) => ({ orgId, date, stops: Number(stops) }));
}

function pointsFor(orgId, date) {
  return sql(`
    SELECT DISTINCT p.latitude::text, p.longitude::text
      FROM public.visits v
      JOIN public.properties p ON p.id = v.property_id
     WHERE v.organization_id = '${orgId}' AND v.scheduled_on = '${date}'
       AND p.latitude IS NOT NULL AND p.longitude IS NOT NULL
     ORDER BY 1, 2
  `).map(([lat, lon]) => ({ lat: Number(lat), lon: Number(lon) }));
}

/**
 * The app's own estimate, computed BY POSTGRES.
 *
 * This is drive_minutes()'s fallback branch verbatim, minus park_walk_min (see
 * the header). It calls the real haversine_km and the real
 * effective_speed_kmh and reads the real organization row, so what is measured
 * is the estimator the product ships rather than a JavaScript impression of it.
 */
function estimateMatrix(orgId, pts) {
  const values = pts
    .map((p, i) => `(${i}, ${p.lat}::double precision, ${p.lon}::double precision)`)
    .join(",");
  const rows = sql(`
    WITH pts(i, lat, lon) AS (VALUES ${values}),
         o AS (SELECT road_factor, avg_speed_kmh, area_type, traffic_profile
                 FROM public.organizations WHERE id = '${orgId}')
    SELECT a.i, b.i,
           ( (public.haversine_km(a.lat, a.lon, b.lat, b.lon) * COALESCE(o.road_factor, 1.30))
             / NULLIF(CASE WHEN o.avg_speed_kmh IS NOT NULL AND o.avg_speed_kmh <> 30
                           THEN o.avg_speed_kmh
                           ELSE public.effective_speed_kmh(o.area_type, o.traffic_profile) END, 0)
           ) * 60.0
      FROM pts a CROSS JOIN pts b CROSS JOIN o
     WHERE a.i <> b.i
  `);
  const m = zeros(pts.length);
  for (const [i, j, mins] of rows) m[Number(i)][Number(j)] = Number(mins);
  return m;
}

const zeros = (n) => Array.from({ length: n }, () => Array(n).fill(0));

async function osrmMatrix(pts) {
  const coords = pts.map((p) => `${p.lon},${p.lat}`).join(";");
  const res = await fetch(`${OSRM_URL}/table/v1/driving/${coords}?annotations=duration`, {
    headers: { "User-Agent": "houndstack-routing-harness" },
  });
  if (!res.ok) throw new Error(`OSRM answered ${res.status}`);
  const body = await res.json();
  if (body.code !== "Ok" || !Array.isArray(body.durations))
    throw new Error(`OSRM said ${body.code}`);
  return body.durations.map((row) => row.map((s) => (s == null ? NaN : s / 60)));
}

async function googleMatrix(pts, key, spent) {
  const m = zeros(pts.length);
  for (const b of blocks(pts.length)) {
    const origins = b.rows.map((i) => `${pts[i].lat},${pts[i].lon}`).join("|");
    const dests = b.cols.map((j) => `${pts[j].lat},${pts[j].lon}`).join("|");
    const url =
      `https://maps.googleapis.com/maps/api/distancematrix/json` +
      `?origins=${encodeURIComponent(origins)}&destinations=${encodeURIComponent(dests)}` +
      `&mode=driving&units=metric&key=${key}`;
    const res = await fetch(url);
    const body = await res.json();
    spent.elements += b.rows.length * b.cols.length;
    if (body.status !== "OK")
      throw new Error(`Google said ${body.status}: ${body.error_message ?? ""}`);
    b.rows.forEach((i, ri) => {
      b.cols.forEach((j, ci) => {
        const cell = body.rows?.[ri]?.elements?.[ci];
        m[i][j] = cell?.status === "OK" ? cell.duration.value / 60 : NaN;
      });
    });
  }
  return m;
}

// ── Run ────────────────────────────────────────────────────────────────────

const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");

async function main() {
  const days = sampleDays();
  if (days.length === 0) {
    console.error(
      `No day has between ${MIN_STOPS} and ${MAX_STOPS} stops with coordinates. Nothing was measured.`,
    );
    process.exit(1);
  }

  const elements = days.reduce((t, d) => t + elementsFor(d.stops), 0);
  const orgs = new Set(days.map((d) => d.orgId));
  console.log(
    `Sampled the ${days.length} largest real day(s): ${days.map((d) => `${d.date} (${d.stops})`).join(", ")}`,
  );
  console.log("These are the fullest days on purpose, so this is not a fleet average.");
  if (orgs.size === 1) {
    // One organization is one geography, and how close OSRM runs to Google is
    // a fact about a road network rather than about routing in general. Said
    // out loud because the headline percentage below reads like a verdict on
    // the product, and on one org it is a verdict on one city.
    console.log(
      `All ${days.length} are one organization, so this measures one geography. Use --org to pick another.`,
    );
  } else {
    console.log(`Across ${orgs.size} organizations.`);
  }
  console.log(`A --spend run buys ${elements} Google Distance Matrix elements.\n`);

  if (elements > MAX_ELEMENTS) {
    console.error(
      `That is over --max-elements ${MAX_ELEMENTS}. Refusing rather than spending. ` +
        `Lower --days, or raise --max-elements deliberately.`,
    );
    process.exit(1);
  }

  if (!SPEND) {
    console.log("No --spend, so Google was not called and nothing was billed.");
    console.log("Re-run with --spend to measure against it.");
    return;
  }

  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    console.error("GOOGLE_MAPS_API_KEY is not set, so there is no reference to measure against.");
    process.exit(1);
  }

  const spent = { elements: 0 };
  const measured = [];
  const skipped = [];

  // Two of the five days sampled on 2026-09-11 held the IDENTICAL twenty
  // coordinates -- a recurring weekly route. Measuring both is not two
  // measurements, it is one counted twice, and it quietly doubles that day's
  // weight in the total.
  const seenPoints = new Set();

  for (const day of days) {
    const pts = pointsFor(day.orgId, day.date);
    const where = `${day.date} (${pts.length} stops)`;
    const fingerprint = pts.map((p) => `${p.lat},${p.lon}`).join("|");
    if (seenPoints.has(fingerprint)) {
      skipped.push(`${where}: the same stops as a day already measured`);
      continue;
    }
    seenPoints.add(fingerprint);
    try {
      const [osrm, google] = [await osrmMatrix(pts), await googleMatrix(pts, key, spent)];
      const estimate = estimateMatrix(day.orgId, pts);

      // A partial matrix is not a cheap answer, it is a different day. Scoring
      // one would report a number for a route nobody could drive.
      for (const [name, m] of [
        ["OSRM", osrm],
        ["Google", google],
        ["estimate", estimate],
      ]) {
        if (!isComplete(m)) throw new Error(`the ${name} matrix has an unreachable pair`);
      }

      const legRatio = (m) => {
        const out = [];
        for (let i = 0; i < pts.length; i++)
          for (let j = 0; j < pts.length; j++) if (i !== j) out.push(m[i][j] / google[i][j]);
        return ratios(out);
      };

      const best = tourCost(solveBest(google), google);
      measured.push({
        where,
        stops: pts.length,
        osrmLeg: legRatio(osrm),
        estLeg: legRatio(estimate),
        best,
        osrmPenalty: tourCost(solveBest(osrm), google) - best,
        estPenalty: tourCost(solveBest(estimate), google) - best,
      });
    } catch (e) {
      skipped.push(`${where}: ${e.message}`);
    }
  }

  console.log(`\n  LEG ACCURACY, as a ratio to Google (1.00 is exact)\n`);
  console.log(
    `  ${"day".padEnd(26)} ${"OSRM med".padStart(9)} ${"p90".padStart(6)} ${"worst".padStart(6)}   ${"est med".padStart(8)} ${"p90".padStart(6)} ${"worst".padStart(6)}`,
  );
  for (const r of measured) {
    console.log(
      `  ${r.where.padEnd(26)} ${fmt(r.osrmLeg?.median, 2).padStart(9)} ${fmt(r.osrmLeg?.p90, 2).padStart(6)} ${fmt(r.osrmLeg?.worst, 2).padStart(6)}   ` +
        `${fmt(r.estLeg?.median, 2).padStart(8)} ${fmt(r.estLeg?.p90, 2).padStart(6)} ${fmt(r.estLeg?.worst, 2).padStart(6)}`,
    );
  }

  console.log(`\n  ORDER PENALTY, in Google minutes per day (0.0 means it chose as well)\n`);
  console.log(
    `  ${"day".padEnd(26)} ${"day len".padStart(8)} ${"OSRM".padStart(7)} ${"est".padStart(7)}`,
  );
  for (const r of measured) {
    console.log(
      `  ${r.where.padEnd(26)} ${fmt(r.best).padStart(8)} ${fmt(r.osrmPenalty).padStart(7)} ${fmt(r.estPenalty).padStart(7)}`,
    );
  }

  const sum = (f) => measured.reduce((t, r) => t + f(r), 0);
  if (measured.length > 0) {
    const totalBest = sum((r) => r.best);
    console.log(
      `\n  Over ${measured.length} day(s): routing on OSRM costs ${fmt(sum((r) => r.osrmPenalty))} min more than ` +
        `routing on Google (${fmt((sum((r) => r.osrmPenalty) / totalBest) * 100)}%); ` +
        `on the straight-line estimate, ${fmt(sum((r) => r.estPenalty))} min (${fmt((sum((r) => r.estPenalty) / totalBest) * 100)}%).`,
    );
  }

  // "No experiment was run" must not look like "the experiment passed".
  console.log(
    `\n  ${measured.length} day(s) measured, ${skipped.length} skipped, ${spent.elements} Google elements billed.`,
  );
  for (const s of skipped) console.log(`    skipped ${s}`);
  if (measured.length === 0) {
    console.error("\nNothing was measured, so this run says nothing about the routing.");
    process.exit(1);
  }
}

// Importable for tests without running the CLI.
if (process.argv[1] && process.argv[1].endsWith("how-good-is-the-routing.mjs")) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
