// Auto-routing moved a visit that was assigned by hand (#609, decision D10).
//
// The panel sent `reassign` switched on with every Apply, so a run could take
// a visit off the one walker a dog tolerates, or the tech who holds the key,
// and give it to whoever was closer. The engine could already keep an
// assignment (`fixed`); the panel never asked it to.
//
// What this file pins:
//
//   * a default run keeps every current assignment;
//   * a pinned visit keeps its tech even on a run allowed to move work, in
//     the planner (here) and in the database read and write (the migration);
//   * the preview's list of moves is exactly the set of changes the write
//     makes, and a day that changed after the preview is not written;
//   * the switch starts off on every open and is never remembered.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { holdPinnedVisits, planDay, type RouteDayInputs } from "@/lib/route-inputs";
import { changedSincePreview, routeMoves, type VisitBefore } from "@/lib/route-moves";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MIGRATION = "supabase/migrations/20261031090000_auto-routing-keeps-a-pinned-stop.sql";

const DAY = "2026-11-03";
const SOLVER = { rounds: 20, now: () => 0 };

type Visit = { id: string; lat: number; lon: number; assigned: string | null; pinned?: boolean };

/** Two techs at opposite ends of town. "dog" sits beside Ben's start but was
 *  given to Ana by hand: the visit a planner left to itself hands to Ben. */
const VISITS: Visit[] = [
  { id: "near-ana-1", lat: 30.001, lon: -97.001, assigned: null },
  { id: "near-ana-2", lat: 30.002, lon: -97.002, assigned: null },
  { id: "near-ben-1", lat: 30.301, lon: -97.301, assigned: null },
  { id: "near-ben-2", lat: 30.302, lon: -97.302, assigned: null },
  { id: "dog", lat: 30.3005, lon: -97.3005, assigned: "ana" },
];

/** What route_day_inputs returns, by the rule 20261031090000 gives it:
 *  fixed when the run keeps assignments or the visit is pinned, and only
 *  when there is a tech to keep it on. */
function readDay(visits: Visit[], reassign: boolean): RouteDayInputs {
  return {
    org: {
      timezone: "America/Chicago",
      workday_start: "08:00",
      workday_end: "17:00",
      park_walk_min: 2,
      road_factor: 1.35,
      speed_kmh: 40,
      measured_legs: null,
      max_drive_minutes: 240,
      route_windows: "honour",
      latitude: null,
      longitude: null,
    },
    techs: [
      { id: "ana", lat: 30, lon: -97 },
      { id: "ben", lat: 30.3, lon: -97.3 },
    ].map((t) => ({
      id: t.id,
      capacity: 480,
      start_lat: t.lat,
      start_lon: t.lon,
      end_lat: null,
      end_lon: null,
      current_min: null,
      current_stops: null,
      current_sequenced: null,
    })),
    visits: visits.map((v) => ({
      id: v.id,
      lat: v.lat,
      lon: v.lon,
      service_min: 15,
      earliest: null,
      latest: null,
      pref: "any",
      assigned_staff_id: v.assigned,
      fixed: (!reassign || Boolean(v.pinned)) && v.assigned != null,
      pinned: Boolean(v.pinned),
      client: `Client ${v.id}`,
      service: "Walk",
    })),
    dumps: [],
    day_centroid: null,
    points: [],
    legs: [],
  };
}

const plan = (inputs: RouteDayInputs) =>
  planDay(holdPinnedVisits(inputs), { day: DAY, honourWindows: true, solver: SOLVER });
const techOf = (p: ReturnType<typeof plan>, id: string) =>
  p.routes.find((r) => r.visit_ids.includes(id))?.staff_id ?? null;
const before = (visits: Visit[]): VisitBefore[] =>
  visits.map((v) => ({ visitId: v.id, staffId: v.assigned, pinned: Boolean(v.pinned) }));

