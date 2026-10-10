// Auto-routing: one button, and since 2026-10-04 a run that outlives the panel.
//
// ── ONE BUTTON ──────────────────────────────────────────────────────────────
//
// There used to be two presses. Preview measured the day, showed a headline,
// and only then did Apply light up. QA on 2026-08-19: "Also remove the
// preview, let's just have apply." So the STEP is gone: the dispatcher picks
// the days and the people, and presses one button.
//
// ── THE SEARCH RUNS HERE, NOT IN POSTGRES (2026-10) ───────────────────────
//
// Each day is read and solved (route-plan.server.ts): route_day_inputs reads
// everything the planner may know, and the solver (route-solver.ts) searches
// in this process inside a time budget. plan_day_across_staff did that inside
// one statement and took 7-23 seconds on a 200-stop day against the API's
// 8-second limit; see 20261002090700.
//
// What the panel shows afterwards comes from the write itself, which is
// better than what it had: the old forecast was a dry run taken BEFORE the
// road was measured, so on a brand-new area its window count could differ
// from the plan applied (#294). Now the count is the plan applied.
//
// ── AND IT CAN BE SENT TO THE BACKGROUND (2026-10-04) ─────────────────────
//
// The owner: "When utilizing the auto-routing and it takes a while, allow it
// to be dismissed to run in a background." This file used to be the body of
// applyOptimize, one server function the panel awaited, writing each day as
// it went. Three things changed, and each is here for a reason:
//
//   * A run is a ROW (routing_runs). startAndRunAutoRouting records it before
//     any work, moves its stage along (road times, optimizing, saving) and
//     finishes it with the result, so the panel can be closed, the page left
//     and the app reopened, and the run can still be found. One active run per
//     organization; a second press ATTACHES to the first.
//
//   * The write is ONE TRANSACTION at the end (apply_route_plans), not one per
//     day as each was solved. A run cut off before it finishes has written
//     nothing, rather than the days before the cut.
//
//   * The work is handed to the Worker's waitUntil as well as awaited. While
//     the browser is connected, the request stays open for as long as the run
//     takes, which is exactly how long it was open before. If the browser
//     goes (the app closed, the phone locked), waitUntil keeps the run alive
//     for up to Cloudflare's post-response limit (30 s). A run that still
//     cannot finish in that time is declared abandoned after three silent
//     minutes, and because the write is last, abandoned means unchanged.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { RoadLegProblem } from "@/lib/road-legs.server";
import { DEFAULT_ORG_TIMEZONE } from "@/lib/org-day";
import { measureDayFit } from "@/lib/route-day-fit";
import { applyRoutePlans, planDayRoutes, type DayPlan } from "@/lib/route-plan.server";
import { LEVELS, shouldPushWhenDone, type RunStage } from "@/lib/routing-run";
import { visitServiceMinutes } from "@/lib/visit-service";

/** The search budget for one day, by level, before it is shared out across a
 *  multi-day run. "thorough" is what the panel sends. */
const DAY_BUDGET_MS = { fast: 300, balanced: 1200, thorough: 2500 } as const;
/** And for a whole run: a 92-day range gets a short search per day rather
 *  than four minutes of waiting. */
const RUN_BUDGET_MS = 25_000;
const MIN_DAY_BUDGET_MS = 250;

export type AutoRouteInput = {
  staffIds: string[];
  from: string;
  to: string;
  level: (typeof LEVELS)[number];
  reassign: boolean;
  windows: "org" | "honour" | "ignore";
};

export type WindowMissOut = {
  day: string;
  staffId: string;
  client: string | null;
  kind: "late" | "early";
  etaStart: string;
  earliest: string | null;
  latest: string | null;
};

/** False when the run is no longer this job's to move (finished elsewhere,
 *  declared abandoned). The job stops and writes nothing. */
export type ReportProgress = (stage: RunStage, daysDone: number) => Promise<boolean>;

export class RunStopped extends Error {
  constructor() {
    super("This auto-routing run was stopped before it finished, so nothing was changed.");
    this.name = "RunStopped";
  }
}

/** The days a run covers, from and to inclusive. */
export function daysOf(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = new Date(`${from}T12:00:00`); ; d.setDate(d.getDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if (iso > to) break;
    days.push(iso);
  }
  return days;
}

