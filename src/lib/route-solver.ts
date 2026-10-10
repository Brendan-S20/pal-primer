// The route solver: who drives to which stop, and in what order.
//
// ── WHY IT LIVES HERE AND NOT IN POSTGRES ────────────────────────────────
//
// Until 2026-10 the planner was plpgsql: a sweep by angle split the day into
// capacity-shaped arcs, nearest-neighbour ordered each arc, a 2-opt pass
// re-ordered it, and a balancer moved one stop at a time from the busiest
// truck to the idlest. Each candidate order was costed by a SQL function
// reading a temp table, so the 2-opt alone was O(n^3) statements. The routing
// trials (scripts/routing-trials) measured a 200-stop, six-truck Phoenix day at
// 7-23 seconds per call against the API's 8-second statement limit: refused,
// every time, for exactly the businesses big enough to need it most.
//
// So Postgres stays the source of truth for every INPUT -- the stops, the
// windows, who is routable today, where each truck starts and ends, the cached
// road legs and the measured road profile (route-inputs.ts turns those into a
// drive-minute matrix with drive_minutes' own arithmetic) -- and for the WRITE,
// which replays the clock in SQL exactly as before (apply_route_plan). Only the
// search in between moved, into this file: pure, synchronous, no I/O, seeded.
//
// ── WHAT IT DOES ─────────────────────────────────────────────────────────
//
//   1. Construction. Stops pinned to a technician go on their route first;
//      the rest are placed by REGRET insertion -- the stop whose second-best
//      truck is most worse than its best is placed first -- with each truck's
//      fair share of the day (by capacity) as a soft ceiling.
//   2. Local search. Within a route: 2-opt and Or-opt (a run of 1-3 stops
//      moved, either way round). Between routes, wherever a move would put a
//      stop next to one of its nearest neighbours: relocate a run of 1-3,
//      exchange runs of 1-2, and both 2-opt* reconnections (swap the tails).
//   3. Ruin and recreate. Pull out a cluster of neighbours, a run of
//      consecutive stops, or stops at random; re-place them by jittered
//      regret; local search again. A slightly worse day may be kept as the
//      next starting point early on (threshold accepting, cooling to "only
//      better"); the best day seen is kept apart. Repeated until the round
//      budget, the time budget, or a long run with no improvement.
//   4. Polish. Any truck with 12 stops or fewer gets the EXACT best order
//      (Held-Karp), open or closed to its end point as the model says; a
//      longer one is also re-ordered from scratch the SQL planner's way
//      (nearest neighbour, then the same 2-opt and Or-opt) and keeps
//      whichever is shorter.
//
// ── THE OBJECTIVE ────────────────────────────────────────────────────────
//
//   drive minutes (every leg, the leg home included when there is a home)
// + a balance term on each truck's SHARE OF ITS OWN CAPACITY -- the intent
//   #294 gave the SQL balancer, so a part-timer on 120 minutes is measured
//   against 120, not against a full-timer's 480: the spread between the
//   fullest and emptiest day, cheap within 10 minutes (the SQL balancer's own
//   target) and dear past it, plus a pull of every day towards the mean
// + minutes over capacity
// + when arrival windows are honoured, the morning/afternoon preferences.
//   Lateness is not a cost here: a route that reaches any stop after its
//   window is INFEASIBLE (see below). When windows are set aside nothing about
//   time is charged; the write still reports which windows the plan misses,
//   early or late.
//
// Within one route the order is chosen by that route's own cost alone, and a
// move between routes is judged only after both routes have been re-ordered
// that way. A spread rewards making the emptiest day fuller by ANY means --
// the first version of this search found one, a stop put badly into a
// part-timer's day, undone by 2-opt, redone by the next move, for 55 seconds.
//
// ── TWO HARD RULES (2026-10-10, appointment routing) ─────────────────────
//
// Until this, a window was a price: twenty thousand minutes' driving for each
// customer reached late, so the search avoided it whenever it could and
// "shared" one impossible window by planning it late and flagging it. A walk
// booked for 11:00-13:00 cannot be done at 13:40 and flagged; the owner's
// words were "windows are always honoured". So:
//
//   * With windows honoured, a route on which any stop arrives after its
//     latest time has an INFINITE objective. Nothing inserts a stop where it
//     would be late, no move makes a stop late, and a stop that cannot be
//     placed inside its window on any technician is left out and returned in
//     `unassigned` with the reason "window". It is never silently late and
//     never silently dropped: the caller names it to the dispatcher.
//
//   * A stop may say which technicians can do it (`eligibleTechs`, from the
//     technician's service skills). The search never puts it anywhere else,
//     and a stop nobody on the run can do comes back as "no_eligible_tech".
//     `null` means anybody -- what every stop says when a business has set no
//     skills, so a pet-waste org that never opens the skills screen routes
//     exactly as before.
//
// The search keeps the number of unplaced stops as its first objective and
// the cost above as its second: a round that places one more stop is kept
// whatever it costs in driving, and a round that loses one is never kept.

// ── DETERMINISM ──────────────────────────────────────────────────────────
//
// Every choice is a pure function of the input and the seed. The one thing
// that is not is the wall clock: a day big enough to hit `timeLimitMs` before
// `rounds` stops wherever the clock says, which on a slower machine is
// earlier. Tests pass `rounds` and a generous time limit, and get the same
// answer every run.

export type SolverStop = {
  /** Minutes on site. */
  service: number;
  /** Arrival window, in minutes after the workday start. Null = none. */
  earliest: number | null;
  latest: number | null;
  pref: "morning" | "afternoon" | null;
  /** Index of the technician this stop must stay with, or null. */
  fixedTech: number | null;
  /** Technicians who can do this stop's service; null (or absent) = anyone.
   *  An empty list means nobody on the run can, and the stop comes back
   *  unassigned. */
  eligibleTechs?: number[] | null;
};

export type UnassignedReason = "no_eligible_tech" | "window";

export type UnassignedStop = { stop: number; reason: UnassignedReason };

export type SolverTech = {
  /** Node the day starts from; null = the first leg costs nothing. */
  start: number | null;
  /** Node the day ends at; null = an open path. */
  end: number | null;
  /** daily_capacity_minutes. */
  capacity: number;
};