/** apply_route_plan's write, as far as who has which visit: a routed visit
 *  goes to its route's tech; one left off every route comes off its tech
 *  only on a reassign run, and never when pinned. */
function written(
  visits: Visit[],
  p: ReturnType<typeof plan>,
  reassign: boolean,
): Map<string, string | null> {
  const left = new Set(p.unassigned.map((u) => u.visit_id));
  return new Map(
    visits.map((v) => {
      const to = techOf(p, v.id);
      if (to) return [v.id, to];
      if (left.has(v.id) && reassign && !v.pinned) return [v.id, null];
      return [v.id, v.assigned];
    }),
  );
}

describe("the scenario is the one that hurts", () => {
  it("left to itself, the planner hands the hand-assigned visit to the closer tech", () => {
    // Without this the tests below would pass for the wrong reason.
    expect(techOf(plan(readDay(VISITS, true)), "dog")).toBe("ben");
  });
});

describe("a default run keeps every current assignment", () => {
  it("the hand-assigned visit stays with Ana, and is still routed", () => {
    const p = plan(readDay(VISITS, false));
    expect(techOf(p, "dog")).toBe("ana");
    expect(p.unassigned).toEqual([]);
  });

  it("unassigned visits are still given out", () => {
    const p = plan(readDay(VISITS, false));
    for (const v of VISITS) expect(techOf(p, v.id), v.id).not.toBeNull();
  });

  it("and the preview lists only the visits that were given out", () => {
    const p = plan(readDay(VISITS, false));
    const { moves, reordered } = routeMoves({
      day: DAY,
      before: before(VISITS),
      routes: p.routes,
      unassigned: p.unassigned.map((u) => u.visit_id),
      reassign: false,
    });
    expect(moves.every((m) => m.kind === "assigned")).toBe(true);
    expect(moves.map((m) => m.visitId)).not.toContain("dog");
    expect(reordered).toBe(1);
  });
});

describe("a pinned visit keeps its tech even when the run may move work", () => {
  const pinned = VISITS.map((v) => (v.id === "dog" ? { ...v, pinned: true } : v));

  it("as the database reads it", () => {
    expect(techOf(plan(readDay(pinned, true)), "dog")).toBe("ana");
  });

  it("and against a read that has not learnt the pin, the planner holds it anyway", () => {
    const stale = readDay(pinned, true);
    stale.visits = stale.visits.map((v) => ({ ...v, fixed: false }));
    expect(techOf(plan(stale), "dog")).toBe("ana");
  });

  it("other visits on that run may still move", () => {
    const p = plan(readDay(pinned, true));
    const { moves } = routeMoves({
      day: DAY,
      before: before(pinned),
      routes: p.routes,
      unassigned: p.unassigned.map((u) => u.visit_id),
      reassign: true,
    });
    expect(moves.map((m) => m.visitId)).not.toContain("dog");
  });

  it("left off every route on a reassign run, it keeps its tech", () => {
    const { moves } = routeMoves({
      day: DAY,
      before: [{ visitId: "dog", staffId: "ana", pinned: true }],
      routes: [],
      unassigned: ["dog"],
      reassign: true,
    });
    expect(moves).toEqual([
      expect.objectContaining({ visitId: "dog", kind: "off_route", toStaffId: "ana" }),
    ]);
  });
});

