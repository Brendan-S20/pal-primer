/**
 * The routing trials: plan a synthetic business's day with the REAL planner
 * and measure what came out.
 *
 * ── WHAT IS REAL AND WHAT IS NOT ──────────────────────────────────────────
 *
 * Real, and unchanged from what the app runs:
 *
 *   * the planner. `preview_optimize` and `plan_day_across_staff` are called
 *     in the order `applyOptimize` calls them (forecast, then measure the
 *     road, then write), as the `authenticated` role with an owner's JWT, in
 *     the local Supabase, inside BEGIN ... ROLLBACK. Nothing is left behind.
 *   * the road measurement. `refreshRoadLegs` from src/lib/road-legs.server.ts
 *     is called for real; only its two edges are replaced -- the Supabase
 *     admin client (answered from the scenario) and `fetch` (answered from a
 *     recorded public-OSRM response, or made to fail on purpose). The rows it
 *     decides to write are the rows inserted into `road_legs`.
 *   * the warnings a dispatcher sees: `findRouteWarnings` from
 *     route-plausibility.ts, run over the visits as the board would.
 *
 * Not real: the businesses. See scenarios.ts.
 *
 * ── NETWORK ──────────────────────────────────────────────────────────────
 *
 * Nothing here touches the network unless ROUTING_TRIALS_RECORD=1, and then
 * only for an OSRM request that has no recording yet, at most one per 1.1 s,
 * against the public demo server. Every answer is saved to fixtures/osrm/ so
 * the next run is offline. A missing recording without RECORD is a test
 * failure, not a silent fallback to estimates.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { zonedTimeToUtc } from "@/lib/route-window";
import { orgLocalDay, orgLocalMinutes } from "@/lib/org-day";
import { findRouteWarnings } from "@/lib/route-plausibility";
import { measureDayFit } from "@/lib/route-day-fit";
import type { RoadLegResult } from "@/lib/road-legs.server";
import { driveModel, planDay, type DayPlan, type RouteDayInputs } from "@/lib/route-inputs";
import type { SolverOptions } from "@/lib/route-solver";

import type { Scenario, StopSpec, TechSpec } from "./scenarios";
import * as M from "./metrics";

export const DB_URL =
  process.env.ROUTING_TRIALS_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const HERE = import.meta.dirname;
export const ROOT = join(HERE, "..", "..");
const FIXTURES = join(HERE, "fixtures", "osrm");
const RECORD = process.env.ROUTING_TRIALS_RECORD === "1";

/** The production limit every planner call has to finish inside. */
export const STATEMENT_TIMEOUT_MS = 8000;

/** Which planner a trial runs: the plpgsql one (#294) or the TypeScript one
 *  the app ships since 2026-10. */
export type Planner = "sql" | "ts";

/** The solver as the server function runs it: route-plan.server.ts passes a
 *  time limit and leaves the round budget to the solver's own default. */
export const TRIAL_SOLVER: SolverOptions = {
  timeLimitMs: Number(process.env.ROUTING_TRIALS_SOLVER_MS ?? 2500),
};

export type TsMiss = {
  visit_id: string;
  staff_id: string;
  client: string | null;
  kind: "late" | "early";
  eta_start: string;
  earliest: string | null;
  latest: string | null;
};
/** drive_minutes adds this to every leg; organizations.park_walk_min default. */
const PARK_WALK_MIN = 2;

// ── Identity ────────────────────────────────────────────────────────────────