export type SolverProblem = {
  /** Nodes in the matrix. Stop i is node i; starts and ends come after. */
  size: number;
  /** Drive minutes, row-major: matrix[from * size + to]. */
  matrix: Float64Array;
  stops: SolverStop[];
  techs: SolverTech[];
  honourWindows: boolean;
  /** Minutes after the workday start at which it is local noon. */
  noon: number;
};

export type SolverOptions = {
  seed?: number;
  /** Ruin-and-recreate rounds after the first local search. */
  rounds?: number;
  /** Wall-clock cap, best-so-far is returned when it is reached. */
  timeLimitMs?: number;
  /** Stop early after this many rounds without improvement. */
  patience?: number;
  now?: () => number;
};

export type RouteCost = {
  drive: number;
  service: number;
  wait: number;
  /** Minutes late, summed, and how many stops were late. */
  late: number;
  lateStops: number;
  /** Morning/afternoon preferences not met. */
  prefMisses: number;
  /** drive + service: the work in the day, what capacity is measured against
   *  (route-day-fit.ts plans the same sum). Waiting for a window is not work:
   *  counting it would call a truck idle till 3 PM "fully loaded" and stop the
   *  balancer filling its morning. */
  load: number;
};

export type Solution = {
  routes: number[][];
  costs: RouteCost[];
  /** The cost of the routes returned (driving, balance, capacity,
   *  preferences). Stops in `unassigned` are not in it. */
  objective: number;
  /** Stops on no route, each with the reason, by stop index. */
  unassigned: UnassignedStop[];
  rounds: number;
  stoppedBy: "rounds" | "time" | "patience";
  ms: number;
};

// ── Weights ────────────────────────────────────────────────────────────────

/** There is no weight for lateness. With windows honoured a late arrival is
 *  not a cost but an impossibility (routeObjective returns Infinity), and
 *  with them set aside it is not charged at all. Until 2026-10-10 a late stop
 *  cost 20,000 and each late minute 50, which planned the impossible window
 *  late and flagged it. */
/** A morning/afternoon preference not met: what the SQL planner charged. */
export const W_PREF = 15;
/** Each minute a day runs over the person's capacity. */
export const W_CAP = 2;
/** Spread between the fullest and the emptiest day (in minutes of a
 *  480-minute day) that costs little; beyond it each minute costs
 *  BAL_OVER more. The SQL balancer's own stopping rule was "within 10". */
export const BAL_TOLERANCE = 10;
export const BAL_RANGE = 0.5;
export const BAL_OVER = 2;
/** And a gentle pull of every day towards the mean, so that with six trucks
 *  the four in the middle are balanced too, not only the two at the ends. */
export const BAL_SPREAD = 1 / 60;

const EPS = 1e-7;

// ── Small pure helpers ─────────────────────────────────────────────────────

/** mulberry32, the PRNG the trials already use for their generated day. */
export function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Whether arrival times can change the cost of a route at all. When they
 *  cannot, every move can be priced in O(1) from prefix sums. */
export function timelineMatters(p: SolverProblem): boolean {
  return (
    p.honourWindows && p.stops.some((s) => s.earliest != null || s.latest != null || s.pref != null)
  );
}

/**
 * One route, driven: drive, service, waiting and lateness, the clock advanced
 * exactly as apply_route_plan advances it (each leg rounded to a whole minute,
 * a wait for an earliest time only when windows are honoured).
 */
export function evaluateRoute(
  p: SolverProblem,
  t: number,
  route: ArrayLike<number>,
  len: number = route.length,
): RouteCost {
  const tech = p.techs[t];
  const N = p.size;
  const m = p.matrix;
  const timeline = p.honourWindows;
  let prev = tech.start ?? -1;
  let drive = 0;
  let service = 0;
  let wait = 0;
  let late = 0;
  let lateStops = 0;
  let prefMisses = 0;
  let clock = 0;
  for (let k = 0; k < len; k++) {
    const s = route[k];
    const leg = prev < 0 ? 0 : m[prev * N + s];
    drive += leg;
    const st = p.stops[s];
    if (timeline) {
      clock += Math.round(leg);
      if (st.earliest != null && clock < st.earliest) {
        wait += st.earliest - clock;
        clock = st.earliest;
      }
      if (st.latest != null && clock > st.latest) {
        late += clock - st.latest;
        lateStops++;
      }
      if (st.pref === "morning" && clock >= p.noon) prefMisses++;
      else if (st.pref === "afternoon" && clock < p.noon) prefMisses++;
      clock += st.service;
    }
    service += st.service;
    prev = s;
  }
  if (len > 0 && tech.end != null) drive += m[prev * N + tech.end];
  return { drive, service, wait, late, lateStops, prefMisses, load: drive + service };
}

/** The part of the objective that belongs to one route (everything but
 *  balance). Infinity when windows are honoured and the route reaches a stop
 *  late: such a route is not a worse plan, it is not a plan. */
export function routeObjective(p: SolverProblem, t: number, c: RouteCost): number {
  if (p.honourWindows && c.lateStops > 0) return Infinity;
  let v = c.drive + W_CAP * Math.max(0, c.load - p.techs[t].capacity);
  if (p.honourWindows) v += W_PREF * c.prefMisses;
  return v;
}

/** Which technicians stop s may be given to: its own service skills and its
 *  pin, folded into one row of a stops x techs table. */
export function allowedTechs(p: SolverProblem): Uint8Array {
  const K = p.techs.length;
  const allow = new Uint8Array(p.stops.length * K);
  p.stops.forEach((s, i) => {
    const el = s.eligibleTechs == null ? null : new Set(s.eligibleTechs);
    for (let t = 0; t < K; t++) {
      const ok = (s.fixedTech == null || s.fixedTech === t) && (el == null || el.has(t));
      allow[i * K + t] = ok ? 1 : 0;
    }
  });
  return allow;
}

/**
 * The balance term, over each technician's load as a SHARE OF THEIR OWN
 * CAPACITY -- the intent #294 gave the SQL balancer, so a 120-minute
 * part-timer is measured against 120, not against a full-timer's 480 --
 * expressed in minutes of a 480-minute day: the spread between the fullest
 * and the emptiest day, cheap up to BAL_TOLERANCE and dear past it, plus the
 * squared distance of every day from the mean.
 *
 * A spread rewards making the emptiest day FULLER by any means, including
 * driving it in a worse order. The search cannot do that: a move between
 * routes is judged only after both routes have been re-ordered for their own
 * driving (see tryMove), so padding a day is undone before it is scored.
 */