describe("the preview is the set of changes the write makes", () => {
  for (const [label, visits, reassign] of [
    ["default run", VISITS, false],
    ["reassign run", VISITS, true],
    [
      "reassign run with a pin",
      VISITS.map((v) => (v.id === "dog" ? { ...v, pinned: true } : v)),
      true,
    ],
  ] as const) {
    it(label, () => {
      const p = plan(readDay([...visits], reassign));
      const { moves } = routeMoves({
        day: DAY,
        before: before([...visits]),
        routes: p.routes,
        unassigned: p.unassigned.map((u) => u.visit_id),
        reassign,
      });
      const after = written([...visits], p, reassign);
      const changed = visits
        .filter((v) => after.get(v.id) !== v.assigned)
        .map((v) => ({ visitId: v.id, from: v.assigned, to: after.get(v.id) ?? null }));
      const listed = moves
        .filter((m) => m.kind !== "off_route")
        .map((m) => ({ visitId: m.visitId, from: m.fromStaffId, to: m.toStaffId }));
      expect(listed).toEqual(changed);
    });
  }

  it("names each move with its client, its day and both techs", () => {
    const { moves } = routeMoves({
      day: DAY,
      before: [{ visitId: "dog", staffId: "ana", pinned: false }],
      names: new Map([["dog", { client: "Rex Owner", service: "Walk" }]]),
      routes: [{ staff_id: "ben", visit_ids: ["dog"] }],
      unassigned: [],
      reassign: true,
    });
    expect(moves).toEqual([
      {
        day: DAY,
        visitId: "dog",
        client: "Rex Owner",
        service: "Walk",
        kind: "reassigned",
        fromStaffId: "ana",
        toStaffId: "ben",
      },
    ]);
  });
});

describe("Apply writes the preview, and refuses a day that changed", () => {
  it("a reassignment, a pin or a vanished visit after the preview is caught", () => {
    const seen = before(VISITS);
    expect(changedSincePreview(seen, seen)).toBeNull();
    const moved = seen.map((v) => (v.visitId === "dog" ? { ...v, staffId: "ben" } : v));
    expect(changedSincePreview(seen, moved)).toMatch(/reassigned/);
    const pinned = seen.map((v) => (v.visitId === "dog" ? { ...v, pinned: true } : v));
    expect(changedSincePreview(seen, pinned)).toMatch(/pinned/);
    expect(changedSincePreview(seen, seen.slice(1))).toMatch(/cancelled/);
  });

  it("the run leaves that day out of the write and says why", async () => {
    const applyRoutePlans = vi.fn(async (_s: unknown, a: { plans: Array<{ day: string }> }) =>
      a.plans.map((p) => ({ day: p.day, ok: true as const, rows: [], misses: [] })),
    );
    vi.doMock("@/lib/route-plan.server", () => ({
      planDayRoutes: vi.fn(),
      applyRoutePlans: (...a: [unknown, { plans: Array<{ day: string }> }]) =>
        applyRoutePlans(...a),
    }));
    vi.doMock("@/lib/field-notify.server", () => ({
      startRouteWatch: async () => ({ finish: async () => {} }),
    }));
    vi.doMock("@/lib/push-liveactivity.server", () => ({
      refreshRouteLiveActivities: async () => {},
    }));
    const { runAutoRouting } = await import("@/lib/auto-routing.server");

    // The database now says "dog" is Ben's on the 3rd; the 4th is as previewed.
    const today: Record<
      string,
      Array<{ id: string; assigned_staff_id: string; route_pinned: boolean }>
    > = {
      "2026-11-03": [{ id: "dog", assigned_staff_id: "ben", route_pinned: false }],
      "2026-11-04": [{ id: "cat", assigned_staff_id: "ana", route_pinned: false }],
    };
    const supabase = {
      from: () => {
        let day = "";
        const chain: any = {
          select: () => chain,
          in: () => chain,
          gte: () => chain,
          lte: () => chain,
          eq: (col: string, v: string) => {
            if (col === "scheduled_on") day = v;
            return chain;
          },
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          then: (res: (v: unknown) => unknown) =>
            Promise.resolve({ data: today[day] ?? [], error: null }).then(res),
        };
        return chain;
      },
      rpc: async () => ({ data: null, error: null }),
    } as any;
    const dayPlan = (day: string, id: string) => ({
      day,
      routes: [{ staff_id: "ana", visit_ids: [id] }],
      unassigned: [],
      honourWindows: true,
      before: [],
      solver: { ms: 1, rounds: 1, stoppedBy: "converged", stops: 1 },
      visitsBefore: [{ visitId: id, staffId: "ana", pinned: false }],
      moves: [],
      reordered: 1,
    });
    const r = await runAutoRouting(supabase, {
      orgId: "org",
      runId: "run",
      data: {
        staffIds: ["ana"],
        from: "2026-11-03",
        to: "2026-11-04",
        level: "thorough",
        reassign: false,
        windows: "org",
      },
      preview: {
        reassign: false,
        plans: [dayPlan("2026-11-03", "dog"), dayPlan("2026-11-04", "cat")],
        skipped: [],
        estimatedDays: [],
        partlyEstimatedDays: [],
      },
      progress: async () => true,
    });
    expect(applyRoutePlans.mock.calls[0][1].plans.map((p) => p.day)).toEqual(["2026-11-04"]);
    expect(r.skipped).toEqual([
      expect.objectContaining({
        day: "2026-11-03",
        reason: expect.stringMatching(/Preview again/),
      }),
    ]);
    vi.doUnmock("@/lib/route-plan.server");
    vi.doUnmock("@/lib/field-notify.server");
    vi.doUnmock("@/lib/push-liveactivity.server");
  });
});

