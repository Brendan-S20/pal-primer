// Auto-routing runs in the background.
//
// The owner, 2026-10-04: "When utilizing the auto-routing and it takes a
// while, allow it to be dismissed to run in a background."
//
// Before this, a run was one request the panel awaited (applyOptimize), which
// read, solved and WROTE each day in turn. Closing the app cancelled the
// request on the Worker, and a multi-day run cut off part-way had written the
// days before the cut and none after. Nothing recorded that a run was
// happening, so there was nothing to come back to.
//
// What this file pins, without a database (the database half is
// tests/sql/routing-runs-in-the-background.proof.sql):
//
//   * the run's lifecycle, and what the header indicator makes of it;
//   * the write happens ONCE, after every day is solved, with every day in it
//     -- so a run that stops early writes nothing;
//   * a refused day, at either step, is reported and the others still run;
//   * one active run: a second press attaches and does no work;
//   * the job is handed to the Worker's waitUntil before it is awaited;
//   * the push goes only to someone who is not looking.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ABANDONED_AFTER_MS,
  WATCHING_FRESH_MS,
  canMove,
  failureKind,
  indicatorState,
  isAbandoned,
  isActive,
  progressFraction,
  shouldPushWhenDone,
  type RoutingRunRow,
} from "@/lib/routing-run";

// ── The solver and the router, replaced ─────────────────────────────────────
//
// runAutoRouting's job here is ORDER and BOOKKEEPING: what it calls, when, and
// what it does with the answers. The solver and the write have tests of their
// own (routing trials, the SQL proof).
const planDayRoutes = vi.fn();
const applyRoutePlans = vi.fn();
vi.mock("@/lib/route-plan.server", () => ({
  planDayRoutes: (...a: unknown[]) => planDayRoutes(...a),
  applyRoutePlans: (...a: unknown[]) => applyRoutePlans(...a),
}));
const refreshRoadLegs = vi.fn();
vi.mock("@/lib/road-legs.server", () => ({
  refreshRoadLegs: (...a: unknown[]) => refreshRoadLegs(...a),
}));

const refreshRouteLiveActivities = vi.fn(async (_pairs: unknown) => {});
vi.mock("@/lib/push-liveactivity.server", () => ({
  refreshRouteLiveActivities: (p: unknown) => refreshRouteLiveActivities(p),
}));

// The "your route changed" watch (#336): started before the write, finished
// after it. Recorded in one list with the write so the ORDER is checked.
const events: string[] = [];
const startRouteWatch = vi.fn(async (_input: unknown) => {
  events.push("watch:start");
  return {
    finish: async () => {
      events.push("watch:finish");
    },
  };
});
vi.mock("@/lib/field-notify.server", () => ({
  startRouteWatch: (i: unknown) => startRouteWatch(i),
}));

const { runAutoRouting, startAndRunAutoRouting, RunStopped, REVIEW_LINK } =
  await import("@/lib/auto-routing.server");

const ROOT = join(import.meta.dirname, "..");

const NOW = Date.parse("2026-10-04T15:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function row(over: Partial<RoutingRunRow>): RoutingRunRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    organization_id: "org",
    started_by: "me",
    from_day: "2026-10-05",
    to_day: "2026-10-05",
    staff_ids: ["a"],
    windows: "org",
    status: "running",
    stage: "road_times",
    days_total: 1,
    days_done: 0,
    result: null,
    error: null,
    applied_at: null,
    watched_at: null,
    seen_at: null,
    created_at: iso(10_000),
    updated_at: iso(1_000),
    finished_at: null,
    ...over,
  };
}

/** A Supabase client that answers every table read with nothing, so the
 *  after-the-write fit check runs and finds no rows. */
function fakeSupabase(rpc?: (fn: string, args: Record<string, unknown>) => unknown) {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    gte: () => chain,
    lte: () => chain,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res),
  };
  return {
    from: () => chain,
    rpc: async (fn: string, args: Record<string, unknown>) =>
      rpc ? rpc(fn, args) : { data: null, error: null },
  } as any;
}