export function balanceCost(loads: ArrayLike<number>, caps: ArrayLike<number>): number {
  const K = loads.length;
  if (K < 2) return 0;
  let lo = Infinity;
  let hi = -Infinity;
  let sum = 0;
  for (let k = 0; k < K; k++) {
    const x = (loads[k] / Math.max(caps[k], 1)) * 480;
    if (x < lo) lo = x;
    if (x > hi) hi = x;
    sum += x;
  }
  const mean = sum / K;
  let sq = 0;
  for (let k = 0; k < K; k++) {
    const d = (loads[k] / Math.max(caps[k], 1)) * 480 - mean;
    sq += d * d;
  }
  const range = hi - lo;
  return BAL_RANGE * range + BAL_OVER * Math.max(0, range - BAL_TOLERANCE) + BAL_SPREAD * sq;
}

/** The whole objective for a set of routes. */
export function objective(p: SolverProblem, routes: number[][]): number {
  const caps = p.techs.map((t) => t.capacity);
  let v = 0;
  const loads: number[] = [];
  routes.forEach((r, t) => {
    const c = evaluateRoute(p, t, r);
    v += routeObjective(p, t, c);
    loads.push(c.load);
  });
  return v + balanceCost(loads, caps);
}

// ── Held-Karp: the exact order for a small route ──────────────────────────

/**
 * The exact cheapest order of `stops` from `start` (null = free first leg),
 * closing to `end` when there is one. Exponential: for 12 stops or fewer.
 */
export function exactOrder(
  m: Float64Array,
  N: number,
  start: number | null,
  end: number | null,
  stops: number[],
): number[] {
  const k = stops.length;
  if (k <= 1) return [...stops];
  if (k > 12) throw new Error("exactOrder is for 12 stops or fewer");
  const FULL = 1 << k;
  const cost = new Float64Array(FULL * k).fill(Infinity);
  const prev = new Int8Array(FULL * k).fill(-1);
  for (let j = 0; j < k; j++) {
    cost[(1 << j) * k + j] = start == null ? 0 : m[start * N + stops[j]];
  }
  for (let mask = 1; mask < FULL; mask++) {
    for (let j = 0; j < k; j++) {
      if (!(mask & (1 << j))) continue;
      const c = cost[mask * k + j];
      if (c === Infinity) continue;
      const from = stops[j] * N;
      for (let x = 0; x < k; x++) {
        if (mask & (1 << x)) continue;
        const nm = mask | (1 << x);
        const nc = c + m[from + stops[x]];
        if (nc < cost[nm * k + x] - 1e-12) {
          cost[nm * k + x] = nc;
          prev[nm * k + x] = j;
        }
      }
    }
  }
  let bestJ = 0;
  let best = Infinity;
  for (let j = 0; j < k; j++) {
    const c = cost[(FULL - 1) * k + j] + (end == null ? 0 : m[stops[j] * N + end]);
    if (c < best - 1e-12) {
      best = c;
      bestJ = j;
    }
  }
  const order: number[] = [];
  let mask = FULL - 1;
  let j = bestJ;
  while (j >= 0) {
    order.push(stops[j]);
    const pj = prev[mask * k + j];
    mask &= ~(1 << j);
    j = pj;
  }
  return order.reverse();
}

// ── The search state ───────────────────────────────────────────────────────

/** A route described as runs of existing routes: each run is positions
 *  i..j inclusive of route t (empty when i > j), maybe reversed. Packed four
 *  ints a run into a reused buffer, because the search builds one of these
 *  for every candidate move and a 200-stop day tries millions. */
class Pieces {
  buf = new Int32Array(32);
  n = 0;
  reset(): this {
    this.n = 0;
    return this;
  }
  add(t: number, i: number, j: number, rev = false): this {
    const k = this.n * 4;
    this.buf[k] = t;
    this.buf[k + 1] = i;
    this.buf[k + 2] = j;
    this.buf[k + 3] = rev ? 1 : 0;
    this.n++;
    return this;
  }
}
const PA = new Pieces();
const PB = new Pieces();
const PI = new Pieces();

class State {
  readonly p: SolverProblem;
  readonly N: number;
  readonly m: Float64Array;
  readonly K: number;
  readonly caps: number[];
  readonly timeline: boolean;
  routes: number[][];
  costs: RouteCost[] = [];
  robj: number[] = [];
  loads: number[] = [];
  /** Per route: prefix of forward legs, backward legs, service. */
  F: Float64Array[] = [];
  B: Float64Array[] = [];
  S: Float64Array[] = [];
  /** Per route t and destination u: prefix count of stops on t that may NOT
   *  be given to u (pinned to t, or u lacks the skill). A run with a count
   *  of zero can move to u whole. */
  X: Int32Array[][] = [];
  /** allow[s * K + t]: stop s may be on technician t. */
  readonly allow: Uint8Array;
  /** Which route each stop is on (-1 = none yet), and where in it. */
  where: Int32Array;
  at: Int32Array;
  /** How many stops are on some route. */
  placed = 0;

  constructor(p: SolverProblem, routes: number[][]) {
    this.p = p;
    this.N = p.size;
    this.m = p.matrix;
    this.K = p.techs.length;
    this.caps = p.techs.map((t) => t.capacity);
    this.timeline = timelineMatters(p);
    this.allow = allowedTechs(p);
    this.routes = routes.map((r) => [...r]);
    this.where = new Int32Array(p.stops.length).fill(-1);
    this.at = new Int32Array(p.stops.length).fill(-1);
    const initial = this.routes;
    this.routes = initial.map(() => []);
    for (let t = 0; t < this.K; t++) this.setRoute(t, initial[t]);
  }

  clone(): number[][] {
    return this.routes.map((r) => [...r]);
  }

  /** Stops on no route. */
  unplaced(): number {
    return this.p.stops.length - this.placed;
  }