/** A stable UUID per (scenario, kind, key), so reruns produce the same rows. */
export function uuidFor(...parts: string[]): string {
  const h = createHash("md5").update(parts.join(":")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const ids = (sc: Scenario) => ({
  org: uuidFor(sc.id, "org"),
  owner: uuidFor(sc.id, "owner"),
  staff: (t: TechSpec) => uuidFor(sc.id, "staff", t.key),
  user: (t: TechSpec) => uuidFor(sc.id, "user", t.key),
  client: (st: StopSpec) => uuidFor(sc.id, "client", st.key),
  property: (st: StopSpec) => uuidFor(sc.id, "property", st.key),
  sub: (st: StopSpec) => uuidFor(sc.id, "sub", st.key),
  visit: (st: StopSpec) => uuidFor(sc.id, "visit", st.key),
});

// ── psql ────────────────────────────────────────────────────────────────────

export function findPsql(): string | null {
  for (const p of [
    "psql",
    "/opt/homebrew/opt/libpq/bin/psql",
    "/opt/homebrew/opt/postgresql@18/bin/psql",
    "/opt/homebrew/opt/postgresql@17/bin/psql",
    "/usr/local/opt/libpq/bin/psql",
  ]) {
    const r = spawnSync(p, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return p;
  }
  return null;
}

export function databaseReachable(): boolean {
  const psql = findPsql();
  if (!psql) return false;
  const r = spawnSync(psql, [DB_URL, "-XAtc", "select 1"], { encoding: "utf8", timeout: 5000 });
  return r.stdout?.trim() === "1";
}

// ── The two edges of refreshRoadLegs ────────────────────────────────────────

/** Answers the four queries refreshRoadLegs makes, from the scenario. */
export function fakeAdmin(sc: Scenario, written: Array<Record<string, unknown>>) {
  const rows = (data: unknown[]) => {
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: () => Promise.resolve({ data: data[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, no?: (e: unknown) => unknown) =>
        Promise.resolve({ data, error: null }).then(ok, no),
    };
    return q;
  };
  return {
    from(table: string) {
      switch (table) {
        case "visits":
          return rows(
            sc.stops.map((st) => ({ properties: { latitude: st.lat, longitude: st.lon } })),
          );
        case "staff":
          return rows(
            sc.techs.map((t) => ({
              start_latitude: t.start?.[0] ?? null,
              start_longitude: t.start?.[1] ?? null,
              end_latitude: t.end?.[0] ?? null,
              end_longitude: t.end?.[1] ?? null,
            })),
          );
        case "waste_disposal_facilities":
          return rows((sc.dumps ?? []).map((d) => ({ latitude: d.at[0], longitude: d.at[1] })));
        case "organizations":
          return rows([
            { latitude: sc.org.business?.[0] ?? null, longitude: sc.org.business?.[1] ?? null },
          ]);
        case "road_legs":
          return {
            upsert: async (r: Array<Record<string, unknown>>) => {
              written.push(...r);
              return { error: null };
            },
          };
        // The fallback counter (20261002090600): accepted and dropped. The
        // trials measure the plan, not the counter, which has its own tests.
        case "road_leg_runs": {
          const done = { error: null };
          const chain = { eq: () => chain, lt: async () => done };
          return { insert: async () => done, delete: () => chain };
        }
        default:
          throw new Error(
            `refreshRoadLegs asked for ${table}; the trial harness does not answer it`,
          );
      }
    },
    rpc: async () => ({ error: null }),
  };
}

/** The parts of an OSRM Table answer this file reads. */
type OsrmTable = {
  code?: string;
  durations?: (number | null)[][];
  distances?: (number | null)[][];
  sources?: Array<{ distance?: number; hint?: string }>;
  destinations?: Array<{ distance?: number; hint?: string }>;
};
type Recorded = Record<string, { status: number; body: OsrmTable; recordedAt: string }>;

const fixturePath = (name: string) => join(FIXTURES, `${name}.json`);
export function loadFixture(name: string | undefined): Recorded {
  if (!name || !existsSync(fixturePath(name))) return {};
  return JSON.parse(readFileSync(fixturePath(name), "utf8"));
}

/** The part of an OSRM URL that identifies the question, whatever host asked it. */
const requestKey = (url: string) => url.slice(url.indexOf("/table/v1/"));

let lastRealRequest = 0;

/** Runs `fn` with fetch answered as the scenario says the router behaves. */
export async function withRouter<T>(
  sc: Scenario,
  fn: () => Promise<T>,
): Promise<{ value: T; requests: number; misses: string[]; recorded: number }> {
  const real = globalThis.fetch;
  let requests = 0;
  let recorded = 0;
  const misses: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests++;
    if (sc.osrm === "down") throw new TypeError("fetch failed (routing trial: router down)");
    if (sc.osrm === "rate_limited") {
      return new Response(JSON.stringify({ message: "Too Many Requests" }), { status: 429 });
    }
    const fx = loadFixture(sc.fixture);
    const key = requestKey(url);
    if (fx[key]) return new Response(JSON.stringify(fx[key].body), { status: fx[key].status });
    if (!RECORD) {
      misses.push(key);
      throw new TypeError("no recorded OSRM answer (routing trial)");
    }
    // Politeness to a free public service: one request per 1.1 s, ever.
    const wait = lastRealRequest + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRealRequest = Date.now();
    const res = await real(`https://router.project-osrm.org${key}`, init);
    const body = (await res.json()) as OsrmTable;
    // Hints are opaque, large, and specific to one build of the graph.
    for (const w of [...(body.sources ?? []), ...(body.destinations ?? [])]) delete w.hint;
    fx[key] = { status: res.status, body, recordedAt: new Date().toISOString() };
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(fixturePath(sc.fixture!), JSON.stringify(fx) + "\n");
    recorded++;
    return new Response(JSON.stringify(body), { status: res.status });
  }) as typeof fetch;
  try {
    return { value: await fn(), requests, misses, recorded };
  } finally {
    globalThis.fetch = real;
  }
}

// ── SQL ─────────────────────────────────────────────────────────────────────

const q = (s: string | null | undefined) => (s == null ? "NULL" : `'${s.replace(/'/g, "''")}'`);
const n = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "NULL" : String(v));

/** Migrations the trials need that a local database may not have applied yet.
 *  Each is idempotent (it returns early when already spliced), so applying it
 *  inside the trial's own transaction is safe on any database. */
export const REQUIRED_MIGRATIONS: string[] = [
  "20261002090000_a-window-set-on-the-service-was-never-routed.sql",
  "20261002090100_a-stop-with-no-location-hid-the-drive-around-it.sql",
  "20261002090200_one-bad-coordinate-refused-the-whole-day.sql",
  "20261002090300_a-part-timer-was-given-a-full-timers-day.sql",
  // The TypeScript planner's two ends, the window policy it reads, and the
  // drive model without a typed speed. Applied in the trial's transaction
  // like the four above when the database has not run them yet.
  "20261002090400_arrival-windows-can-be-set-aside.sql",
  "20261002090500_drive-times-are-not-a-typed-speed.sql",
  "20261002090700_the-route-is-solved-outside-the-database.sql",
  // The service catalog (#358, #381, #384) and appointment routing's write,
  // which takes the stops the solver leaves out (20261010120000). A stack
  // that follows main may have none of them; each is applied in the trial's
  // transaction only where it is missing, like the seven above.
  "20261008120000_a-dog-walker-should-not-have-to-learn-about-dump-sites.sql",
  "20261009200000_a-walk-is-not-a-cleanup.sql",
  "20261009230000_a-visit-knows-its-service.sql",
  "20261009230100_a-walk-takes-as-long-as-the-walk.sql",
  "20261010120000_a-window-is-kept-and-a-skill-is-matched.sql",
].map((f) => join(ROOT, "supabase/migrations", f));

let pendingCache: string[] | null = null;
/** The required migrations this database has NOT recorded as applied. On a
 *  database built from the migrations (CI) that is none, and the trials take
 *  no DDL locks at all -- which matters, because the other database proofs
 *  run beside them and re-apply migrations of their own. */
function pendingMigrations(): string[] {
  if (pendingCache) return pendingCache;
  const psql = findPsql();
  const versions = REQUIRED_MIGRATIONS.map((m) => m.split("/").pop()!.slice(0, 14));
  const r = psql
    ? spawnSync(
        psql,
        [
          DB_URL,
          "-XAtc",
          `select version from supabase_migrations.schema_migrations where version in (${versions
            .map((v) => `'${v}'`)
            .join(",")})`,
        ],
        { encoding: "utf8", timeout: 10_000 },
      )
    : null;
  const applied = new Set((r?.stdout ?? "").split("\n").filter(Boolean));
  pendingCache = REQUIRED_MIGRATIONS.filter((m, i) => !applied.has(versions[i]));
  return pendingCache;
}

/** Which planner a trial runs, and which half of it this SQL is.
 *
 *  "sql"     the plpgsql planner (#294's): preview_optimize, then the road,
 *            then plan_day_across_staff -- applyOptimize's order until 2026-10.
 *  "inputs"  the TypeScript planner's read: the road, then route_day_inputs.
 *  "apply"   its write: the road, then apply_route_plan with the solver's
 *            routes, then everything the checks read.
 *
 *  The TypeScript planner needs a round trip through this process between
 *  its read and its write, and psql runs one script. So the day is built
 *  twice from the same deterministic ids -- once to read, once to write --
 *  each inside its own BEGIN ... ROLLBACK. */
export type SqlMode =
  | { kind: "sql" }
  | { kind: "inputs" }
  | { kind: "apply"; routes: unknown; honourWindows: boolean; unassigned?: string[] };

export function buildSql(
  sc: Scenario,
  legs: Array<Record<string, unknown>>,
  mode: SqlMode = { kind: "sql" },
): string {
  const id = ids(sc);
  const out: string[] = [];
  const emit = (tag: string, sql: string) =>
    out.push(`SELECT '@@${tag} ' || COALESCE((${sql})::jsonb::text, 'null');`);

  out.push("\\set ON_ERROR_STOP on", "SET client_min_messages TO warning;", "BEGIN;");
  // The splice migrations take an exclusive lock on the functions they
  // replace; queue behind each other rather than deadlock with a parallel run.
  out.push("SELECT pg_advisory_xact_lock(hashtext('houndstack.routing-trials'));");
  // ROUTING_TRIALS_SKIP_MIGRATIONS=1 runs the planner as the database has it,
  // which on a database without these files is the mutation test: the
  // assertions in tests/routing-trials.test.ts must fail there.
  if (process.env.ROUTING_TRIALS_SKIP_MIGRATIONS !== "1") {
    for (const m of pendingMigrations()) out.push(`\\i ${m}`);
  }

  // ── The business ──
  out.push(
    `INSERT INTO auth.users (id, email) VALUES (${q(id.owner)}, ${q(`${id.owner}@trial.invalid`)});`,
    "SET LOCAL app.allow_protected_org_write = '1';",
    `INSERT INTO public.organizations (id, name, timezone, area_type, workday_start, workday_end,
       latitude, longitude, is_comped, plan_status)
     VALUES (${q(id.org)}, ${q(`Routing trial: ${sc.id}`)}, ${q(sc.org.tz)}, ${q(sc.org.areaType)},
       ${q(sc.org.workdayStart ?? "08:00")}, ${q(sc.org.workdayEnd ?? "17:00")},
       ${n(sc.org.business?.[0])}, ${n(sc.org.business?.[1])}, true, 'active');`,
    // The arrival-window setting, only when a scenario sets it aside, so a
    // database without 20261002090400 still builds every other day.
    ...(sc.org.windows === "ignore"
      ? [`UPDATE public.organizations SET route_windows = 'ignore' WHERE id = ${q(id.org)};`]
      : []),
    `INSERT INTO public.user_roles (user_id, organization_id, role) VALUES (${q(id.owner)}, ${q(id.org)}, 'owner');`,
  );
  for (const t of sc.techs) {
    const field = t.isFieldTech !== false;
    out.push(
      `INSERT INTO auth.users (id, email) VALUES (${q(id.user(t))}, ${q(`${id.user(t)}@trial.invalid`)});`,
      `INSERT INTO public.staff (id, organization_id, user_id, display_name, role, active, is_field_tech,
         is_field_tech_overridden, start_latitude, start_longitude, end_latitude, end_longitude,
         daily_capacity_minutes)
       VALUES (${q(id.staff(t))}, ${q(id.org)}, ${q(id.user(t))}, ${q(t.name)},
         ${field ? "'tech'" : "'office_manager'"}, true, ${field}, true,
         ${n(t.start?.[0])}, ${n(t.start?.[1])}, ${n(t.end?.[0])}, ${n(t.end?.[1])}, ${n(t.capacityMin)});`,
    );
  }
  for (const d of sc.dumps ?? []) {
    out.push(
      `INSERT INTO public.waste_disposal_facilities (organization_id, name, latitude, longitude)
       VALUES (${q(id.org)}, ${q(d.name)}, ${d.at[0]}, ${d.at[1]});`,
    );
  }

  // ── The customers and the day ──
  const clients: string[] = [];
  const props: string[] = [];
  const subs: string[] = [];
  const visits: string[] = [];
  for (const st of sc.stops) {
    const w = st.window;
    const pw = w?.on === "property" ? w : undefined;
    const sw = w?.on === "subscription" ? w : undefined;
    const pre = st.preassign ? sc.techs.find((t) => t.key === st.preassign) : undefined;
    clients.push(`(${q(id.client(st))}, ${q(id.org)}, 'residential', ${q(st.name)})`);
    props.push(
      `(${q(id.property(st))}, ${q(id.client(st))}, ${q(id.org)}, ${q(st.name)}, 'Trial', '00000',
        ${n(st.lat)}, ${n(st.lon)}, ${st.serviceMin ?? 8}, ${q(pw?.earliest)}, ${q(pw?.latest)},
        ${q(st.name)})`,
    );
    subs.push(
      `(${q(id.sub(st))}, ${q(id.org)}, ${q(id.client(st))}, ${q(id.property(st))}, 'residential',
        'weekly', 2000, 1, ${q(st.pref ?? "any")}, ${q(sw?.earliest)}, ${q(sw?.latest)})`,
    );
    visits.push(
      `(${q(id.visit(st))}, ${q(id.org)}, ${q(id.sub(st))}, ${q(id.client(st))}, ${q(id.property(st))},
        ${q(sc.day)}, ${pre ? q(id.staff(pre)) : "NULL"})`,
    );
  }
  out.push(
    `INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES ${clients.join(",\n")};`,
    `INSERT INTO public.properties (id, client_id, organization_id, label, city, postal_code, latitude,
       longitude, service_duration_min, earliest_service_time, latest_service_time, street)
     VALUES ${props.join(",\n")};`,
    `INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type,
       frequency, price_cents, dog_count, preferred_time_of_day, earliest_time, latest_time)
     VALUES ${subs.join(",\n")};`,
    `INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id, scheduled_on,
       assigned_staff_id)
     VALUES ${visits.join(",\n")};`,
  );
  // Held open until the customers are in: adding them re-tiers the business,
  // which writes a platform column.
  out.push("SET LOCAL app.allow_protected_org_write = '';");
  // Leave booked AFTER the work was assigned, which is how it happens.
  for (const t of sc.techs.filter((x) => x.offToday)) {
    out.push(
      `INSERT INTO public.staff_time_off (organization_id, staff_id, starts_on, ends_on, reason)
       VALUES (${q(id.org)}, ${q(id.staff(t))}, ${q(sc.day)}, ${q(sc.day)}, 'Routing trial');`,
    );
  }

  const selected = sc.techs.filter((t) => t.selected !== false).map((t) => id.staff(t));
  const staffArr = `ARRAY[${selected.map(q).join(",")}]::uuid[]`;

  // Results land here, so an error is a row rather than a dead transaction.
  out.push(
    "CREATE TEMP TABLE _trial (step text, ok boolean, err text, ms numeric, payload json) ON COMMIT DROP;",
    "GRANT ALL ON _trial TO authenticated;",
    `SELECT set_config('request.jwt.claims', ${q(JSON.stringify({ sub: id.owner, role: "authenticated" }))}, true);`,
  );
  // The app's planner runs as `authenticated`, the role the API gives a
  // signed-in owner. The old SQL planner no longer has that grant (nothing
  // in the app calls it since 20261002090700), so the benchmark calls it as
  // the database owner, with the same JWT: it still checks can_write_org.
  const call = (step: string, sql: string, asApp = true) =>
    out.push(
      asApp ? "SET LOCAL ROLE authenticated;" : "SELECT 1;",
      `DO $trial$ DECLARE t0 timestamptz := clock_timestamp(); r json; BEGIN
         SELECT json_agg(x) INTO r FROM (${sql}) x;
         INSERT INTO _trial VALUES (${q(step)}, true, NULL,
           extract(epoch FROM clock_timestamp() - t0) * 1000, r);
       EXCEPTION WHEN OTHERS THEN
         INSERT INTO _trial VALUES (${q(step)}, false, SQLERRM,
           extract(epoch FROM clock_timestamp() - t0) * 1000, NULL);
       END $trial$;`,
      "RESET ROLE;",
    );

  // 1. The forecast, BEFORE the road is measured -- the SQL planner's order.
  if (mode.kind === "sql") {
    call(
      "forecast",
      `SELECT * FROM public.preview_optimize(${q(id.org)}, ${staffArr}, ${q(sc.day)}, ${q(sc.day)}, 'thorough', true)`,
      false,
    );
  }

  // 2. What refreshRoadLegs decided to write.
  if (legs.length) {
    const vals = legs.map(
      (l) =>
        `(${q(id.org)}, ${l.from_lat}, ${l.from_lon}, ${l.to_lat}, ${l.to_lon}, ${l.meters}, ${l.seconds}, 'osrm')`,
    );
    out.push(
      `INSERT INTO public.road_legs (organization_id, from_lat, from_lon, to_lat, to_lon, meters, seconds, source)
       VALUES ${vals.join(",\n")}
       ON CONFLICT (organization_id, from_lat, from_lon, to_lat, to_lon) DO UPDATE
         SET meters = EXCLUDED.meters, seconds = EXCLUDED.seconds, fetched_at = now();`,
      `SELECT public.refresh_road_profile(${q(id.org)});`,
    );
  }

  // 3. The read the TypeScript planner plans from; nothing else to emit.
  if (mode.kind === "inputs") {
    call(
      "inputs",
      `SELECT public.route_day_inputs(${q(id.org)}, ${staffArr}, ${q(sc.day)}, true) AS j`,
    );
    emit("steps", "SELECT json_agg(t) FROM _trial t");
    out.push("ROLLBACK;");
    return out.join("\n");
  }

  // 4. The write.
  if (mode.kind === "apply") {
    // The stops the solver left out on purpose (a window no route keeps, or
    // nobody with the skill), as the app passes them (20261010120000).
    const left = (mode.unassigned ?? []).map((v) => q(v)).join(", ");
    call(
      "apply",
      `SELECT public.apply_route_plan(${q(id.org)}, ${staffArr}, ${q(sc.day)}, true,
         ${q(JSON.stringify(mode.routes))}::jsonb, ${mode.honourWindows},
         ARRAY[${left}]::uuid[]) AS j`,
    );
  } else {
    call(
      "apply",
      `SELECT * FROM public.plan_day_across_staff(${q(id.org)}, ${staffArr}, ${q(sc.day)}, true, 'thorough')`,
      false,
    );
  }

  emit("steps", "SELECT json_agg(t) FROM _trial t");
  emit(
    "visits",
    `SELECT json_agg(json_build_object(
        'id', v.id, 'staff', v.assigned_staff_id, 'seq', v.sequence,
        'etaStart', v.eta_start, 'etaEnd', v.eta_end,
        'travelMin', v.travel_min, 'travelKm', v.travel_km, 'violated', v.window_violated,
        'lat', p.latitude, 'lon', p.longitude)
        ORDER BY v.assigned_staff_id, v.sequence)
       FROM public.visits v JOIN public.properties p ON p.id = v.property_id
      WHERE v.organization_id = ${q(id.org)}`,
  );
  emit(
    "starts",
    `SELECT json_object_agg(s.id, json_build_object('lat', sp.lat, 'lon', sp.lon, 'source', sp.source))
       FROM public.staff s
       CROSS JOIN LATERAL public.staff_start_point(${q(id.org)}, s.id, ${q(sc.day)},
         ARRAY(SELECT v.id FROM public.visits v WHERE v.assigned_staff_id = s.id
                AND v.scheduled_on = ${q(sc.day)} AND v.organization_id = ${q(id.org)})) sp
      WHERE s.organization_id = ${q(id.org)}`,
  );
  emit(
    "profile",
    `SELECT json_build_object('speed', measured_speed_kmh, 'factor', measured_road_factor, 'legs', measured_legs)
       FROM public.organizations WHERE id = ${q(id.org)}`,
  );
  // The planner's own cost of every pair: tech starts first, then stops.
  out.push(
    `CREATE TEMP TABLE _nodes ON COMMIT DROP AS
       SELECT row_number() OVER () - 1 AS i, x.k, x.lat, x.lon FROM (
         SELECT 'start:' || s.id AS k, sp.lat, sp.lon, 0 AS o, s.id::text AS ord
           FROM public.staff s
           CROSS JOIN LATERAL public.staff_start_point(${q(id.org)}, s.id, ${q(sc.day)},
             ARRAY(SELECT v.id FROM public.visits v WHERE v.assigned_staff_id = s.id
                    AND v.scheduled_on = ${q(sc.day)} AND v.organization_id = ${q(id.org)})) sp
          WHERE s.organization_id = ${q(id.org)}
         UNION ALL
         SELECT 'visit:' || v.id, p.latitude, p.longitude, 1, v.id::text
           FROM public.visits v JOIN public.properties p ON p.id = v.property_id
          WHERE v.organization_id = ${q(id.org)}
         ORDER BY 4, 5) x;`,
  );
  emit(
    "nodes",
    "SELECT json_agg(json_build_object('k', k, 'lat', lat, 'lon', lon) ORDER BY i) FROM _nodes",
  );
  emit(
    "matrix",
    `SELECT json_agg(r ORDER BY i) FROM (
       SELECT a.i, json_agg(round(public.drive_minutes(${q(id.org)}, a.lat, a.lon, b.lat, b.lon), 3) ORDER BY b.i) r
         FROM _nodes a CROSS JOIN _nodes b GROUP BY a.i) m`,
  );
  out.push("ROLLBACK;");
  return out.join("\n");
}

/** One row of a planner call's JSON payload: preview_optimize's or
 *  plan_day_across_staff's columns, whichever was called. */
type StepPayloadRow = Record<string, number | string | boolean | null>;

/** What the SQL above prints, by tag. */
type Tags = {
  steps?: Array<{
    step: string;
    ok: boolean;
    err: string | null;
    ms: number;
    payload: StepPayloadRow[] | null;
  }>;
  visits?: Array<{
    id: string;
    staff: string | null;
    seq: number | null;
    etaStart: string | null;
    etaEnd: string | null;
    travelMin: number | null;
    travelKm: number | null;
    violated: boolean | null;
    lat: number | null;
    lon: number | null;
  }>;
  starts?: Record<string, { lat: number | null; lon: number | null; source: string }>;
  profile?: { speed: number | null; factor: number | null; legs: number | null };
  nodes?: Array<{ k: string; lat: number | null; lon: number | null }>;
  matrix?: (number | null)[][];
};

export function runSql(sql: string): {
  tags: Tags;
  stderr: string;
  status: number | null;
} {
  const psql = findPsql();
  if (!psql) throw new Error("psql not found");
  // Queue behind the SQL proofs instead of colliding with them: every
  // tests/sql proof takes this session lock first (the-proofs-take-turns
  // .test.ts), and a trial that writes its org while a proof re-applies a
  // migration was still picked as a deadlock victim three retries running on
  // 2026-10-02. Held until psql disconnects, so the whole scenario is inside it.
  const run = () =>
    spawnSync(psql, [DB_URL, "-X", "-At", "-f", "-"], {
      input: `DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;\n${sql}`,
      encoding: "utf8",
      timeout: 480_000,
      maxBuffer: 256 * 1024 * 1024,
    });
  // Other proofs re-apply migrations with ALTER TABLE inside their own
  // transactions; when vitest runs them beside this one, Postgres may pick
  // this transaction as a deadlock victim. It rolled back cleanly, so retry,
  // as Postgres itself advises. Any other failure is returned as it is.
  let r = run();
  for (let i = 0; i < 3 && /deadlock detected/.test(r.stderr ?? ""); i++) r = run();
  const tags: Tags = {};
  for (const line of (r.stdout ?? "").split("\n")) {
    const m = /^@@(\w+) (.*)$/.exec(line);
    if (m) (tags as Record<string, unknown>)[m[1]] = JSON.parse(m[2]);
  }
  return { tags, stderr: r.stderr ?? "", status: r.status };
}

// ── One trial ───────────────────────────────────────────────────────────────

export type VisitOut = {
  key: string;
  name: string;
  stop: StopSpec;
  staffKey: string | null;
  seq: number | null;
  etaStart: string | null;
  etaEnd: string | null;
  travelMin: number | null;
  travelKm: number | null;
  violated: boolean;
  /** The coordinates as STORED, after any trigger had its say. */
  storedLat: number | null;
  storedLon: number | null;
};

export type TechOut = {
  key: string;
  name: string;
  eligible: boolean;
  startSource: string | null;
  stops: VisitOut[];
  driveMin: number;
  serviceMin: number;
  /** Minutes from the first departure to the end of the last stop. */
  dayMin: number;
  endLocal: string | null;
  overtimeMin: number;
  overCapacityMin: number;
  crossings: number;
  sideChanges?: { changes: number; minimum: number };
  /** Same stops, same matrix, three orders. */
  plannerCost: number | null;
  nnCost: number | null;
  goodCost: number | null;
  /** The planner's order re-scored on the recorded OSRM road times. */
  roadCost: number | null;
  goodRoadCost: number | null;
  /** For a referee with its own drive times (the Google comparison): where the
   *  truck starts, its stops in the planner's order, and the same stops in the
   *  best order found on the recorded OSRM times. Located stops only. */
  route?: {
    start: [number, number] | null;
    planner: Array<[number, number]>;
    osrmBest: Array<[number, number]> | null;
  };
};

export type TrialResult = {
  sc: Scenario;
  planner: Planner;
  /** The TypeScript planner's own timings and answer; null for the SQL one. */
  ts: {
    inputsMs: number;
    solveMs: number;
    applyMs: number;
    solver: { rounds: number; stoppedBy: string; objective: number } | null;
    honourWindows: boolean;
    misses: TsMiss[];
    /** Stops the solver left off every route, by stop key, with the reason. */
    unassigned: Array<{ key: string; reason: string }>;
    inputs: RouteDayInputs | null;
  } | null;
  /** Largest difference, in minutes, between the TypeScript drive model and
   *  drive_minutes itself over every pair of this day's points. */
  modelMismatch: number | null;
  legResult: RoadLegResult;
  legsWritten: number;
  osrmRequests: number;
  fixtureMisses: string[];
  recorded: number;
  forecast: { ok: boolean; err: string | null; ms: number; rows: StepPayloadRow[] };
  apply: { ok: boolean; err: string | null; ms: number; rows: StepPayloadRow[] };
  visits: VisitOut[];
  techs: TechOut[];
  profile: { speed: number | null; factor: number | null; legs: number | null };
  checks: {
    unassigned: string[];
    onIneligible: string[];
    seqBroken: string[];
    nonFinite: string[];
    etaChainBroken: string[];
    offDay: string[];
    windowTruth: Array<{
      key: string;
      arrivalLocal: string;
      latest: string;
      missed: boolean;
      flagged: boolean;
    }>;
    forecastViolations: number;
    appliedViolations: number;
    boardWarnings: Array<{ key: string; reason: string; message: string }>;
    interleave: number;
    balanceSpreadMin: number;
    teleports: Array<{ key: string; hiddenMin: number }>;
    /** What applyOptimize's day-fit check reports for this plan. */
    fit: ReturnType<typeof measureDayFit>;
  };
  stderr: string;
};

/** The road truth for a geography: recorded OSRM seconds by rounded coordinate. */
function roadTruth(fixture: string | undefined) {
  const fx = loadFixture(fixture);
  const keyOf = (lat: number, lon: number) => `${lat.toFixed(5)},${lon.toFixed(5)}`;
  const tables: Array<{ index: Map<string, number>; durations: (number | null)[][] }> = [];
  for (const [k, v] of Object.entries(fx)) {
    if (v.status !== 200 || v.body?.code !== "Ok") continue;
    const coords = k.slice("/table/v1/driving/".length).split("?")[0].split(";");
    const index = new Map<string, number>();
    coords.forEach((c, i) => {
      const [lon, lat] = c.split(",").map(Number);
      index.set(keyOf(lat, lon), i);
    });
    // A point OSRM had to snap more than 2 km is one refreshRoadLegs refuses;
    // the truth refuses it too.
    const bad = new Set<number>();
    (v.body.sources ?? []).forEach((s, i) => (s?.distance ?? 0) > 2000 && bad.add(i));
    const durations = (v.body.durations ?? []).map((row: (number | null)[], i: number) =>
      row.map((d, j) => (bad.has(i) || bad.has(j) ? null : d)),
    );
    tables.push({ index, durations });
  }
  return (a: [number, number] | null, b: [number, number] | null): number | null => {
    if (!a || !b) return null;
    for (const t of tables) {
      const i = t.index.get(keyOf(a[0], a[1]));
      const j = t.index.get(keyOf(b[0], b[1]));
      if (i == null || j == null) continue;
      const s = t.durations[i]?.[j];
      if (typeof s === "number") return s / 60 + PARK_WALK_MIN;
    }
    return null;
  };
}

const hhmm = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(Math.round(min % 60)).padStart(2, "0")}`;
const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

export async function runTrial(
  sc: Scenario,
  refreshRoadLegs: (orgId: string, day: string) => Promise<RoadLegResult>,
  setAdmin: (a: unknown) => void,
  planner: Planner = "ts",
): Promise<TrialResult> {
  const id = ids(sc);

  // ── The road, measured exactly as applyOptimize measures it ──
  const written: Array<Record<string, unknown>> = [];
  setAdmin(fakeAdmin(sc, written));
  const net = await withRouter(sc, () => refreshRoadLegs(id.org, sc.day));
  setAdmin(null);

  const stepOf = (tags: Tags, name: string) => {
    const s = (tags.steps ?? []).find((x) => x.step === name);
    return {
      ok: Boolean(s?.ok),
      err: s?.err ?? (s ? null : "step did not run"),
      ms: Number(s?.ms ?? NaN),
      rows: s?.payload ?? [],
    };
  };

  // ── The planner ──
  let tags: Tags;
  let stderr: string;
  let forecast: ReturnType<typeof stepOf>;
  let apply: ReturnType<typeof stepOf>;
  let ts: TrialResult["ts"] = null;
  if (planner === "sql") {
    ({ tags, stderr } = runSql(buildSql(sc, written, { kind: "sql" })));
    forecast = stepOf(tags, "forecast");
    apply = stepOf(tags, "apply");
  } else {
    // Read, solve here, write: route_day_inputs, planDay, apply_route_plan.
    const read = runSql(buildSql(sc, written, { kind: "inputs" }));
    const inputsStep = stepOf(read.tags, "inputs");
    const inputs = (inputsStep.rows[0] as { j?: RouteDayInputs } | undefined)?.j;
    let plan: DayPlan | null = null;
    let solveMs = 0;
    let honourWindows = true;
    if (inputs) {
      honourWindows = inputs.org.route_windows !== "ignore";
      const t0 = performance.now();
      plan = planDay(inputs, { day: sc.day, honourWindows, solver: TRIAL_SOLVER });
      solveMs = performance.now() - t0;
    }
    ({ tags, stderr } = plan
      ? runSql(
          buildSql(sc, written, {
            kind: "apply",
            routes: plan.routes,
            honourWindows,
            unassigned: plan.unassigned.map((u) => u.visit_id),
          }),
        )
      : { tags: {} as Tags, stderr: read.stderr });
    stderr = `${read.stderr}${stderr}`;
    apply = stepOf(tags, "apply");
    const out = (apply.rows[0] as { j?: { staff?: StepPayloadRow[]; misses?: unknown[] } })?.j;
    // The forecast IS the write now: what apply_route_plan reports, after the
    // road was measured. The SQL planner's forecast ran before it.
    forecast = {
      ...inputsStep,
      rows: (out?.staff ?? []).map((r) => ({ ...r, violations: Number(r.late ?? 0) })),
    };
    if (!plan && inputsStep.ok) forecast = { ...forecast, ok: false, err: "no inputs came back" };
    ts = {
      inputsMs: inputsStep.ms,
      solveMs,
      applyMs: apply.ms,
      solver: plan
        ? {
            rounds: plan.solution.rounds,
            stoppedBy: plan.solution.stoppedBy,
            objective: plan.solution.objective,
          }
        : null,
      honourWindows,
      misses: (out?.misses ?? []) as TsMiss[],
      unassigned: (plan?.unassigned ?? []).map((u) => ({
        key: sc.stops.find((st) => id.visit(st) === u.visit_id)?.key ?? u.visit_id,
        reason: u.reason,
      })),
      inputs: inputs ?? null,
    };
  }

  const stopById = new Map(sc.stops.map((st) => [id.visit(st), st]));
  const techById = new Map(sc.techs.map((t) => [id.staff(t), t]));
  const visits: VisitOut[] = (tags.visits ?? []).map((v) => {
    const st = stopById.get(v.id)!;
    return {
      key: st.key,
      name: st.name,
      stop: st,
      staffKey: v.staff ? (techById.get(v.staff)?.key ?? "?") : null,
      seq: v.seq,
      etaStart: v.etaStart,
      etaEnd: v.etaEnd,
      travelMin: v.travelMin == null ? null : Number(v.travelMin),
      travelKm: v.travelKm == null ? null : Number(v.travelKm),
      violated: Boolean(v.violated),
      storedLat: v.lat ?? null,
      storedLon: v.lon ?? null,
    };
  });

  // ── Cost matrices ──
  const nodes: Array<{ k: string; lat: number | null; lon: number | null }> = tags.nodes ?? [];
  const nodeIndex = new Map(nodes.map((nd, i) => [nd.k, i]));
  const rawMatrix: (number | null)[][] = tags.matrix ?? [];
  // What the planner itself sees: an unknown leg costs nothing (plan_visits
  // COALESCEs it to 0). Kept that way on purpose -- this is ITS view.
  const plannerM: M.Matrix = rawMatrix.map((r) => r.map((x) => (x == null ? 0 : Number(x))));
  const truth = roadTruth(sc.fixture);
  const coordOf = (i: number): [number, number] | null =>
    nodes[i]?.lat == null || nodes[i]?.lon == null
      ? null
      : [Number(nodes[i].lat), Number(nodes[i].lon)];
  const roadM: (number | null)[][] = nodes.map((_, i) =>
    nodes.map((__, j) => (i === j ? 0 : truth(coordOf(i), coordOf(j)))),
  );
  const roadComplete = (from: number, order: number[]) => {
    let at = from;
    for (const i of order) {
      if (roadM[at][i] == null) return false;
      at = i;
    }
    return true;
  };
  const roadCost = (from: number, order: number[]) =>
    roadComplete(from, order) ? M.pathCost(roadM as M.Matrix, from, order) : null;

  // The TypeScript drive model against drive_minutes, every pair. The solver
  // orders the day on the first and Postgres times it with the second.
  let modelMismatch: number | null = null;
  if (ts?.inputs) {
    const model = driveModel(ts.inputs);
    modelMismatch = 0;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = 0; j < nodes.length; j++) {
        if (i === j) continue;
        const sqlV = rawMatrix[i]?.[j];
        const tsV = model(coordOf(i), coordOf(j));
        if (sqlV == null || tsV == null) {
          if ((sqlV == null) !== (tsV == null)) modelMismatch = Infinity;
          continue;
        }
        modelMismatch = Math.max(modelMismatch, Math.abs(Number(sqlV) - tsV));
      }
    }
  }

  // ── Per technician ──
  const workStart = toMin(sc.org.workdayStart ?? "08:00");
  const workEnd = toMin(sc.org.workdayEnd ?? "17:00");
  const starts: Record<string, { lat: number | null; lon: number | null; source: string }> =
    tags.starts ?? {};
  const eligibleKeys = new Set(
    sc.techs
      .filter((t) => t.selected !== false && t.isFieldTech !== false && !t.offToday)
      .map((t) => t.key),
  );
  const techs: TechOut[] = sc.techs.map((t) => {
    const mine = visits
      .filter((v) => v.staffKey === t.key)
      .sort((a, b) => (a.seq ?? 1e9) - (b.seq ?? 1e9));
    const driveMin = mine.reduce((s, v) => s + (v.travelMin ?? 0), 0);
    const serviceMin = mine.reduce((s, v) => s + (v.stop.serviceMin ?? 8), 0);
    const last = mine[mine.length - 1];
    const endMin = last?.etaEnd ? orgLocalMinutes(last.etaEnd, sc.org.tz) : null;
    const endDay = last?.etaEnd ? orgLocalDay(last.etaEnd, sc.org.tz) : null;
    // Past midnight is past the end of the day by however far it went.
    const endAbs = endMin == null ? null : endMin + (endDay && endDay > sc.day ? 1440 : 0);
    const from = nodeIndex.get(`start:${id.staff(t)}`) ?? -1;
    // Orders are compared over the stops that HAVE a location. A stop with
    // none costs zero to reach in the planner's own matrix, so any baseline
    // allowed to use it would "win" by teleporting through it.
    const located = mine.filter((v) => v.stop.lat != null && v.stop.lon != null);
    const idx = located
      .map((v) => nodeIndex.get(`visit:${id.visit(v.stop)}`)!)
      .filter((i) => i != null);
    const usable = from >= 0 && idx.length === located.length && located.length > 0;
    const good = usable ? M.goodOrder(plannerM, from, idx) : null;
    const routed = mine.filter((v) => v.stop.lat != null && v.stop.lon != null);
    const sp = starts[id.staff(t)];
    const line: Array<[number, number]> = [
      ...(sp?.lat != null && sp?.lon != null
        ? [[Number(sp.lat), Number(sp.lon)] as [number, number]]
        : []),
      ...routed.map((v) => [v.stop.lat!, v.stop.lon!] as [number, number]),
    ];
    const sides = routed.map((v) => v.stop.side).filter(Boolean) as string[];
    const goodRoadOrder =
      usable && roadComplete(from, idx) ? M.goodOrder(roadM as M.Matrix, from, idx) : null;
    const goodRoad = goodRoadOrder ? M.pathCost(roadM as M.Matrix, from, goodRoadOrder) : null;
    const coordOfNode = new Map(
      located.map((v, i) => [idx[i], [v.stop.lat!, v.stop.lon!] as [number, number]]),
    );
    return {
      key: t.key,
      name: t.name,
      eligible: eligibleKeys.has(t.key),
      startSource: sp?.source ?? null,
      stops: mine,
      driveMin,
      serviceMin,
      dayMin: endAbs == null ? 0 : endAbs - workStart,
      endLocal: endAbs == null ? null : hhmm(endAbs),
      overtimeMin: endAbs == null ? 0 : Math.max(0, endAbs - workEnd),
      overCapacityMin: Math.max(0, driveMin + serviceMin - (t.capacityMin ?? 480)),
      crossings: M.selfCrossings(line),
      sideChanges: sides.length ? M.sideChanges(sides) : undefined,
      plannerCost: usable ? M.pathCost(plannerM, from, idx) : null,
      nnCost: usable ? M.pathCost(plannerM, from, M.nearestNeighbour(plannerM, from, idx)) : null,
      goodCost: good ? M.pathCost(plannerM, from, good) : null,
      roadCost: usable ? roadCost(from, idx) : null,
      goodRoadCost: goodRoad,
      route: {
        start: sp?.lat != null && sp?.lon != null ? [Number(sp.lat), Number(sp.lon)] : null,
        planner: located.map((v) => [v.stop.lat!, v.stop.lon!] as [number, number]),
        osrmBest: goodRoadOrder ? goodRoadOrder.map((n) => coordOfNode.get(n)!) : null,
      },
    };
  });

  // ── Checks ──
  const unassigned = visits.filter((v) => !v.staffKey).map((v) => v.key);
  const onIneligible = visits
    .filter((v) => v.staffKey && !eligibleKeys.has(v.staffKey))
    .map((v) => `${v.key}->${v.staffKey}`);
  const seqBroken = techs
    .filter((t) => t.eligible && t.stops.length)
    .filter((t) => t.stops.some((v, i) => v.seq !== i + 1))
    .map((t) => t.key);
  const nonFinite = visits
    .filter((v) => v.staffKey && eligibleKeys.has(v.staffKey))
    .filter((v) => !Number.isFinite(v.travelMin) || !Number.isFinite(v.travelKm) || !v.etaStart)
    .map((v) => v.key);

  // The ETA chain, recomputed independently in TypeScript: the day starts at
  // the org's wall-clock workday start IN THE ORG'S ZONE (route-window.ts's
  // zonedTimeToUtc, not SQL's AT TIME ZONE), each arrival is the previous
  // departure plus the rounded leg, and the only permitted extra wait is for
  // an earliest-arrival window.
  const etaChainBroken: string[] = [];
  for (const t of techs.filter((x) => x.eligible)) {
    let clock = zonedTimeToUtc(sc.day, sc.org.workdayStart ?? "08:00", sc.org.tz).getTime();
    for (const v of t.stops) {
      if (!v.etaStart || !v.etaEnd) {
        etaChainBroken.push(`${v.key}: no ETA`);
        break;
      }
      const es = new Date(v.etaStart).getTime();
      const expected = clock + Math.round(v.travelMin ?? 0) * 60_000;
      const earliest = v.stop.window?.earliest
        ? zonedTimeToUtc(sc.day, v.stop.window.earliest, sc.org.tz).getTime()
        : null;
      // travel_min is stored to one decimal (numeric(6,1)) while the clock
      // advanced by the unrounded leg, so a leg of 13.46 is stored as 13.5 and
      // driven as 13: one minute either way is rounding, not a wrong clock.
      const near = (a: number, b: number) => Math.abs(a - b) <= 60_000;
      const ok =
        near(es, expected) || (earliest != null && es === earliest && earliest > expected - 60_000);
      if (!ok) {
        etaChainBroken.push(
          `${t.key}/${v.key}: arrives ${new Date(es).toISOString()}, expected ${new Date(expected).toISOString()} (leg ${v.travelMin})`,
        );
        break;
      }
      const ee = new Date(v.etaEnd).getTime();
      if (ee !== es + (v.stop.serviceMin ?? 8) * 60_000) {
        etaChainBroken.push(`${t.key}/${v.key}: service time is not the property's duration`);
        break;
      }
      clock = ee;
    }
  }
  const offDay = visits
    .filter((v) => v.etaStart && orgLocalDay(v.etaStart, sc.org.tz) !== sc.day)
    .map((v) => `${v.key} (${orgLocalDay(v.etaStart!, sc.org.tz)})`);

  const windowTruth = visits
    .filter((v) => v.stop.window?.latest && v.etaStart)
    .map((v) => {
      const arr = orgLocalMinutes(v.etaStart, sc.org.tz)!;
      return {
        key: v.key,
        arrivalLocal: hhmm(arr),
        latest: v.stop.window!.latest!,
        missed: arr > toMin(v.stop.window!.latest!),
        flagged: v.violated,
      };
    });

  const boardWarnings = findRouteWarnings(
    visits.map((v) => ({
      id: v.key,
      clientName: v.name,
      travel_km: v.travelKm,
      travel_min: v.travelMin,
      eta_start: v.etaStart,
      scheduled_on: sc.day,
    })),
    { maxDriveMinutes: 240, workdayStartMinutes: workStart, timezone: sc.org.tz },
  ).map((w) => ({ key: w.visitId, reason: w.reason, message: w.message }));

  const totals = techs.filter((t) => t.eligible).map((t) => t.driveMin + t.serviceMin);
  const balanceSpreadMin = totals.length > 1 ? Math.max(...totals) - Math.min(...totals) : 0;

  // A stop with no coordinates costs nothing to reach and nothing to leave,
  // so the planner can park it between two far-apart stops and make the leg
  // between them vanish from the total. Measure what that hid.
  const teleports: Array<{ key: string; hiddenMin: number }> = [];
  for (const t of techs) {
    const seqd = t.stops;
    for (let i = 0; i < seqd.length; i++) {
      const v = seqd[i];
      if (v.stop.lat != null && v.stop.lon != null) continue;
      const prevNode =
        i === 0
          ? nodeIndex.get(`start:${id.staff(sc.techs.find((x) => x.key === t.key)!)}`)
          : nodeIndex.get(`visit:${id.visit(seqd[i - 1].stop)}`);
      const next = seqd[i + 1];
      if (prevNode == null || !next) continue;
      const nextNode = nodeIndex.get(`visit:${id.visit(next.stop)}`)!;
      const direct = rawMatrix[prevNode]?.[nextNode];
      if (direct != null)
        teleports.push({
          key: v.key,
          hiddenMin: Number(direct) - (next.travelMin ?? 0) - (v.travelMin ?? 0),
        });
    }
  }

  return {
    sc,
    planner,
    ts,
    modelMismatch,
    legResult: net.value,
    legsWritten: written.length,
    osrmRequests: net.requests,
    fixtureMisses: net.misses,
    recorded: net.recorded,
    forecast,
    apply,
    visits,
    techs,
    profile: tags.profile ?? { speed: null, factor: null, legs: null },
    checks: {
      unassigned,
      onIneligible,
      seqBroken,
      nonFinite,
      etaChainBroken,
      offDay,
      windowTruth,
      forecastViolations: forecast.rows.reduce((s, r) => s + Number(r.violations ?? 0), 0),
      appliedViolations: visits.filter((v) => v.violated).length,
      boardWarnings,
      interleave: M.interleave(
        visits
          .filter((v) => v.stop.lat != null && v.stop.lon != null)
          .map((v) => ({ at: [v.stop.lat!, v.stop.lon!] as [number, number], tech: v.staffKey })),
      ),
      balanceSpreadMin,
      teleports,
      fit: measureDayFit(
        visits.map((v) => ({
          staffId: v.staffKey,
          day: sc.day,
          etaEnd: v.etaEnd,
          travelMin: v.travelMin,
          serviceMin: v.stop.serviceMin ?? 8,
          latitude: v.storedLat,
          longitude: v.storedLon,
        })),
        {
          timezone: sc.org.tz,
          workdayEnd: sc.org.workdayEnd ?? "17:00",
          capacityByStaff: Object.fromEntries(sc.techs.map((t) => [t.key, t.capacityMin])),
        },
      ),
    },
    stderr,
  };
}