/**
 * Read and solve every day, then write the whole run at once.
 *
 * Every day is read and solved before anything is written, and the write is
 * apply_route_plans: one transaction. A run that stops before it has changed
 * nothing; a day refused at either step is reported and the other days still
 * run, which is what a refused day has always meant.
 */
export async function runAutoRouting(
  supabase: SupabaseClient<Database>,
  args: {
    orgId: string;
    runId: string;
    data: AutoRouteInput;
    progress: ReportProgress;
    /** Who pressed Apply: the techs whose day changed are told, not them. */
    actorUserId?: string | null;
  },
) {
  const { orgId, runId, data, progress } = args;
  const days = daysOf(data.from, data.to);
  const dayBudget = Math.max(
    MIN_DAY_BUDGET_MS,
    Math.min(DAY_BUDGET_MS[data.level], Math.floor(RUN_BUDGET_MS / days.length)),
  );
  const honourWindows = data.windows === "honour" ? true : data.windows === "ignore" ? false : null;

  let stops = 0;
  const skipped: Array<{ staffId: string; day: string; reason: string }> = [];
  // Days planned from straight-line estimates because nothing could be
  // measured, and days where only some points were measurable. Kept apart
  // because they are different sentences: one day is wrong throughout, the
  // other is wrong in places.
  const estimatedDays: Array<{ day: string; problem: RoadLegProblem }> = [];
  const partlyEstimatedDays: Array<{ day: string; points: number }> = [];
  const perStaff = new Map<string, { stops: number; totalMin: number }>();
  // What the old read-only forecast reported, now read off the write.
  let techDays = 0;
  let techDaysMeasured = 0;
  let savedMin = 0;
  let violations = 0;
  const windowMisses: WindowMissOut[] = [];
  // Whether arrival windows were honoured on the days planned (the
  // organization's setting, unless this run overrode it).
  let windowsHonoured: boolean | null = honourWindows;

  const plans: DayPlan[] = [];
  let solved = 0;
  for (const day of days) {
    if (!(await progress("road_times", solved))) throw new RunStopped();
    // Measure the real road legs for this day before planning it. Best
    // effort on purpose: anything unmeasured is priced by the estimate, and
    // a dispatcher whose routing engine is down still gets a plan. It is a
    // cache warm, not a dependency -- but it is not SILENT: a day planned
    // from estimates is reported, by reason, because a solver minimising
    // the wrong quantity picks the wrong ORDER (road-legs.server.ts).
    try {
      const { refreshRoadLegs } = await import("@/lib/road-legs.server");
      const legs = await refreshRoadLegs(orgId, day);
      if (legs.problem) estimatedDays.push({ day, problem: legs.problem });
      else if (legs.pointsOutsideGraph > 0)
        partlyEstimatedDays.push({ day, points: legs.pointsOutsideGraph });
    } catch (err) {
      // A throw here is not one of refreshRoadLegs' own answers -- it returns
      // its failures. This is the import or something below it, and the day
      // is on estimates either way, so it is reported as an outage rather
      // than left out of the count.
      estimatedDays.push({ day, problem: "router_unreachable" });
      console.error("road leg refresh failed for", day, (err as Error).message);
    }

    if (!(await progress("optimizing", solved))) throw new RunStopped();
    try {
      plans.push(
        await planDayRoutes(supabase, {
          orgId,
          staffIds: data.staffIds,
          day,
          reassign: data.reassign,
          honourWindows,
          timeLimitMs: data.level === "fast" ? DAY_BUDGET_MS.fast : dayBudget,
          rounds: data.level === "fast" ? 0 : undefined,
        }),
      );
    } catch (err) {
      // A day that could not be planned must not abandon the other twenty.
      // Collected and reported, not swallowed — silently skipping is how a
      // dispatcher ends up believing a day was optimized when it was
      // refused. staffId is empty because the refusal is about the DAY: the
      // planner considers the whole team at once.
      skipped.push({ staffId: "", day, reason: `${day}: ${(err as Error).message}` });
      continue;
    } finally {
      solved++;
    }
  }

  // ── THE WRITE ────────────────────────────────────────────────────────
  //
  // Every solved day at once, in one transaction. Throws (and writes
  // nothing) if the run was declared abandoned meanwhile or the statement
  // ran out of time; a day apply_route_plan refuses comes back on its own.
  if (!(await progress("saving", solved))) throw new RunStopped();
  // A plan applied to today or tomorrow rewrites those routes: each tech
  // whose stops or order changed hears it once, as a summary, and the person
  // who pressed Apply does not (field-notify.server.ts). Days further out are
  // not watched, so a quarter's plan costs the same two snapshots as a day's.
  // Taken immediately before the write, so "before" is the day the write
  // actually replaced, not the one that stood when the run began.
  const { startRouteWatch } = await import("@/lib/field-notify.server");
  const watch = await startRouteWatch({
    actorUserId: args.actorUserId ?? null,
    orgId,
    staffIds: data.staffIds,
  });
  const written = await applyRoutePlans(supabase, { runId, reassign: data.reassign, plans });
  // Only after a write that committed: a refused write changed nobody's day.
  await watch.finish();
  const planOf = new Map(plans.map((p) => [p.day, p]));

  for (const w of written) {
    const day = w.day;
    if (!w.ok) {
      // Refused at the write: "the day changed while it was being planned"
      // is the usual one. Reported in the same list, in the same words.
      skipped.push({ staffId: "", day, reason: `${day}: ${w.error}` });
      continue;
    }
    const plan = planOf.get(day);
    if (plan) windowsHonoured = plan.honourWindows;

    const before = new Map((plan?.before ?? []).map((b) => [b.staffId, b]));
    for (const r of w.rows) {
      stops += r.stops;
      violations += r.late;
      const prev = perStaff.get(r.staff_id) ?? { stops: 0, totalMin: 0 };
      perStaff.set(r.staff_id, {
        stops: prev.stops + r.stops,
        totalMin: prev.totalMin + r.total_min,
      });
      if (r.stops === 0) continue;
      techDays++;
      // Saving is summed ONLY over technician-days that had a real route
      // to compare against. A day whose stops carried no sequence is not a
      // slower route, it is no route — counting it would inflate the
      // headline with the entire cost of a day nobody had planned yet.
      const b = before.get(r.staff_id);
      if (b?.sequenced) {
        techDaysMeasured++;
        savedMin += b.minutes - r.travel_min;
      }
    }
    for (const m of w.misses) {
      windowMisses.push({
        day,
        staffId: m.staff_id,
        client: m.client,
        kind: m.kind,
        etaStart: m.eta_start,
        earliest: m.earliest,
        latest: m.latest,
      });
    }
  }

  // Any of these techs whose route for a day this run wrote is on a lock
  // screen gets the new order (push-liveactivity.server.ts); nobody else
  // costs more than a lookup. After the write has committed, and only for the
  // days it wrote, so a lock screen never shows a plan that did not land.
  // Every selected tech, not just those who ended up with stops: a tech the
  // run took stops AWAY from has a changed route too. Never throws.
  {
    const wroteDays = written.filter((w) => w.ok).map((w) => w.day);
    if (wroteDays.length) {
      const { refreshRouteLiveActivities } = await import("@/lib/push-liveactivity.server");
      await refreshRouteLiveActivities(
        wroteDays.flatMap((day) => data.staffIds.map((staffId) => ({ staffId, day }))),
      );
    }
  }

  // The split itself, so the screen can show that the work was actually
  // divided. Without this the dispatcher has to go and count rows to find
  // out whether the thing they just pressed did anything.
  const balance = [...perStaff.entries()]
    .map(([staffId, v]) => ({ staffId, stops: v.stops, totalMin: Math.round(v.totalMin) }))
    .sort((a, b) => b.totalMin - a.totalMin);

  // The same five numbers the read-only forecast used to carry, so the
  // panel's sentences did not have to change. Null only when every day was
  // refused: then there is nothing to report, and "nothing to route" would
  // be the wrong sentence.
  const forecast =
    skipped.length === days.length
      ? null
      : {
          stops,
          daysPlanned: techDays,
          daysMeasured: techDaysMeasured,
          // Rounded once, at the end. Rounding per day and summing drifts.
          savedMin: Math.round(savedMin * 10) / 10,
          violations,
        };

  // ── DOES WHAT WAS WRITTEN FIT THE DAY? ──────────────────────────────
  //
  // The planner plans a day with more work than hours rather than refuse
  // it -- the routing trials planned one technician to 02:51 the next
  // morning and reported only "Routed 40 stops". Planning it is right; not
  // saying so is not. Read back after the write, because the ETAs only
  // exist then.
  //
  // Best effort: a failed read must never undo or block the routing the
  // dispatcher asked for, so it degrades to null.
  let fit: ReturnType<typeof measureDayFit> | null = null;
  try {
    const [{ data: org }, { data: crew }, { data: planned, error: plannedError }] =
      await Promise.all([
        supabase
          .from("organizations")
          .select("timezone, workday_end")
          .eq("id", orgId)
          .maybeSingle(),
        supabase.from("staff").select("id, daily_capacity_minutes").in("id", data.staffIds),
        supabase
          .from("visits")
          .select(
            "assigned_staff_id, scheduled_on, eta_end, travel_min, properties(latitude, longitude, service_duration_min), services(default_duration_min)",
          )
          .eq("organization_id", orgId)
          .eq("status", "scheduled")
          .gte("scheduled_on", data.from)
          .lte("scheduled_on", data.to)
          .in("assigned_staff_id", data.staffIds),
      ]);
    if (plannedError) throw plannedError;
    fit = measureDayFit(
      (planned ?? []).map((v) => ({
        staffId: v.assigned_staff_id,
        day: v.scheduled_on,
        etaEnd: v.eta_end,
        travelMin: v.travel_min == null ? null : Number(v.travel_min),
        // The planner's own rule (stop_service_min): the service's minutes,
        // else the yard's. A walk is as long as the walk.
        serviceMin: visitServiceMinutes(
          v.services?.default_duration_min,
          v.properties?.service_duration_min,
        ),
        latitude: v.properties?.latitude ?? null,
        longitude: v.properties?.longitude ?? null,
      })),
      {
        timezone: org?.timezone || DEFAULT_ORG_TIMEZONE,
        workdayEnd: org?.workday_end ?? null,
        capacityByStaff: Object.fromEntries(
          (crew ?? []).map((s) => [s.id, s.daily_capacity_minutes]),
        ),
      },
    );
  } catch (err) {
    console.error("day-fit check failed", (err as Error).message);
    fit = null;
  }

  return {
    stops,
    skipped,
    balance,
    forecast,
    estimatedDays,
    partlyEstimatedDays,
    fit,
    windowsHonoured,
    // Capped: a 92-day run with windows set aside could miss hundreds, and
    // the panel names a handful and counts the rest.
    windowMisses: windowMisses.slice(0, 50),
    windowMissCount: windowMisses.length,
  };
}