  refresh(t: number) {
    const r = this.routes[t];
    const n = r.length;
    const K = this.K;
    const F = new Float64Array(Math.max(n, 1));
    const B = new Float64Array(Math.max(n, 1));
    const S = new Float64Array(n + 1);
    const X: Int32Array[] = [];
    for (let u = 0; u < K; u++) X.push(new Int32Array(n + 1));
    const N = this.N;
    const m = this.m;
    const allow = this.allow;
    for (let k = 0; k < n; k++) {
      if (k > 0) {
        F[k] = F[k - 1] + m[r[k - 1] * N + r[k]];
        B[k] = B[k - 1] + m[r[k] * N + r[k - 1]];
      }
      const st = this.p.stops[r[k]];
      S[k + 1] = S[k] + st.service;
      const row = r[k] * K;
      for (let u = 0; u < K; u++) X[u][k + 1] = X[u][k] + (allow[row + u] ? 0 : 1);
    }
    this.F[t] = F;
    this.B[t] = B;
    this.S[t] = S;
    this.X[t] = X;
    const c = evaluateRoute(this.p, t, r);
    this.costs[t] = c;
    this.robj[t] = routeObjective(this.p, t, c);
    this.loads[t] = c.load;
  }

  total(): number {
    let v = 0;
    for (let t = 0; t < this.K; t++) v += this.robj[t];
    return v + balanceCost(this.loads, this.caps);
  }

  setRoute(t: number, r: number[]) {
    for (const s of this.routes[t]) {
      if (this.where[s] === t) {
        this.where[s] = -1;
        this.placed--;
      }
    }
    this.routes[t] = r;
    r.forEach((s, k) => {
      if (this.where[s] < 0) this.placed++;
      this.where[s] = t;
      this.at[s] = k;
    });
    this.refresh(t);
  }

  // ── O(1) pricing from pieces ──

  private c(a: number, b: number): number {
    return a < 0 || b < 0 ? 0 : this.m[a * this.N + b];
  }

  /** Drive and service of the route owned by `owner` built from `pcs`, into
   *  this.pDrive / this.pService. Allocation-free: this runs millions of
   *  times on a big day. */
  pDrive = 0;
  pService = 0;
  price(owner: number, pcs: Pieces) {
    const tech = this.p.techs[owner];
    const buf = pcs.buf;
    let prev = tech.start ?? -1;
    let drive = 0;
    let service = 0;
    let n = 0;
    for (let k = 0; k < pcs.n; k++) {
      const t = buf[k * 4];
      const i = buf[k * 4 + 1];
      const j = buf[k * 4 + 2];
      if (i > j) continue;
      const rev = buf[k * 4 + 3] === 1;
      const r = this.routes[t];
      const first = rev ? r[j] : r[i];
      drive += this.c(prev, first);
      drive += rev ? this.B[t][j] - this.B[t][i] : this.F[t][j] - this.F[t][i];
      service += this.S[t][j + 1] - this.S[t][i];
      n += j - i + 1;
      prev = rev ? r[i] : r[j];
    }
    if (n === 0) {
      this.pDrive = 0;
      this.pService = 0;
      return;
    }
    if (tech.end != null) drive += this.c(prev, tech.end);
    this.pDrive = drive;
    this.pService = service;
  }

  materialize(pcs: Pieces): number[] {
    const out: number[] = [];
    const buf = pcs.buf;
    for (let k = 0; k < pcs.n; k++) {
      const t = buf[k * 4];
      const i = buf[k * 4 + 1];
      const j = buf[k * 4 + 2];
      const r = this.routes[t];
      if (buf[k * 4 + 3] === 1) for (let x = j; x >= i; x--) out.push(r[x]);
      else for (let x = i; x <= j; x++) out.push(r[x]);
    }
    return out;
  }

  /** Whether any stop in positions i..j of route t may not be given to u. */
  blocked(t: number, i: number, j: number, u: number): boolean {
    if (i > j) return false;
    const x = this.X[t][u];
    return x[j + 1] - x[i] > 0;
  }

  /** Objective and load of one route rebuilt from pieces, into this.vObj /
   *  this.vLoad, building it (this.vBuilt) only when arrival times matter. */
  vObj = 0;
  vLoad = 0;
  vBuilt: number[] | null = null;
  routeValue(owner: number, pcs: Pieces) {
    if (!this.timeline) {
      this.price(owner, pcs);
      const load = this.pDrive + this.pService;
      this.vObj = this.pDrive + W_CAP * Math.max(0, load - this.caps[owner]);
      this.vLoad = load;
      this.vBuilt = null;
      return;
    }
    const r = this.materialize(pcs);
    const c = evaluateRoute(this.p, owner, r);
    this.vObj = routeObjective(this.p, owner, c);
    this.vLoad = c.load;
    this.vBuilt = r;
  }

  balanceWith(a: number, la: number, b: number, lb: number): number {
    const saveA = this.loads[a];
    const saveB = this.loads[b];
    this.loads[a] = la;
    if (b >= 0) this.loads[b] = lb;
    const v = balanceCost(this.loads, this.caps);
    this.loads[a] = saveA;
    if (b >= 0) this.loads[b] = saveB;
    return v;
  }
}

// ── Insertion (construction and recreate) ─────────────────────────────────

function insertionCost(
  st: State,
  t: number,
  s: number,
  target: number[],
  noise: (() => number) | null = null,
): { cost: number; pos: number } {
  const r = st.routes[t];
  const n = r.length;
  const p = st.p;
  const tech = p.techs[t];
  const svc = p.stops[s].service;
  const m = st.m;
  const N = st.N;
  const c = (a: number, b: number) => (a < 0 || b < 0 ? 0 : m[a * N + b]);
  const over = (l: number) => Math.max(0, l - target[t]);
  let best = Infinity;
  let pos = 0;
  // Every position, timed, whenever the clock matters: a window is a hard
  // rule now, and the O(1) estimate below cannot see one. (Until 2026-10-10
  // routes past 60 stops fell through to the estimate; a 200-stop
  // single-truck day with windows now costs a few hundred thousand route
  // evaluations in construction, well inside the budget.)
  if (st.timeline) {
    const base = st.robj[t];
    const tmp = new Array<number>(n + 1);
    for (let j = 0; j <= n; j++) {
      for (let k = 0, w = 0; k <= n; k++) tmp[k] = k === j ? s : r[w++];
      const cc = evaluateRoute(p, t, tmp);
      let v = routeObjective(p, t, cc) - base + 1.5 * (over(cc.load) - over(st.loads[t]));
      if (noise) v *= noise();
      if (v < best - EPS) {
        best = v;
        pos = j;
      }
    }
    return { cost: best, pos };
  }
  const start = tech.start ?? -1;
  const end = tech.end ?? -1;
  for (let j = 0; j <= n; j++) {
    const a = j === 0 ? start : r[j - 1];
    const b = j === n ? end : r[j];
    let d: number;
    if (n === 0) d = c(start, s) + c(s, end);
    else d = c(a, s) + c(s, b) - c(a, b);
    if (noise) d *= noise();
    if (d < best - EPS) {
      best = d;
      pos = j;
    }
  }
  const newLoad = st.loads[t] + best + svc;
  const cap = st.caps[t];
  const capPen = W_CAP * (Math.max(0, newLoad - cap) - Math.max(0, st.loads[t] - cap));
  return { cost: best + capPen + 1.5 * (over(newLoad) - over(st.loads[t])), pos };
}

