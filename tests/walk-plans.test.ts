import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { walkWindowsProblem } from "@/lib/subscription-form";
import { buildDay, planDay } from "@/lib/route-inputs";
import { walkDay } from "./support/walk-day";
import { evaluateRoute, solveRoutes } from "@/lib/route-solver";

const read = (path: string) => readFileSync(join(import.meta.dirname, "..", path), "utf8");
const morning = { earliestTime: "11:00", latestTime: "13:00" };
const afternoon = { earliestTime: "16:00", latestTime: "18:00" };

describe("one plan per walk time", () => {
  it("accepts separate windows, overlapping windows and up to six walk times", () => {
    expect(walkWindowsProblem([morning, afternoon])).toBeNull();
    expect(
      walkWindowsProblem([morning, { earliestTime: "12:00", latestTime: "14:00" }]),
    ).toBeNull();
    expect(
      walkWindowsProblem(
        Array.from({ length: 6 }, (_, i) => ({ earliestTime: `0${i}:00`, latestTime: `0${i}:30` })),
      ),
    ).toBeNull();
  });

  it("refuses duplicate, missing, invalid and reversed windows and more than six", () => {
    expect(walkWindowsProblem([morning, morning])).toMatch(/different arrival window/);
    expect(walkWindowsProblem([])).toMatch(/1 and 6/);
    expect(walkWindowsProblem(Array(7).fill(morning))).toMatch(/1 and 6/);
    for (const window of [
      { earliestTime: "", latestTime: "13:00" },
      { earliestTime: "11:00", latestTime: "" },
      { earliestTime: "24:00", latestTime: "25:00" },
      { earliestTime: "11:60", latestTime: "13:00" },
    ])
      expect(walkWindowsProblem([window])).toMatch(/earliest and latest/);
    expect(walkWindowsProblem([{ earliestTime: "13:00", latestTime: "11:00" }])).toMatch(/before/);
    expect(walkWindowsProblem([{ earliestTime: "11:00", latestTime: "11:00" }])).toMatch(/before/);
  });

  it("routes both visits at the same coordinates inside their own windows", () => {
    const inputs = walkDay();
    const built = buildDay(inputs, { day: "2026-10-19", honourWindows: true });
    expect(built.stopIds).toEqual(["walk-0", "walk-1"]);
    expect(built.problem.stops.map((stop) => [stop.earliest, stop.latest])).toEqual([
      [180, 300],
      [480, 600],
    ]);
    const options = { rounds: 20, timeLimitMs: 60_000, seed: 7, now: () => 0 };
    const solved = solveRoutes(built.problem, options);
    expect(solved.routes).toEqual([[0, 1]]);
    expect(evaluateRoute(built.problem, 0, solved.routes[0]).late).toBe(0);
    let clock = 0;
    let previous = built.problem.techs[0].start;
    for (const index of solved.routes[0]) {
      const stop = built.problem.stops[index];
      clock +=
        previous == null
          ? 0
          : Math.round(built.problem.matrix[previous * built.problem.size + index]);
      clock = Math.max(clock, stop.earliest!);
      expect(clock).toBeGreaterThanOrEqual(stop.earliest!);
      expect(clock).toBeLessThanOrEqual(stop.latest!);
      clock += stop.service;
      previous = index;
    }
    const plan = planDay(inputs, { day: "2026-10-19", honourWindows: true, solver: options });
    expect(plan.unassigned).toEqual([]);
    expect(plan.routes[0].visit_ids).toEqual(["walk-0", "walk-1"]);
  });

  it("keeps editing and pet waste on the single-plan path", () => {
    const form = read("src/components/client-detail/ServicesTab.tsx");
    expect(form).toContain('!subscription && chosenService?.service_line === "dog_walking"');
    expect(form).toContain("extraWalkWindows.length >= 5");
    expect(form).toMatch(/subscription\s*\? updateFn/);
    expect(form).toMatch(/creatingWalk && extraWalkWindows.length > 0\s*\? createWalksFn/);
    const server = read("src/lib/walk-plans.functions.ts");
    expect(server).toContain("walkWindowsProblem(windows)");
    expect(server).toContain("createSubSchema.parse({ ...base, ...window })");
    expect(server).toContain(
      "createSubscriptionPlans(context.supabase, context.userId, data, true)",
    );
    const shared = read("src/lib/subscriptions.functions.ts");
    expect(shared).toContain('requirePermission(supabase, userId, "manage_pricing")');
    expect(shared).toMatch(/\.insert\(\s*plans\.map/);
    expect(shared).toContain("await generateVisitHorizon(supabase, client.organization_id)");
    expect(shared).toContain('service?.service_line !== "dog_walking"');
  });
});