export type AutoRouteResult = Awaited<ReturnType<typeof runAutoRouting>>;

// ── THE RUN, START TO FINISH ──────────────────────────────────────────────

type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

export type StartOutcome =
  | { runId: string; attached: true; fromDay: string; toDay: string; mine: boolean }
  | { runId: string; attached: false; status: "succeeded"; result: AutoRouteResult }
  | { runId: string; attached: false; status: "failed"; error: string };

export type Notify = (
  userIds: string[],
  n: {
    orgId: string;
    type: string;
    title: string;
    body?: string | null;
    link?: string | null;
    threadId?: string | null;
    collapseId?: string | null;
  },
) => Promise<unknown>;

/** "Oct 5" or "Oct 5 to Oct 9", for a push someone reads on a lock screen. */
function rangeLabel(from: string, to: string): string {
  const fmt = (iso: string) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  return from === to ? fmt(from) : `${fmt(from)} to ${fmt(to)}`;
}

/** Where the push lands: /routes, with the review opened. */
export const REVIEW_LINK = "/routes?autoroute=review";

/**
 * Record the run, or attach to the organization's active one; then do the
 * work, finish the row, and push to the person who pressed Apply if they are
 * no longer looking.
 *
 * `keepAlive` is the Worker's waitUntil (see the server function). It is
 * handed the job BEFORE it is awaited, so a browser that disconnects mid-run
 * does not take the run with it.
 */