const plan = (day: string) => ({
  day,
  routes: [{ staff_id: "a", visit_ids: [`v-${day}`] }],
  honourWindows: true,
  before: [{ staffId: "a", minutes: 30, sequenced: true }],
  solver: { ms: 1, rounds: 1, stoppedBy: "converged", stops: 1 },
});
const wrote = (day: string) => ({
  day,
  ok: true as const,
  rows: [{ staff_id: "a", stops: 1, service_min: 8, travel_min: 20, total_min: 28, late: 0 }],
  misses: [],
});

const INPUT = {
  staffIds: ["a"],
  from: "2026-10-05",
  to: "2026-10-07",
  level: "thorough" as const,
  reassign: true,
  windows: "org" as const,
};

beforeEach(() => {
  planDayRoutes.mockReset();
  applyRoutePlans.mockReset();
  refreshRoadLegs.mockReset();
  refreshRouteLiveActivities.mockClear();
  startRouteWatch.mockClear();
  events.length = 0;
  refreshRoadLegs.mockResolvedValue({ problem: null, pointsOutsideGraph: 0 });
  planDayRoutes.mockImplementation(async (_s: unknown, a: { day: string }) => plan(a.day));
  applyRoutePlans.mockImplementation(async (_s: unknown, a: { plans: Array<{ day: string }> }) =>
    a.plans.map((p) => wrote(p.day)),
  );
});

// ── The lifecycle ───────────────────────────────────────────────────────────

describe("a run's lifecycle", () => {
  it("moves forwards only, and ends", () => {
    expect(canMove("queued", "running")).toBe(true);
    expect(canMove("queued", "failed")).toBe(true);
    expect(canMove("running", "running")).toBe(true);
    expect(canMove("running", "succeeded")).toBe(true);
    expect(canMove("running", "failed")).toBe(true);
    // Final means final: a late poll cannot drag a finished run back.
    for (const to of ["queued", "running", "succeeded", "failed"] as const) {
      expect(canMove("succeeded", to)).toBe(false);
      expect(canMove("failed", to)).toBe(false);
    }
    expect(canMove("queued", "succeeded")).toBe(false);
    expect(canMove("running", "queued")).toBe(false);
  });

  it("is active while queued or running", () => {
    expect(isActive("queued")).toBe(true);
    expect(isActive("running")).toBe(true);
    expect(isActive("succeeded")).toBe(false);
    expect(isActive("failed")).toBe(false);
  });

  it("is abandoned when its heartbeat stops, whatever its row says", () => {
    expect(isAbandoned(row({ updated_at: iso(ABANDONED_AFTER_MS - 1000) }), NOW)).toBe(false);
    expect(isAbandoned(row({ updated_at: iso(ABANDONED_AFTER_MS + 1000) }), NOW)).toBe(true);
    // A finished run is never "abandoned": it said how it ended.
    expect(
      isAbandoned(row({ status: "succeeded", updated_at: iso(ABANDONED_AFTER_MS * 10) }), NOW),
    ).toBe(false);
  });

  it("says why a failed run failed, including when it saved before it died", () => {
    expect(failureKind(row({ status: "failed", error: "abandoned" }))).toBe("abandoned");
    expect(failureKind(row({ status: "failed", error: "abandoned", applied_at: iso(5_000) }))).toBe(
      "abandoned_saved",
    );
    expect(failureKind(row({ status: "failed", error: "boom" }))).toBe("error");
    expect(failureKind(row({ status: "succeeded" }))).toBe(null);
  });

  it("reports progress where it is knowable, and not before", () => {
    expect(progressFraction(row({ stage: null }))).toBe(null);
    expect(progressFraction(row({ stage: "road_times", days_done: 0, days_total: 4 }))).toBe(0);
    expect(progressFraction(row({ stage: "optimizing", days_done: 2, days_total: 4 }))).toBeCloseTo(
      0.45,
    );
    expect(progressFraction(row({ stage: "saving", days_done: 4, days_total: 4 }))).toBe(0.95);
  });
});