/** Regret-2 insertion of `pending` into the current routes. */
function regretInsert(
  st: State,
  pending: number[],
  target: number[],
  noise: (() => number) | null = null,
) {
  const K = st.K;
  const left = new Set(pending);
  // best[s][t] cached; recomputed for one route after each insertion.
  const cost = new Map<number, Float64Array>();
  const pos = new Map<number, Int32Array>();
  const allowed = (s: number, t: number) => st.allow[s * K + t] === 1;
  const fill = (s: number, t: number) => {
    if (!allowed(s, t)) {
      cost.get(s)![t] = Infinity;
      return;
    }
    const r = insertionCost(st, t, s, target, noise);
    cost.get(s)![t] = r.cost;
    pos.get(s)![t] = r.pos;
  };
  for (const s of left) {
    cost.set(s, new Float64Array(K));
    pos.set(s, new Int32Array(K));
    for (let t = 0; t < K; t++) fill(s, t);
  }
  while (left.size) {
    let pick = -1;
    let pickT = -1;
    let pickRegret = -Infinity;
    let pickBest = Infinity;
    for (const s of left) {
      const cs = cost.get(s)!;
      let b1 = Infinity;
      let b2 = Infinity;
      let t1 = -1;
      for (let t = 0; t < K; t++) {
        const v = cs[t];
        if (v < b1 - EPS) {
          b2 = b1;
          b1 = v;
          t1 = t;
        } else if (v < b2 - EPS) b2 = v;
      }
      if (t1 < 0) continue;
      // A stop with one possible truck goes first: nothing else can take it.
      const regret = b2 === Infinity ? 1e9 : b2 - b1;
      if (
        regret > pickRegret + EPS ||
        (Math.abs(regret - pickRegret) <= EPS && b1 < pickBest - EPS)
      ) {
        pick = s;
        pickT = t1;
        pickRegret = regret;
        pickBest = b1;
      }
    }
    if (pick < 0) break;
    const r = st.routes[pickT];
    const at = pos.get(pick)![pickT];
    st.setRoute(pickT, [...r.slice(0, at), pick, ...r.slice(at)]);
    left.delete(pick);
    cost.delete(pick);
    for (const s of left) fill(s, pickT);
  }
}

/** Each technician's fair share of `total`, by capacity. */
function targets(st: State, total: number): number[] {
  const sum = st.caps.reduce((a, b) => a + b, 0) || 1;
  return st.caps.map((c) => (total * c) / sum);
}

/** A rough lower estimate of the whole day's load: service plus each stop's
 *  cheapest way in. Used only to size the shares construction aims at. */
function estimateTotal(p: SolverProblem): number {
  const N = p.size;
  let total = 0;
  const nodes = new Set<number>();
  p.stops.forEach((_, i) => nodes.add(i));
  for (const t of p.techs) if (t.start != null) nodes.add(t.start);
  for (let s = 0; s < p.stops.length; s++) {
    total += p.stops[s].service;
    let best = Infinity;
    for (const a of nodes) {
      if (a === s) continue;
      const v = p.matrix[a * N + s];
      if (v < best) best = v;
    }
    if (Number.isFinite(best)) total += best;
  }
  return total;
}

// ── Local search ──────────────────────────────────────────────────────────

/** Improve one route's order by its own cost: 2-opt and Or-opt. */
function intraRoute(st: State, t: number): boolean {
  let any = false;
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 200) {
    improved = false;
    const n = st.routes[t].length;
    if (n < 2) return any;
    const base = st.robj[t];
    // 2-opt: reverse i..k.
    for (let i = 0; i < n - 1 && !improved; i++) {
      for (let k = i + 1; k < n; k++) {
        PI.reset()
          .add(t, 0, i - 1)
          .add(t, i, k, true)
          .add(t, k + 1, n - 1);
        st.routeValue(t, PI);
        if (st.vObj < base - EPS) {
          st.setRoute(t, st.vBuilt ?? st.materialize(PI));
          improved = any = true;
          break;
        }
      }
    }
    if (improved) continue;
    // Or-opt: move a run of 1-3 to another place in the route, either way round.
    for (let L = 1; L <= 3 && !improved; L++) {
      for (let i = 0; i + L <= n && !improved; i++) {
        const segEnd = i + L - 1;
        for (let j = -1; j < n && !improved; j++) {
          if (j >= i - 1 && j <= segEnd) continue;
          for (const rev of L > 1 ? [false, true] : [false]) {
            if (j < i) {
              PI.reset()
                .add(t, 0, j)
                .add(t, i, segEnd, rev)
                .add(t, j + 1, i - 1);
              PI.add(t, segEnd + 1, n - 1);
            } else {
              PI.reset()
                .add(t, 0, i - 1)
                .add(t, segEnd + 1, j)
                .add(t, i, segEnd, rev);
              PI.add(t, j + 1, n - 1);
            }
            st.routeValue(t, PI);
            if (st.vObj < base - EPS) {
              st.setRoute(t, st.vBuilt ?? st.materialize(PI));
              improved = any = true;
              break;
            }
          }
        }
      }
    }
    // Reversing a segment of length 2-3 in place is 2-opt; covered above.
  }
  return any;
}

/** The smallest improvement worth a move. The balance term has a gradient
 *  everywhere, so without a floor the search spends its budget on changes
 *  worth a thousandth of a minute. */
const MIN_GAIN = 0.01;

/** Each stop's nearest few others, by the round trip between them. Moves
 *  between routes are only tried where they would put a stop next to one of
 *  these: the granular neighbourhood every serious VRP heuristic uses, and
 *  what keeps a 200-stop day's search linear in the stops rather than square. */
type Neighbours = { near: Int32Array[]; nearStart: Array<Set<number>> };

