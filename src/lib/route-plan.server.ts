// Auto-routing, in two halves: read and solve each day, then write the run.
//
// Each day is read (route_day_inputs, one statement) and solved (the solver,
// TypeScript, in this process, inside a time budget). None of that is the
// search inside Postgres, so none of it is anywhere near the API's 8-second
// limit on a 200-stop day -- the reason this exists. See route-solver.ts.
//
// ── AND SINCE 2026-10-04 THE WRITE IS ONE STATEMENT FOR THE WHOLE RUN ──────
//
// Until then each day was written as soon as it was solved (planAndApplyDay),
// so a run that was cut off -- the app closed, the Worker gone -- left the
// days before the cut rearranged and the days after it not, and nobody was
// told which. Auto-routing can now be sent to the background, which makes
// "cut off part-way" an ordinary event rather than an accident, so the write
// moved to the end: apply_route_plans takes every day's order at once and
// calls apply_route_plan for each inside one transaction
// (20261004160000_routing-runs-in-the-background). Nothing is written until
// every day is solved, and then all of it is, or none.
//
// Called as the signed-in user, with their client: route_day_inputs,
// apply_route_plan and apply_route_plans all check can_write_org themselves.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import { planDay, type RouteDayInputs, type UnassignedVisit } from "@/lib/route-inputs";
import { readWalkGroupAssignments } from "@/lib/walk-group-routing.server";

export type DaySummaryRow = {
  staff_id: string;
  stops: number;
  service_min: number;
  travel_min: number;
  total_min: number;
  late: number;
};

export type WindowMiss = {
  visit_id: string;
  staff_id: string;
  client: string | null;
  kind: "late" | "early";
  eta_start: string;
  earliest: string | null;
  latest: string | null;
};

/** One day, solved and not yet written. */
export type DayPlan = {
  day: string;
  routes: Array<{ staff_id: string; visit_ids: string[] }>;
  /** Visits the solver could not place: no eligible technician, or a window
   *  no route keeps. Handed to the write so the day still checks out, and
   *  named to the dispatcher afterwards (20261010200000). */
  unassigned: UnassignedVisit[];
  honourWindows: boolean;
  /** Each technician's route before this run, from route_cost_current. */
  before: Array<{ staffId: string; minutes: number; sequenced: boolean }>;
  solver: { ms: number; rounds: number; stoppedBy: string; stops: number };
};

/** One day as apply_route_plans wrote it, or why it refused that day. */
export type DayWritten =
  | { day: string; ok: true; rows: DaySummaryRow[]; misses: WindowMiss[] }
  | { day: string; ok: false; error: string };

export async function planDayRoutes(
  supabase: SupabaseClient<Database>,
  args: {
    orgId: string;
    staffIds: string[];
    day: string;
    reassign: boolean;
    /** null = the organization's own setting. */
    honourWindows: boolean | null;
    timeLimitMs: number;
    rounds?: number;
  },
): Promise<DayPlan> {
  const { data: inputs, error: inErr } = await supabase.rpc("route_day_inputs", {
    _org_id: args.orgId,
    _staff_ids: args.staffIds,
    _day: args.day,
    _reassign: args.reassign,
  });
  if (inErr) throw new Error(inErr.message);
  const inp = await readWalkGroupAssignments(
    supabase,
    args.orgId,
    inputs as unknown as RouteDayInputs,
  );
  const honourWindows = args.honourWindows ?? inp.org.route_windows !== "ignore";

  // planDay solves each group walk as one stop and returns its members
  // consecutively. apply_route_plan times that order the same way, so the
  // rows it writes count the walk once.

  const plan = planDay(inp, {
    day: args.day,
    honourWindows,
    solver: { timeLimitMs: args.timeLimitMs, rounds: args.rounds },
  });

  return {
    day: args.day,
    routes: plan.routes,
    unassigned: plan.unassigned,
    honourWindows,
    before: inp.techs.map((t) => ({
      staffId: t.id,
      minutes: Number(t.current_min ?? 0),
      sequenced: Boolean(t.current_sequenced),
    })),
    solver: {
      ms: plan.solution.ms,
      rounds: plan.solution.rounds,
      stoppedBy: plan.solution.stoppedBy,
      stops: inp.visits.length,
    },
  };
}

/**
 * Every solved day of a run, written in one transaction. The organization and
 * the people come from the run's own row, not from here, so a plan cannot be
 * written over somebody the run was not started for.
 *
 * Throws when the whole write was refused (the run already ended, or a
 * statement timeout), in which case nothing was written. A single day refused
 * by apply_route_plan comes back as `ok: false` and the rest are written.
 */
export async function applyRoutePlans(
  supabase: SupabaseClient<Database>,
  args: { runId: string; reassign: boolean; plans: DayPlan[] },
): Promise<DayWritten[]> {
  // Untyped until types.ts is regenerated from a database that has the
  // function; the shape is pinned by the migration and by the proof.
  const { data, error } = await (supabase as unknown as SupabaseClient).rpc("apply_route_plans", {
    _run_id: args.runId,
    _reassign: args.reassign,
    _plans: args.plans.map((p) => ({
      day: p.day,
      routes: p.routes,
      // The stops deliberately on no route. Without this list the write
      // would read a missing stop as "the day changed" and refuse the day.
      unassigned: p.unassigned.map((u) => u.visit_id),
      honour_windows: p.honourWindows,
    })) as unknown as Json,
  });
  if (error) throw new Error(error.message);
  const out = (data ?? []) as Array<{
    day: string;
    ok: boolean;
    error?: string;
    result?: { staff?: DaySummaryRow[]; misses?: WindowMiss[] };
  }>;
  return out.map((d) =>
    d.ok
      ? {
          day: d.day,
          ok: true as const,
          rows: (d.result?.staff ?? []).map((r) => ({
            ...r,
            stops: Number(r.stops ?? 0),
            service_min: Number(r.service_min ?? 0),
            travel_min: Number(r.travel_min ?? 0),
            total_min: Number(r.total_min ?? 0),
            late: Number(r.late ?? 0),
          })),
          misses: d.result?.misses ?? [],
        }
      : { day: d.day, ok: false as const, error: d.error ?? "The day could not be saved." },
  );
}