describe("what the header indicator shows", () => {
  it("nothing, when there is nothing", () => {
    expect(indicatorState([], NOW)).toEqual({ kind: "idle" });
    expect(indicatorState([row({ status: "succeeded", seen_at: iso(1) })], NOW).kind).toBe("idle");
  });

  it("a run in progress before anything finished", () => {
    const s = indicatorState(
      [
        row({ id: "done", status: "succeeded", created_at: iso(1_000) }),
        row({ id: "going", status: "running", created_at: iso(60_000) }),
      ],
      NOW,
    );
    expect(s.kind).toBe("running");
    expect(s.kind !== "idle" && s.run.id).toBe("going");
  });

  it("'ready' for a finished run nobody has looked at, 'failed' for one that failed", () => {
    expect(indicatorState([row({ status: "succeeded" })], NOW).kind).toBe("ready");
    expect(indicatorState([row({ status: "failed", error: "x" })], NOW).kind).toBe("failed");
  });

  it("'failed' for a run whose heartbeat stopped, rather than spinning forever", () => {
    const s = indicatorState([row({ updated_at: iso(ABANDONED_AFTER_MS + 1) })], NOW);
    expect(s.kind).toBe("failed");
  });
});

// ── The push ────────────────────────────────────────────────────────────────

describe("the push goes to someone who is not looking", () => {
  it("never looked: push", () => {
    expect(shouldPushWhenDone(null, NOW)).toBe(true);
  });
  it("looking a moment ago: no push", () => {
    expect(shouldPushWhenDone(iso(2_000), NOW)).toBe(false);
    expect(shouldPushWhenDone(iso(WATCHING_FRESH_MS - 1), NOW)).toBe(false);
  });
  it("left a while ago: push", () => {
    expect(shouldPushWhenDone(iso(WATCHING_FRESH_MS + 1), NOW)).toBe(true);
  });
});

// ── The work ────────────────────────────────────────────────────────────────