function neighbours(p: SolverProblem): Neighbours {
  const n = p.stops.length;
  // A small day can afford every pair; a big one keeps its nearest fifteen.
  const k = n <= 60 ? n - 1 : 15;
  const N = p.size;
  const m = p.matrix;
  const near: Int32Array[] = [];
  const idx = [...Array(n).keys()];
  for (let s = 0; s < n; s++) {
    const sorted = idx
      .filter((x) => x !== s)
      .sort((a, b) => m[s * N + a] + m[a * N + s] - (m[s * N + b] + m[b * N + s]) || a - b);
    near.push(Int32Array.from(sorted.slice(0, k)));
  }
  const nearStart = p.techs.map((t) => {
    if (t.start == null) return new Set(idx);
    const st = t.start;
    return new Set(
      [...idx].sort((a, b) => m[st * N + a] - m[st * N + b] || a - b).slice(0, Math.max(k, 3)),
    );
  });
  return { near, nearStart };
}

/** Apply PA on route a and PB on route b if together they lower the whole
 *  objective. */
function tryMove(st: State, a: number, b: number): boolean {
  let others = 0;
  for (let t = 0; t < st.K; t++) if (t !== a && t !== b) others += st.robj[t];
  const before = others + st.robj[a] + st.robj[b] + balanceCost(st.loads, st.caps);
  st.routeValue(a, PA);
  const va = st.vObj;
  const la = st.vLoad;
  const builtA = st.vBuilt;
  st.routeValue(b, PB);
  const vb = st.vObj;
  const lb = st.vLoad;
  const builtB = st.vBuilt;
  // A cheap bound first: balance can only fall to zero.
  if (others + va + vb >= before - MIN_GAIN) return false;
  const after = others + va + vb + st.balanceWith(a, la, b, lb);
  if (after >= before - MIN_GAIN) return false;
  const oldA = st.routes[a];
  const oldB = st.routes[b];
  // Both built before either is written: each may read the other's route.
  const newA = builtA ?? st.materialize(PA);
  const newB = builtB ?? st.materialize(PB);
  st.setRoute(a, newA);
  st.setRoute(b, newB);
  // Judged as the two days will actually be driven: each re-ordered for its
  // own driving first. Without this a move could "balance" the day by
  // putting a stop in a bad place on the emptier route -- cheaper on paper,
  // undone by that route's next 2-opt, and found again by the next sweep.
  intraRoute(st, a);
  intraRoute(st, b);
  if (st.total() < before - MIN_GAIN) return true;
  st.setRoute(a, oldA);
  st.setRoute(b, oldB);
  return false;
}

/**
 * Every between-routes move that would put stop s (route A, position i) next
 * to stop v (route B, position j): relocate a run of 1-3 beside v, either way
 * round; exchange runs of 1-2 so that s lands beside v; and both 2-opt*
 * reconnections through the new edge. The first that improves is applied.
 */
function tryNear(st: State, A: number, i: number, B: number, j: number): boolean {
  const na = st.routes[A].length;
  const nb = st.routes[B].length;
  // Relocate a run starting at s to just after v, or ending at s to just before v.
  // Every run that changes hands is checked against the technician it goes
  // TO: a pinned stop stays, and a stop needs its new technician's skill.
  for (let L = 1; L <= 3; L++) {
    if (i + L <= na && !st.blocked(A, i, i + L - 1, B)) {
      for (let rv = 0; rv < (L > 1 ? 2 : 1); rv++) {
        PA.reset()
          .add(A, 0, i - 1)
          .add(A, i + L, na - 1);
        PB.reset()
          .add(B, 0, j)
          .add(A, i, i + L - 1, rv === 1)
          .add(B, j + 1, nb - 1);
        if (tryMove(st, A, B)) return true;
      }
    }
    if (i - L + 1 >= 0 && !st.blocked(A, i - L + 1, i, B)) {
      for (let rv = 0; rv < (L > 1 ? 2 : 1); rv++) {
        PA.reset()
          .add(A, 0, i - L)
          .add(A, i + 1, na - 1);
        PB.reset()
          .add(B, 0, j - 1)
          .add(A, i - L + 1, i, rv === 1)
          .add(B, j, nb - 1);
        if (tryMove(st, A, B)) return true;
      }
    }
  }
  // Exchange runs of 1-2 so the run from A lands right after, or right before, v.
  for (let L1 = 1; L1 <= 2; L1++) {
    for (let L2 = 1; L2 <= 2; L2++) {
      if (
        i + L1 <= na &&
        j + L2 <= nb - 1 &&
        !st.blocked(A, i, i + L1 - 1, B) &&
        !st.blocked(B, j + 1, j + L2, A)
      ) {
        PA.reset()
          .add(A, 0, i - 1)
          .add(B, j + 1, j + L2)
          .add(A, i + L1, na - 1);
        PB.reset()
          .add(B, 0, j)
          .add(A, i, i + L1 - 1)
          .add(B, j + L2 + 1, nb - 1);
        if (tryMove(st, A, B)) return true;
      }
      if (
        i - L1 + 1 >= 0 &&
        j - L2 >= 0 &&
        !st.blocked(A, i - L1 + 1, i, B) &&
        !st.blocked(B, j - L2, j - 1, A)
      ) {
        PA.reset()
          .add(A, 0, i - L1)
          .add(B, j - L2, j - 1)
          .add(A, i + 1, na - 1);
        PB.reset()
          .add(B, 0, j - L2 - 1)
          .add(A, i - L1 + 1, i)
          .add(B, j, nb - 1);
        if (tryMove(st, A, B)) return true;
      }
    }
  }
  // 2-opt*: swap tails so that v -> s, or s -> v, becomes a leg.
  if (!st.blocked(A, i, na - 1, B) && !st.blocked(B, j + 1, nb - 1, A)) {
    PA.reset()
      .add(A, 0, i - 1)
      .add(B, j + 1, nb - 1);
    PB.reset()
      .add(B, 0, j)
      .add(A, i, na - 1);
    if (tryMove(st, A, B)) return true;
  }
  if (!st.blocked(A, i + 1, na - 1, B) && !st.blocked(B, j, nb - 1, A)) {
    PA.reset()
      .add(A, 0, i)
      .add(B, j, nb - 1);
    PB.reset()
      .add(B, 0, j - 1)
      .add(A, i + 1, na - 1);
    if (tryMove(st, A, B)) return true;
  }
  return false;
}

/** Moves for stop s into another route's first place: into an empty route,
 *  or to the front of one whose start it is near. */
