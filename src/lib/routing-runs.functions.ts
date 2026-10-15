// Auto-routing runs, as the browser reaches them.
//
//   startRoutingRun     what Apply calls. Records the run (or attaches to the
//                       organization's active one) and does the work. It is
//                       awaited by the panel for as long as the browser stays,
//                       but nothing on screen depends on it returning: the
//                       panel and the header indicator watch the ROW, by the
//                       id the browser chose, so the same screen works whether
//                       the run finishes in two seconds or after the app was
//                       closed and reopened.
//   listMyRoutingRuns   what the indicator polls.
//   markRoutingRunSeen  the person has looked at the result.
//
// See src/lib/auto-routing.server.ts for the run itself, and
// 20261004160000_routing-runs-in-the-background for the table.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { LEVELS, type RoutingRunRow } from "@/lib/routing-run";
import { resolveCaller } from "@/lib/authz.server";

async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  // Through the shared gate, so a person whose access is turned off is
  // refused here as everywhere else (20261009180000).
  return (await resolveCaller(supabase, userId)).orgId;
}

/**
 * The Worker's waitUntil, if this request has one.
 *
 * On Cloudflare, Nitro puts the ExecutionContext's waitUntil on the incoming
 * Request (nitro's cloudflare `augmentReq`); monitoring/report.server.ts
 * relies on the same thing. Without it (Node in dev, vitest) the run is just
 * awaited, which in Node keeps going after a disconnect anyway.
 */
async function keepAliveForThisRequest(): Promise<(job: Promise<unknown>) => void> {
  try {
    const { getRequest } = await import("@tanstack/react-start/server");
    const request = getRequest() as
      (Request & { waitUntil?: (p: Promise<unknown>) => void }) | null;
    const waitUntil = request?.waitUntil;
    if (typeof waitUntil === "function") {
      return (job) => {
        try {
          waitUntil.call(request, job);
        } catch {
          /* awaited by the caller regardless */
        }
      };
    }
  } catch {
    /* not inside a request: nothing to extend */
  }
  return () => {};
}

export const startRoutingRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        // Chosen by the browser, so it can watch the row before this call
        // returns -- which, for a long run, may be never from its point of
        // view (the app was closed).
        runId: z.string().uuid(),
        staffIds: z.array(z.string().uuid()).min(1).max(50),
        // Bare z.string() here was a one-request denial of service. The refine
        // below is a LEXICAL compare, so "zzzz" passed it, and the day loop in
        // the handler breaks on `iso > data.to` — which "2026-08-27" > "zzzz"
        // never satisfies. Reproduced: 2,000,001 iterations and 117MB of heap
        // still climbing, from a single authenticated POST. Shape first, so a
        // non-date cannot reach the loop at all; the same idiom as
        // cpa-reports.functions.ts:51 and four other files.
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date."),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date."),
        level: z.enum(LEVELS).default("balanced"),
        reassign: z.boolean().default(false),
        // Arrival windows for THIS run: "org" follows Settings -> Scheduling,
        // the other two override it once. See 20261002090400.
        windows: z.enum(["org", "honour", "ignore"]).default("org"),
      })
      // A well-formed but absurd range is still 2.9M planner calls, so the
      // span is bounded as well as the shape. A quarter is far past what a
      // dispatcher plans in one press.
      .refine(
        (v) =>
          (Date.parse(`${v.to}T00:00:00Z`) - Date.parse(`${v.from}T00:00:00Z`)) / 86_400_000 <= 92,
        { message: "Route at most 92 days at a time.", path: ["to"] },
      )
      .refine((v) => v.to >= v.from, {
        message: "The end date is before the start date.",
        path: ["to"],
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const [{ startAndRunAutoRouting }, { notifyUsers }, keepAlive] = await Promise.all([
      import("@/lib/auto-routing.server"),
      import("@/lib/notify-center.server"),
      keepAliveForThisRequest(),
    ]);
    const { runId, ...input } = data;
    return startAndRunAutoRouting({
      supabase,
      userId,
      orgId,
      runId,
      data: input,
      keepAlive,
      notify: notifyUsers,
    });
  });

export const listMyRoutingRuns = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        // True while the person is on /routes with the page visible. Stamps
        // watched_at, which is how the run decides not to push them.
        watching: z.boolean().default(false),
        // Runs this browser attached to (somebody else's press).
        also: z.array(z.string().uuid()).max(5).default([]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await (context.supabase as any).rpc("my_routing_runs", {
      _watching: data.watching,
      _also: data.also,
    });
    if (error) throw new Error(error.message);
    return { runs: (rows ?? []) as RoutingRunRow[], serverNow: Date.now() };
  });

/** What `routing_run_undo_state` answers (20261015140000). */
export type RoutingRunUndoState = {
  available: boolean;
  reason: "nothing_saved" | "nothing_changed" | "expired" | "later_run" | "changed_since" | null;
  /** Visits whose technician or place in the order the run changed. */
  moved: number;
  /** Technicians who hold those visits now. */
  techs: number;
  staff_ids: string[];
  expires_at: string | null;
};

/**
 * Whether the last Apply can still be undone, and what it changed. The
 * panel asks once the run has finished, for "Moved 14 visits across 3
 * techs. Undo" (#435).
 */
export const getRoutingRunUndo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ runId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: state, error } = await (context.supabase as any).rpc("routing_run_undo_state", {
      _run_id: data.runId,
    });
    if (error) throw new Error(error.message);
    return state as RoutingRunUndoState;
  });

/**
 * Put every visit the run changed back the way it was: technician, order and
 * arrival times. Refused (with the reason in words) once the window has
 * passed or anything has moved since. The technicians whose day changes back
 * are told, the same way Apply told them.
 */
export const undoRoutingRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ runId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data: state, error: stateErr } = await (supabase as any).rpc("routing_run_undo_state", {
      _run_id: data.runId,
    });
    if (stateErr) throw new Error(stateErr.message);
    const staffIds = ((state as RoutingRunUndoState | null)?.staff_ids ?? []).slice(0, 50);

    const { startRouteWatch } = await import("@/lib/field-notify.server");
    const watch = await startRouteWatch({ actorUserId: userId, orgId, staffIds });
    const { data: out, error } = await (supabase as any).rpc("undo_routing_run", {
      _run_id: data.runId,
    });
    if (error) throw new Error(error.message);
    await watch.finish();

    const r = out as { restored: number; from_day: string; to_day: string };
    // Lock screens show today's route; a week out it is a no-op per day, so
    // the list is capped rather than walked across a quarter.
    const days: string[] = [];
    for (let d = r.from_day; d <= r.to_day && days.length < 7; ) {
      days.push(d);
      const next = new Date(`${d}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      d = next.toISOString().slice(0, 10);
    }
    const { refreshRouteLiveActivities } = await import("@/lib/push-liveactivity.server");
    await refreshRouteLiveActivities(staffIds.flatMap((staffId) => days.map((day) => ({ staffId, day }))));
    return { restored: r.restored };
  });

export const markRoutingRunSeen = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ runId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await (context.supabase as any).rpc("routing_run_seen", {
      _id: data.runId,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