describe("runAutoRouting writes once, at the end", () => {
  it("solves every day, then writes them all in one call", async () => {
    const calls: string[] = [];
    planDayRoutes.mockImplementation(async (_s: unknown, a: { day: string }) => {
      calls.push(`plan ${a.day}`);
      return plan(a.day);
    });
    applyRoutePlans.mockImplementation(
      async (_s: unknown, a: { runId: string; plans: Array<{ day: string }> }) => {
        calls.push(`write ${a.plans.map((p) => p.day).join(",")} for ${a.runId}`);
        return a.plans.map((p) => wrote(p.day));
      },
    );
    const stages: string[] = [];
    const r = await runAutoRouting(fakeSupabase(), {
      orgId: "org",
      runId: "run-1",
      data: INPUT,
      progress: async (stage, done) => {
        stages.push(`${stage}:${done}`);
        return true;
      },
    });
    expect(calls).toEqual([
      "plan 2026-10-05",
      "plan 2026-10-06",
      "plan 2026-10-07",
      "write 2026-10-05,2026-10-06,2026-10-07 for run-1",
    ]);
    expect(applyRoutePlans).toHaveBeenCalledTimes(1);
    expect(stages).toEqual([
      "road_times:0",
      "optimizing:0",
      "road_times:1",
      "optimizing:1",
      "road_times:2",
      "optimizing:2",
      "saving:3",
    ]);
    expect(r.stops).toBe(3);
    expect(r.forecast).toMatchObject({ daysPlanned: 3, daysMeasured: 3, savedMin: 30 });
    expect(r.skipped).toEqual([]);
  });

  it("writes NOTHING when the run is stopped part-way", async () => {
    let n = 0;
    await expect(
      runAutoRouting(fakeSupabase(), {
        orgId: "org",
        runId: "run-1",
        data: INPUT,
        // The database refuses the third heartbeat: the run was declared
        // abandoned, or finished elsewhere.
        progress: async () => ++n < 3,
      }),
    ).rejects.toBeInstanceOf(RunStopped);
    expect(planDayRoutes).toHaveBeenCalledTimes(1);
    expect(applyRoutePlans).not.toHaveBeenCalled();
    // Nothing was written, so no lock screen is told anything changed.
    expect(refreshRouteLiveActivities).not.toHaveBeenCalled();
  });

  it("and nothing when it is stopped at the very last step, before the write", async () => {
    await expect(
      runAutoRouting(fakeSupabase(), {
        orgId: "org",
        runId: "run-1",
        data: INPUT,
        progress: async (stage) => stage !== "saving",
      }),
    ).rejects.toBeInstanceOf(RunStopped);
    expect(planDayRoutes).toHaveBeenCalledTimes(3);
    expect(applyRoutePlans).not.toHaveBeenCalled();
  });

  it("a day the planner refuses is reported and left out of the write", async () => {
    planDayRoutes.mockImplementation(async (_s: unknown, a: { day: string }) => {
      if (a.day === "2026-10-06") throw new Error("None of the selected people can be routed");
      return plan(a.day);
    });
    const r = await runAutoRouting(fakeSupabase(), {
      orgId: "org",
      runId: "run-1",
      data: INPUT,
      progress: async () => true,
    });
    const written = applyRoutePlans.mock.calls[0][1].plans.map((p: { day: string }) => p.day);
    expect(written).toEqual(["2026-10-05", "2026-10-07"]);
    expect(r.skipped).toEqual([
      {
        staffId: "",
        day: "2026-10-06",
        reason: "2026-10-06: None of the selected people can be routed",
      },
    ]);
    expect(r.stops).toBe(2);
  });

  it("a day the WRITE refuses is reported in the same list, and the rest stand", async () => {
    applyRoutePlans.mockImplementation(async (_s: unknown, a: { plans: Array<{ day: string }> }) =>
      a.plans.map((p) =>
        p.day === "2026-10-07"
          ? {
              day: p.day,
              ok: false,
              error: "The day changed while it was being planned. Run auto-routing again.",
            }
          : wrote(p.day),
      ),
    );
    const r = await runAutoRouting(fakeSupabase(), {
      orgId: "org",
      runId: "run-1",
      data: INPUT,
      progress: async () => true,
    });
    expect(r.skipped.map((s) => s.day)).toEqual(["2026-10-07"]);
    // The lock screens of every selected tech, for the days that were
    // written and only those: the refused day did not change.
    expect(refreshRouteLiveActivities).toHaveBeenCalledTimes(1);
    expect(refreshRouteLiveActivities.mock.calls[0][0]).toEqual([
      { staffId: "a", day: "2026-10-05" },
      { staffId: "a", day: "2026-10-06" },
    ]);
    expect(r.skipped[0].reason).toMatch(/day changed while it was being planned/);
    expect(r.stops).toBe(2);
    expect(r.forecast).not.toBeNull();
  });

  it("a write refused whole throws, so the run fails having written nothing", async () => {
    applyRoutePlans.mockRejectedValue(new Error("canceling statement due to statement timeout"));
    await expect(
      runAutoRouting(fakeSupabase(), {
        orgId: "org",
        runId: "run-1",
        data: INPUT,
        progress: async () => true,
      }),
    ).rejects.toThrow(/statement timeout/);
  });

  it("every day refused: nothing to report, not a zero", async () => {
    planDayRoutes.mockRejectedValue(new Error("nope"));
    const r = await runAutoRouting(fakeSupabase(), {
      orgId: "org",
      runId: "run-1",
      data: INPUT,
      progress: async () => true,
    });
    expect(r.forecast).toBeNull();
    // The write is still made, with no days in it: it is what stamps the run
    // as saved, which is what lets it finish as succeeded.
    expect(applyRoutePlans.mock.calls[0][1].plans).toEqual([]);
  });
});

// ── The run, start to finish ────────────────────────────────────────────────

type Rpcs = Record<string, (args: Record<string, unknown>) => unknown>;

function harness(rpcs: Rpcs) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const supabase = fakeSupabase(async (fn, args) => {
    calls.push([fn, args]);
    const h = rpcs[fn];
    return { data: h ? h(args) : null, error: null };
  });
  const notify = vi.fn(async () => {});
  const kept: Promise<unknown>[] = [];
  const keepAlive = vi.fn((p: Promise<unknown>) => void kept.push(p));
  return { supabase, calls, notify, keepAlive, kept };
}