function tryFront(st: State, A: number, i: number, nb: Neighbours, s: number): boolean {
  const na = st.routes[A].length;
  for (let B = 0; B < st.K; B++) {
    if (B === A) continue;
    const len = st.routes[B].length;
    if (len > 0 && !nb.nearStart[B].has(s)) continue;
    for (let L = 1; L <= 3 && i + L <= na; L++) {
      // A longer run holds the same stop, so it is blocked too.
      if (st.blocked(A, i, i + L - 1, B)) break;
      PA.reset()
        .add(A, 0, i - 1)
        .add(A, i + L, na - 1);
      PB.reset()
        .add(A, i, i + L - 1)
        .add(B, 0, len - 1);
      if (tryMove(st, A, B)) return true;
    }
  }
  return false;
}

/** One sweep of between-routes moves over every stop on a dirty route (or
 *  near one). Returns the routes it changed. */
function interSweep(
  st: State,
  nb: Neighbours,
  dirty: Set<number>,
  deadline: () => boolean,
): Set<number> {
  const changed = new Set<number>();
  const n = st.p.stops.length;
  for (let s = 0; s < n; s++) {
    if ((s & 15) === 0 && deadline()) break;
    const A = st.where[s];
    if (A < 0) continue;
    let relevant = dirty.has(A);
    if (!relevant) for (const v of nb.near[s]) if (dirty.has(st.where[v])) relevant = true;
    if (!relevant) continue;
    let moved = false;
    for (const v of nb.near[s]) {
      const B = st.where[v];
      if (B < 0 || B === A) continue;
      if (tryNear(st, A, st.at[s], B, st.at[v])) {
        changed.add(A);
        changed.add(B);
        moved = true;
        break;
      }
    }
    if (!moved && tryFront(st, A, st.at[s], nb, s)) {
      changed.add(A);
      for (let t = 0; t < st.K; t++) if (st.routes[t].includes(s)) changed.add(t);
    }
  }
  return changed;
}

function localSearch(
  st: State,
  nb: Neighbours,
  dirty: Set<number>,
  deadline: () => boolean,
  finalSweep = true,
) {
  // Without the final sweep the search stops when the routes it touched are
  // settled: what a ruin-and-recreate round needs, at a fraction of the cost.
  let fullPassDone = !finalSweep;
  let passes = 0;
  while (passes++ < 200) {
    if (deadline()) return;
    if (dirty.size === 0) {
      if (fullPassDone) return;
      // One last sweep over everything: the balance term is global, so a move
      // between two untouched routes can become worth making.
      for (let t = 0; t < st.K; t++) dirty.add(t);
      fullPassDone = true;
    }
    for (const t of [...dirty].sort((x, y) => x - y)) intraRoute(st, t);
    const changed = st.K > 1 ? interSweep(st, nb, dirty, deadline) : new Set<number>();
    for (const t of [...changed].sort((x, y) => x - y)) intraRoute(st, t);
    if (changed.size) fullPassDone = false;
    dirty = changed;
  }
}

/** Exact order for every route small enough; kept only if it is no worse.
 *  A longer route also gets a second opinion: its stops re-ordered from
 *  scratch the way the SQL planner did it (nearest neighbour from the start)
 *  and then improved by the same 2-opt and Or-opt -- a different starting
 *  point lands in a different local optimum, and on a 40-stop single-truck
 *  trial day that one was 3% shorter. Whichever is better is kept, so no
 *  route is ever ordered worse than the planner this replaced would order
 *  the same stops. */
function polishExact(st: State) {
  const p = st.p;
  const N = p.size;
  for (let t = 0; t < st.K; t++) {
    const r = st.routes[t];
    if (r.length < 3) continue;
    const tech = p.techs[t];
    if (r.length <= 12) {
      const order = exactOrder(p.matrix, N, tech.start, tech.end, r);
      const c = evaluateRoute(p, t, order);
      if (routeObjective(p, t, c) < st.robj[t] - EPS) st.setRoute(t, order);
      continue;
    }
    const left = new Set(r);
    const nn: number[] = [];
    let at = tech.start ?? -1;
    while (left.size) {
      let pick = -1;
      let pickCost = Infinity;
      for (const s of left) {
        const c = at < 0 ? 0 : p.matrix[at * N + s];
        if (c < pickCost - EPS || (Math.abs(c - pickCost) <= EPS && s < pick)) {
          pick = s;
          pickCost = c;
        }
      }
      nn.push(pick);
      left.delete(pick);
      at = pick;
    }
    const keep = st.routes[t];
    const keepVal = st.robj[t];
    st.setRoute(t, nn);
    intraRoute(st, t);
    if (st.robj[t] >= keepVal - EPS) st.setRoute(t, keep);
  }
}

// ── The solver ─────────────────────────────────────────────────────────────