export async function startAndRunAutoRouting(deps: {
  supabase: SupabaseClient<Database>;
  userId: string;
  orgId: string;
  runId: string;
  data: AutoRouteInput;
  keepAlive: (job: Promise<unknown>) => void;
  notify: Notify;
  now?: () => number;
  run?: typeof runAutoRouting;
}): Promise<StartOutcome> {
  const { supabase, userId, orgId, runId, data, keepAlive, notify } = deps;
  const now = deps.now ?? Date.now;
  const run = deps.run ?? runAutoRouting;
  // Untyped until types.ts is regenerated from a database with these
  // functions; their shapes are the migration's and the proof's.
  const rpc: Rpc = async (fn, args) => {
    const { data: out, error } = await (supabase as unknown as SupabaseClient).rpc(fn, args);
    return { data: out, error };
  };

  const { data: started, error: startError } = await rpc("start_routing_run", {
    _id: runId,
    _org_id: orgId,
    _from: data.from,
    _to: data.to,
    _staff_ids: data.staffIds,
    _windows: data.windows,
  });
  if (startError) throw new Error(startError.message);
  const s = started as {
    run_id: string;
    attached: boolean;
    from_day?: string;
    to_day?: string;
    mine?: boolean;
  };
  if (s.attached) {
    return {
      runId: s.run_id,
      attached: true,
      fromDay: s.from_day ?? data.from,
      toDay: s.to_day ?? data.to,
      mine: Boolean(s.mine),
    };
  }

  const finish = async (status: "succeeded" | "failed", result: unknown, error: string | null) => {
    const { data: fin, error: finError } = await rpc("finish_routing_run", {
      _id: runId,
      _status: status,
      _result: result ?? null,
      _error: error,
    });
    if (finError) {
      console.error("finishing the routing run failed", finError.message);
      return null;
    }
    return fin as { finished: boolean; watched_at: string | null; applied_at: string | null };
  };

  const pushIfAway = async (
    fin: { finished: boolean; watched_at: string | null } | null,
    n: { type: string; title: string; body: string },
  ) => {
    if (!fin?.finished || !shouldPushWhenDone(fin.watched_at, now())) return;
    try {
      await notify([userId], {
        orgId,
        ...n,
        link: REVIEW_LINK,
        // One thread for the organization's auto-routing on the lock screen,
        // and one notification per run: a run that failed and was then
        // reported again replaces itself rather than stacking.
        threadId: `routing:${orgId}`,
        collapseId: `routing-run:${runId}`,
      });
    } catch (err) {
      console.error("routing push failed", (err as Error).message);
    }
  };

  const job = (async (): Promise<StartOutcome> => {
    try {
      const result = await run(supabase, {
        orgId,
        runId,
        data,
        actorUserId: userId,
        progress: async (stage, daysDone) => {
          const { data: ok, error } = await rpc("routing_run_progress", {
            _id: runId,
            _stage: stage,
            _days_done: daysDone,
          });
          // A heartbeat that could not be written is not a reason to throw
          // away a run that is otherwise fine; a heartbeat the database
          // REFUSED (false) means the run is not ours any more.
          if (error) {
            console.error("routing heartbeat failed", error.message);
            return true;
          }
          return ok !== false;
        },
      });
      const fin = await finish("succeeded", result, null);
      await pushIfAway(fin, {
        type: "routing_ready",
        title: "Routes ready",
        body:
          result.forecast && result.forecast.daysPlanned > 0
            ? `${rangeLabel(data.from, data.to)}: ${result.stops} stop${result.stops === 1 ? "" : "s"} routed. Tap to review.`
            : `${rangeLabel(data.from, data.to)}: finished, with nothing to change. Tap to see why.`,
      });
      return { runId, attached: false, status: "succeeded", result };
    } catch (err) {
      const message = (err as Error).message || "Auto-routing failed.";
      const fin = await finish("failed", null, message);
      await pushIfAway(fin, {
        type: "routing_failed",
        title: "Auto-routing did not finish",
        // Said only when it is true: a run that fails AFTER its write
        // committed (the summary could not be built or recorded) did change
        // the routes, and the board shows them.
        body: fin?.applied_at
          ? `${rangeLabel(data.from, data.to)}: the routes were saved, but the summary was lost. Check the board.`
          : `${rangeLabel(data.from, data.to)}: nothing was changed. Tap to see why.`,
      });
      return { runId, attached: false, status: "failed", error: message };
    }
  })();

  keepAlive(job);
  return job;
}