const RUN_ID = "11111111-1111-4111-8111-111111111111";

describe("startAndRunAutoRouting", () => {
  it("attaches to the organization's active run instead of starting a second", async () => {
    const h = harness({
      start_routing_run: () => ({
        run_id: "22222222-2222-4222-8222-222222222222",
        attached: true,
        from_day: "2026-10-05",
        to_day: "2026-10-05",
        mine: false,
      }),
    });
    const run = vi.fn();
    const out = await startAndRunAutoRouting({
      supabase: h.supabase,
      userId: "me",
      orgId: "org",
      runId: RUN_ID,
      data: INPUT,
      keepAlive: h.keepAlive,
      notify: h.notify,
      run,
    });
    expect(out).toEqual({
      runId: "22222222-2222-4222-8222-222222222222",
      attached: true,
      fromDay: "2026-10-05",
      toDay: "2026-10-05",
      mine: false,
    });
    expect(run).not.toHaveBeenCalled();
    expect(h.keepAlive).not.toHaveBeenCalled();
    expect(h.calls.map(([fn]) => fn)).toEqual(["start_routing_run"]);
  });

  it("hands the job to waitUntil before awaiting it, and finishes the row", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({
      start_routing_run: () => ({ run_id: RUN_ID, attached: false }),
      finish_routing_run: () => ({ finished: true, watched_at: iso(1_000), applied_at: iso(500) }),
    });
    const result = {
      stops: 3,
      skipped: [],
      balance: [{ staffId: "a", stops: 3, totalMin: 9 }],
      forecast: { stops: 3, daysPlanned: 3, daysMeasured: 0, savedMin: 0, violations: 0 },
    };
    const pending = startAndRunAutoRouting({
      supabase: h.supabase,
      userId: "me",
      orgId: "org",
      runId: RUN_ID,
      data: INPUT,
      keepAlive: h.keepAlive,
      notify: h.notify,
      now: () => NOW,
      run: (async () => {
        await gate;
        return result;
      }) as any,
    });
    // The run has not finished, and waitUntil already holds it: a browser
    // that disconnects now does not take the run with it.
    await vi.waitFor(() => expect(h.keepAlive).toHaveBeenCalledTimes(1));
    expect(h.calls.map(([fn]) => fn)).toEqual(["start_routing_run"]);
    release();
    const out = await pending;
    expect(out).toMatchObject({ runId: RUN_ID, attached: false, status: "succeeded" });
    const finish = h.calls.find(([fn]) => fn === "finish_routing_run")!;
    expect(finish[1]).toMatchObject({ _id: RUN_ID, _status: "succeeded", _result: result });
    // Watched a second ago: no push.
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("pushes 'routing_ready' to the person who left, with the review link", async () => {
    const h = harness({
      start_routing_run: () => ({ run_id: RUN_ID, attached: false }),
      finish_routing_run: () => ({ finished: true, watched_at: iso(60_000), applied_at: iso(500) }),
    });
    await startAndRunAutoRouting({
      supabase: h.supabase,
      userId: "me",
      orgId: "org",
      runId: RUN_ID,
      data: { ...INPUT, to: INPUT.from },
      keepAlive: h.keepAlive,
      notify: h.notify,
      now: () => NOW,
      run: (async () => ({
        stops: 21,
        skipped: [],
        balance: [],
        forecast: { stops: 21, daysPlanned: 2, daysMeasured: 2, savedMin: 4, violations: 0 },
      })) as any,
    });
    expect(h.notify).toHaveBeenCalledTimes(1);
    const [ids, n] = h.notify.mock.calls[0] as unknown as [string[], Record<string, string>];
    expect(ids).toEqual(["me"]);
    expect(n).toMatchObject({
      orgId: "org",
      type: "routing_ready",
      title: "Routes ready",
      link: REVIEW_LINK,
      // One lock-screen thread per organization, one notification per run.
      threadId: "routing:org",
      collapseId: `routing-run:${RUN_ID}`,
    });
    expect(n.body).toMatch(/21 stops routed/);
    expect(REVIEW_LINK).toBe("/routes?autoroute=review");
  });

  it("a failed run finishes as failed and pushes 'routing_failed', saying nothing changed", async () => {
    const h = harness({
      start_routing_run: () => ({ run_id: RUN_ID, attached: false }),
      finish_routing_run: () => ({ finished: true, watched_at: null, applied_at: null }),
    });
    const out = await startAndRunAutoRouting({
      supabase: h.supabase,
      userId: "me",
      orgId: "org",
      runId: RUN_ID,
      data: INPUT,
      keepAlive: h.keepAlive,
      notify: h.notify,
      now: () => NOW,
      run: (async () => {
        throw new Error("canceling statement due to statement timeout");
      }) as any,
    });
    expect(out).toMatchObject({
      status: "failed",
      error: "canceling statement due to statement timeout",
    });
    const finish = h.calls.find(([fn]) => fn === "finish_routing_run")!;
    expect(finish[1]).toMatchObject({
      _status: "failed",
      _error: "canceling statement due to statement timeout",
    });
    const n = (h.notify.mock.calls[0] as unknown as [string[], Record<string, string>])[1];
    expect(n.type).toBe("routing_failed");
    expect(n.body).toMatch(/nothing was changed/);
  });

  it("does not claim nothing changed when the write had already committed", async () => {
    const h = harness({
      start_routing_run: () => ({ run_id: RUN_ID, attached: false }),
      finish_routing_run: () => ({ finished: true, watched_at: null, applied_at: iso(100) }),
    });
    await startAndRunAutoRouting({
      supabase: h.supabase,
      userId: "me",
      orgId: "org",
      runId: RUN_ID,
      data: INPUT,
      keepAlive: h.keepAlive,
      notify: h.notify,
      now: () => NOW,
      run: (async () => {
        throw new Error("lost the summary");
      }) as any,
    });
    const n = (h.notify.mock.calls[0] as unknown as [string[], Record<string, string>])[1];
    expect(n.body).not.toMatch(/nothing was changed/);
    expect(n.body).toMatch(/routes were saved/);
  });

  it("a run that was already ended elsewhere is not finished again, and pushes nothing", async () => {
    const h = harness({
      start_routing_run: () => ({ run_id: RUN_ID, attached: false }),
      // finish_routing_run matched no active row: declared abandoned meanwhile.
      finish_routing_run: () => ({ finished: false, watched_at: null, applied_at: null }),
    });
    await startAndRunAutoRouting({
      supabase: h.supabase,
      userId: "me",
      orgId: "org",
      runId: RUN_ID,
      data: INPUT,
      keepAlive: h.keepAlive,
      notify: h.notify,
      now: () => NOW,
      run: (async () => {
        throw new RunStopped();
      }) as any,
    });
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("heartbeats go through routing_run_progress, and a refusal stops the job", async () => {
    let beats = 0;
    const h = harness({
      start_routing_run: () => ({ run_id: RUN_ID, attached: false }),
      routing_run_progress: () => ++beats < 2,
      finish_routing_run: () => ({ finished: false, watched_at: null, applied_at: null }),
    });
    const out = await startAndRunAutoRouting({
      supabase: h.supabase,
      userId: "me",
      orgId: "org",
      runId: RUN_ID,
      data: INPUT,
      keepAlive: h.keepAlive,
      notify: h.notify,
      now: () => NOW,
    });
    expect(out).toMatchObject({ status: "failed" });
    expect(applyRoutePlans).not.toHaveBeenCalled();
    const beat = h.calls.find(([fn]) => fn === "routing_run_progress")!;
    expect(beat[1]).toMatchObject({ _id: RUN_ID, _stage: "road_times", _days_done: 0 });
  });
});

// ── The wiring ──────────────────────────────────────────────────────────────

describe("the wiring", () => {
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

  it("the server function reaches the Worker's waitUntil the way monitoring does", () => {
    // The helper moved to lib/keep-alive.server.ts when completeVisit's
    // client notices started using it too.
    const fns = read("src/lib/routing-runs.functions.ts");
    const keepAlive = read("src/lib/keep-alive.server.ts");
    expect(keepAlive).toMatch(/getRequest\(\)/);
    expect(keepAlive).toMatch(/waitUntil\.call\(request, job\)/);
    expect(fns).toMatch(/keepAliveForThisRequest\(\)/);
    expect(fns).toMatch(/startAndRunAutoRouting\(\{/);
    expect(fns).toMatch(/notify: notifyUsers/);
  });

  it("the panel no longer disables Cancel while a run is going, and calls it what it is", () => {
    const panel = read("src/components/routes/AutoRoutingPanel.tsx");
    expect(panel).not.toMatch(/onClick=\{onClose\} disabled=\{busy\}/);
    expect(panel).toMatch(/\{busy \? "Run in background" : "Cancel"\}/);
  });

  it("the header carries the indicator, and /routes opens the card from its link", () => {
    expect(read("src/routes/_authenticated/route.tsx")).toMatch(/<RoutingRunIndicator \/>/);
    expect(read("src/components/routes/RoutingRunIndicator.tsx")).toMatch(
      /ROUTES_REVIEW_HREF = "\/routes\?autoroute=review"/,
    );
    expect(read("src/routes/_authenticated/routes.tsx")).toMatch(/\.autoroute/);
  });

  it("the migration's abandonment window is the one the browser assumes", () => {
    const sql = read("supabase/migrations/20261004160000_routing-runs-in-the-background.sql");
    const intervals = [...sql.matchAll(/updated_at < now\(\) - interval '(\d+) minutes'/g)].map(
      (m) => Number(m[1]),
    );
    expect(intervals.length).toBe(2);
    for (const m of intervals) expect(m * 60_000).toBe(ABANDONED_AFTER_MS);
  });
});

describe("the techs whose day changed are told, once, and not the person who pressed Apply", () => {
  it("watches their routes from just before the write to just after it", async () => {
    applyRoutePlans.mockImplementation(
      async (_s: unknown, a: { plans: Array<{ day: string }> }) => {
        events.push("write");
        return a.plans.map((p) => wrote(p.day));
      },
    );
    await runAutoRouting(fakeSupabase(), {
      orgId: "org",
      runId: "run-1",
      data: INPUT,
      actorUserId: "me",
      progress: async () => true,
    });
    expect(events).toEqual(["watch:start", "write", "watch:finish"]);
    expect(startRouteWatch).toHaveBeenCalledWith({
      actorUserId: "me",
      orgId: "org",
      staffIds: ["a"],
    });
  });

  it("a write refused whole tells nobody anything changed", async () => {
    applyRoutePlans.mockRejectedValue(new Error("canceling statement due to statement timeout"));
    await expect(
      runAutoRouting(fakeSupabase(), {
        orgId: "org",
        runId: "run-1",
        data: INPUT,
        actorUserId: "me",
        progress: async () => true,
      }),
    ).rejects.toThrow();
    expect(events).toEqual(["watch:start"]);
  });

  it("a run stopped before the write never starts watching", async () => {
    await expect(
      runAutoRouting(fakeSupabase(), {
        orgId: "org",
        runId: "run-1",
        data: INPUT,
        actorUserId: "me",
        progress: async (stage) => stage !== "saving",
      }),
    ).rejects.toBeInstanceOf(RunStopped);
    expect(startRouteWatch).not.toHaveBeenCalled();
  });

  it("startAndRunAutoRouting passes who pressed Apply through to the run", async () => {
    const h = harness({
      start_routing_run: () => ({ run_id: RUN_ID, attached: false }),
      finish_routing_run: () => ({ finished: true, watched_at: null, applied_at: iso(1) }),
    });
    const run = vi.fn(async () => ({ stops: 0, skipped: [], balance: [], forecast: null }));
    await startAndRunAutoRouting({
      supabase: h.supabase,
      userId: "me",
      orgId: "org",
      runId: RUN_ID,
      data: INPUT,
      keepAlive: h.keepAlive,
      notify: h.notify,
      now: () => NOW,
      run: run as any,
    });
    expect((run.mock.calls[0] as unknown[])[1]).toMatchObject({ actorUserId: "me" });
  });
});
