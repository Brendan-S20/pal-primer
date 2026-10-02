// One day of auto-routing: read what Postgres knows, solve, write.
//
// Three statements per day, each short: route_day_inputs (one read),
// the solver (TypeScript, in this process, inside a time budget), and
// apply_route_plan (one write, which replays the clock itself). None of them
// is the search, so none of them is anywhere near the API's 8-second limit
// on a 200-stop day -- the reason this exists. See route-solver.ts.
//
// Called as the signed-in user, with their client: both RPCs check
// can_write_org themselves, exactly as plan_day_across_staff did.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import { planDay, type RouteDayInputs } from "@/lib/route-inputs";

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

export type DayResult = {
  rows: DaySummaryRow[];
  misses: WindowMiss[];
  honourWindows: boolean;
  /** Each technician's route before this run, from route_cost_current. */
  before: Array<{ staffId: string; minutes: number; sequenced: boolean }>;
  solver: { ms: number; rounds: number; stoppedBy: string; stops: number };
};

export async function planAndApplyDay(
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
): Promise<DayResult> {
  const { data: inputs, error: inErr } = await supabase.rpc("route_day_inputs", {
    _org_id: args.orgId,
    _staff_ids: args.staffIds,
    _day: args.day,
    _reassign: args.reassign,
  });
  if (inErr) throw new Error(inErr.message);
  const inp = inputs as unknown as RouteDayInputs;
  const honourWindows = args.honourWindows ?? inp.org.route_windows !== "ignore";

  const plan = planDay(inp, {
    day: args.day,
    honourWindows,
    solver: { timeLimitMs: args.timeLimitMs, rounds: args.rounds },
  });

  const { data: applied, error: apErr } = await supabase.rpc("apply_route_plan", {
    _org_id: args.orgId,
    _staff_ids: args.staffIds,
    _day: args.day,
    _reassign: args.reassign,
    _routes: plan.routes as unknown as Json,
    _honour_windows: honourWindows,
  });
  if (apErr) throw new Error(apErr.message);
  const out = (applied ?? {}) as unknown as { staff?: DaySummaryRow[]; misses?: WindowMiss[] };

  return {
    rows: (out.staff ?? []).map((r) => ({
      ...r,
      stops: Number(r.stops ?? 0),
      service_min: Number(r.service_min ?? 0),
      travel_min: Number(r.travel_min ?? 0),
      total_min: Number(r.total_min ?? 0),
      late: Number(r.late ?? 0),
    })),
    misses: out.misses ?? [],
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