export function solveRoutes(p: SolverProblem, opts: SolverOptions = {}): Solution {
  const now = opts.now ?? (() => Date.now());
  const t0 = now();
  const timeLimit = opts.timeLimitMs ?? 2500;
  const n = p.stops.length;
  const K = p.techs.length;
  if (K === 0) throw new Error("No technician to route");
  // One truck with twelve stops or fewer and no clock to keep: the exact
  // polish below already finds the best order there is, so there is nothing
  // for ruin-and-recreate to look for.
  const exactAlready = K === 1 && n <= 12 && !timelineMatters(p);
  const rounds = opts.rounds ?? (exactAlready ? 0 : Math.min(4000, 60 * n));
  const patience = opts.patience ?? Math.max(300, 10 * n);
  const rand = prng(opts.seed ?? 20261002);
  let timedOut = false;
  const deadline = () => {
    if (timedOut) return true;
    if (now() - t0 > timeLimit) timedOut = true;
    return timedOut;
  };

  // 1. Construction.
  const st = new State(
    p,
    p.techs.map(() => []),
  );
  // A stop nobody on the run may take is never offered to the search; it is
  // reported, with its reason, at the end.
  const takers = (i: number) => {
    let c = 0;
    for (let t = 0; t < K; t++) c += st.allow[i * K + t];
    return c;
  };
  const nobody: number[] = [];
  const pinned: number[] = [];
  const free: number[] = [];
  p.stops.forEach((s, i) => {
    if (takers(i) === 0) nobody.push(i);
    else if (s.fixedTech != null) pinned.push(i);
    else free.push(i);
  });
  const target = targets(st, estimateTotal(p));
  // Pinned stops are placed by cheapest insertion on their own route.
  regretInsert(st, pinned, target);
  regretInsert(st, free, target);
  const offered = pinned.length + free.length;
  /** Stops offered to the search that are on no route (a window nobody can
   *  meet so far). First in the ranking of any two days. */
  const unplacedOffered = () => offered - st.placed;

  // 2. Local search.
  const nb = neighbours(p);
  localSearch(st, nb, new Set([...Array(K).keys()]), deadline);
  let best = st.clone();
  let bestVal = st.total();
  let bestUnplaced = unplacedOffered();

  // 3. Ruin and recreate, with a little noise and a cooling threshold.
  //
  // Pulling out a cluster and putting it back the cheapest way rebuilds the
  // same day almost every time -- measured on a 40-stop single-truck day, 400
  // rounds returned the identical route 400 times. So the ruin varies (a
  // cluster of neighbours, a run of consecutive stops off a route and its
  // neighbour's, or stops at random), the re-insertion is jittered, and a
  // slightly worse day may be kept as the starting point for the next round
  // early on (threshold accepting, cooling to "only better" by the last
  // round). The best day seen is kept apart and is what is returned.
  let r = 0;
  let sinceBest = 0;
  let stoppedBy: Solution["stoppedBy"] = "rounds";
  const freeCount = free.length;
  const N = p.size;
  let cur = st.clone();
  let curVal = bestVal;
  let curUnplaced = bestUnplaced;
  const jitter = () => 1 + 0.3 * (rand() - 0.5);
  for (; r < rounds; r++) {
    if (deadline()) {
      stoppedBy = "time";
      break;
    }
    if (sinceBest >= patience) {
      stoppedBy = "patience";
      break;
    }
    if (freeCount < 2) break;
    const q = Math.max(2, Math.min(30, Math.round(freeCount * (0.05 + rand() * 0.35))));
    const removed = new Set<number>();
    const kind = rand();
    if (kind < 0.4) {
      // A cluster: a stop and its nearest neighbours, whoever's they are.
      const seed = free[Math.floor(rand() * freeCount)];
      free
        .map((x) => [x, p.matrix[seed * N + x] + p.matrix[x * N + seed]] as const)
        .sort((x, y) => x[1] - y[1] || x[0] - y[0])
        .slice(0, q)
        .forEach((x) => removed.add(x[0]));
    } else if (kind < 0.8) {
      // Strings: a run of consecutive stops round a seed, and a run round the
      // nearest stop on another route.
      const seed = free[Math.floor(rand() * freeCount)];
      const cut = (stop: number) => {
        const t = st.where[stop];
        if (t < 0) return;
        const rt = st.routes[t];
        const len = Math.max(1, Math.min(rt.length, Math.ceil(q / 2)));
        const at = st.at[stop];
        const from = Math.max(0, Math.min(rt.length - len, at - Math.floor(rand() * len)));
        for (let k = from; k < from + len; k++) {
          if (p.stops[rt[k]].fixedTech == null) removed.add(rt[k]);
        }
      };
      cut(seed);
      const other = nb.near[seed].find((x) => st.where[x] !== st.where[seed]);
      if (other != null) cut(other);
    } else {
      for (let k = 0; k < q; k++) removed.add(free[Math.floor(rand() * freeCount)]);
    }
    const out = [...removed];
    // Whatever is still on no route gets another go every round: the routes
    // around it have changed, and a window that did not fit may fit now.
    for (const x of pinned) if (st.where[x] < 0) out.push(x);
    for (const x of free) if (st.where[x] < 0 && !removed.has(x)) out.push(x);
    const touched = new Set<number>();
    for (let t = 0; t < K; t++) {
      const rt = st.routes[t];
      if (rt.some((x) => removed.has(x))) {
        st.setRoute(
          t,
          rt.filter((x) => !removed.has(x)),
        );
        touched.add(t);
      }
    }
    const totalLoad = st.loads.reduce((x, y) => x + y, 0);
    const addBack = out.reduce((x, y) => x + p.stops[y].service, 0) * 1.5;
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    regretInsert(st, out, targets(st, totalLoad + addBack), jitter);
    for (const x of out) if (st.where[x] >= 0) touched.add(st.where[x]);
    localSearch(st, nb, touched, deadline, false);
    const v = st.total();
    const u = unplacedOffered();
    const threshold = 0.01 * Math.abs(bestVal) * Math.max(0, 1 - r / rounds);
    // Fewer stops left out beats everything; at the same count, the cost.
    if (u < bestUnplaced || (u === bestUnplaced && v < bestVal - EPS)) {
      bestVal = v;
      bestUnplaced = u;
      best = st.clone();
      sinceBest = 0;
    } else {
      sinceBest++;
    }
    if (u < curUnplaced || (u === curUnplaced && v < curVal + threshold)) {
      cur = st.clone();
      curVal = v;
      curUnplaced = u;
    } else {
      for (let t = 0; t < K; t++) st.setRoute(t, [...cur[t]]);
    }
  }
  if (r >= rounds) stoppedBy = "rounds";

  // 4. Polish.
  for (let t = 0; t < K; t++) st.setRoute(t, [...best[t]]);
  polishExact(st);
  for (let t = 0; t < K; t++) intraRoute(st, t);

  // What was left out, and why: a stop nobody on the run may take, or one
  // whose window no route could keep.
  const unassigned: UnassignedStop[] = [];
  for (const s of nobody) unassigned.push({ stop: s, reason: "no_eligible_tech" });
  for (let s = 0; s < n; s++) {
    if (st.where[s] < 0 && takers(s) > 0) unassigned.push({ stop: s, reason: "window" });
  }
  unassigned.sort((a, b) => a.stop - b.stop);

  return {
    routes: st.clone(),
    costs: [...st.costs],
    objective: st.total(),
    unassigned,
    rounds: r,
    stoppedBy,
    ms: now() - t0,
  };
}

/** Order one technician's stops on their own: local search and the exact
 *  polish, no reassignment. For a route whose start moved after solving. */
export function polishRoute(p: SolverProblem, t: number, route: number[]): number[] {
  const routes = p.techs.map((_, k) => (k === t ? [...route] : []));
  const st = new State(p, routes);
  intraRoute(st, t);
  polishExact(st);
  intraRoute(st, t);
  return [...st.routes[t]];
}