describe("the database holds the pin too", () => {
  const sql = read(MIGRATION);

  it("adds one column, not null, false by default", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS route_pinned boolean NOT NULL DEFAULT false/);
    // RLS unchanged: nothing in this file touches a policy.
    expect(sql).not.toMatch(/CREATE POLICY|ALTER POLICY|DROP POLICY|ROW LEVEL SECURITY/);
  });

  it("route_day_inputs reads a pinned visit as fixed, the rule readDay above mirrors", () => {
    expect(sql).toContain(
      "((NOT COALESCE(_reassign, false) OR v.route_pinned) AND v.assigned_staff_id IS NOT NULL)",
    );
  });

  it("apply_route_plan refuses to move a pinned visit, and never unassigns one", () => {
    expect(sql).toContain("The plan moves a stop that is pinned to its technician");
    expect(sql).toContain("COALESCE(_reassign, false) AND NOT v.route_pinned THEN NULL");
  });

  it("splices named functions only", () => {
    const calls = [...sql.matchAll(/pg_get_functiondef\(\s*'([^']+)'::regprocedure\)/g)].map(
      (m) => m[1],
    );
    expect(calls).toEqual([
      "public.route_day_inputs(uuid,uuid[],date,boolean)",
      "public.apply_route_plan(uuid,uuid[],date,boolean,jsonb,boolean,uuid[])",
    ]);
  });
});

describe("the panel asks, every time", () => {
  const panel = read("src/components/routes/AutoRoutingPanel.tsx");

  it("the switch starts off and is not stored", () => {
    expect(panel).toMatch(/const \[reassign, setReassign\] = useState\(false\)/);
    expect(panel).not.toMatch(/localStorage|sessionStorage/);
  });

  it("the preview is dropped when any input changes, the switch included", () => {
    expect(panel).toMatch(
      /const inputsKey = JSON\.stringify\(\[from, to, \[\.\.\.chosen\]\.sort\(\), windows, reassign\]\)/,
    );
    expect(panel).toMatch(/shownPreview\?\.key === inputsKey \? shownPreview\.preview : null/);
  });

  it("the server will not write without a preview, and uses the preview's reassign", () => {
    const fns = read("src/lib/routing-runs.functions.ts");
    const start = fns.slice(fns.indexOf("export const startRoutingRun"));
    expect(start).toMatch(/preview: routePreview,/);
    expect(start).toMatch(/data: \{ \.\.\.input, reassign: preview\.reassign \}/);
    const preview = fns.slice(
      fns.indexOf("export const previewRoutingRun"),
      fns.indexOf("export const startRoutingRun"),
    );
    expect(preview).toMatch(/reassign: z\.boolean\(\)\.default\(false\)/);
  });
});
