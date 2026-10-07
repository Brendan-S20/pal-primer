// An auto-routing run, as a thing with a life of its own.
//
// Shared by the server (auto-routing.server.ts, which moves a run along) and
// the browser (the panel and the header indicator, which watch one). Pure: no
// I/O, no clock of its own, so every rule here is a unit test away.
//
// The row is public.routing_runs (20261004160000_routing-runs-in-the-background),
// and the database enforces the same lifecycle this file describes:
//
//   queued ──► running ──► succeeded
//      │          │
//      └──────────┴──────► failed
//
// `running` repeats (each stage is a heartbeat). `succeeded` and `failed` are
// final. A run is `succeeded` only once its write has committed (the table's
// own CHECK), and a run whose heartbeat stopped is `failed` with the error
// "abandoned" -- declared by whoever next looks, because a Worker that died
// cannot say so itself.

import type { Json } from "@/integrations/supabase/types";

/** How hard the solver searches. The panel always sends "thorough"; see the
 *  note on LEVEL in AutoRoutingPanel.tsx. */
export const LEVELS = ["fast", "balanced", "thorough"] as const;

export const RUN_STAGES = ["road_times", "optimizing", "saving"] as const;
export type RunStage = (typeof RUN_STAGES)[number];
export type RunStatus = "queued" | "running" | "succeeded" | "failed";

export type RoutingRunRow = {
  id: string;
  organization_id: string;
  started_by: string;
  from_day: string;
  to_day: string;
  staff_ids: string[];
  windows: "org" | "honour" | "ignore";
  status: RunStatus;
  stage: RunStage | null;
  days_total: number;
  days_done: number;
  /** AutoRouteResult, as the run stored it. */
  result: Json | null;
  error: string | null;
  applied_at: string | null;
  watched_at: string | null;
  seen_at: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

/** The migration's "interval '3 minutes'". A stage can legitimately take a
 *  while -- one day's road times are up to two 20-second requests to the
 *  router and a Retry-After between them -- so this is well past the longest
 *  silence a live run can have. */
export const ABANDONED_AFTER_MS = 3 * 60_000;

/** Someone whose screen polled the run this recently is looking at it. The
 *  panel polls every POLL_MS while the page is visible and on /routes, so a
 *  stamp older than a few polls means they left. */
export const POLL_MS = 2_000;
export const WATCHING_FRESH_MS = 15_000;

const NEXT: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["running", "failed"],
  running: ["running", "succeeded", "failed"],
  succeeded: [],
  failed: [],
};

/** Whether a run in `from` may move to `to`. The SQL functions apply the same
 *  rule with `WHERE status IN ('queued', 'running')`; this is what the
 *  browser uses to ignore a stale poll that would move a run backwards. */
export function canMove(from: RunStatus, to: RunStatus): boolean {
  return NEXT[from].includes(to);
}

export function isActive(status: RunStatus): boolean {
  return status === "queued" || status === "running";
}

/** A run whose heartbeat stopped. Its row may still say running. */
export function isAbandoned(
  run: Pick<RoutingRunRow, "status" | "updated_at">,
  nowMs: number,
): boolean {
  return isActive(run.status) && nowMs - Date.parse(run.updated_at) > ABANDONED_AFTER_MS;
}

/**
 * Push, or not, when a run finishes. Only the person who is NOT looking gets
 * one: somebody on /routes already sees the toast and the board change, and a
 * phone buzzing about the screen in your hand is noise.
 */
export function shouldPushWhenDone(watchedAt: string | null, nowMs: number): boolean {
  if (!watchedAt) return true;
  return nowMs - Date.parse(watchedAt) > WATCHING_FRESH_MS;
}

/** Why a failed run failed, in the three ways that need different words. */
export function failureKind(
  run: Pick<RoutingRunRow, "status" | "error" | "applied_at">,
): "abandoned_saved" | "abandoned" | "error" | null {
  if (run.status !== "failed") return null;
  if (run.error === "abandoned") return run.applied_at ? "abandoned_saved" : "abandoned";
  return "error";
}

export type IndicatorState =
  | { kind: "idle" }
  | { kind: "running"; run: RoutingRunRow }
  | { kind: "ready"; run: RoutingRunRow }
  | { kind: "failed"; run: RoutingRunRow };

/**
 * What the header indicator shows, from the runs the server returned: a run
 * in progress wins, then the newest finished run nobody has looked at yet.
 */
export function indicatorState(runs: readonly RoutingRunRow[], nowMs: number): IndicatorState {
  const newest = [...runs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const active = newest.find((r) => isActive(r.status) && !isAbandoned(r, nowMs));
  if (active) return { kind: "running", run: active };
  const done = newest.find((r) => !r.seen_at && (!isActive(r.status) || isAbandoned(r, nowMs)));
  if (!done) return { kind: "idle" };
  return done.status === "succeeded" ? { kind: "ready", run: done } : { kind: "failed", run: done };
}

/** How far along, 0..1, where it is knowable: days solved out of days, with
 *  saving as the last tenth. Null while there is nothing to count yet. */
export function progressFraction(
  run: Pick<RoutingRunRow, "stage" | "days_done" | "days_total">,
): number | null {
  if (run.stage === "saving") return 0.95;
  if (!run.stage || run.days_total <= 0) return null;
  return Math.min(0.9, (run.days_done / run.days_total) * 0.9);
}
