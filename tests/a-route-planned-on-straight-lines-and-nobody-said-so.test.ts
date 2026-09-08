import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The planner prefers measured road legs and falls back to a straight-line
// estimate for anything unmeasured. The fallback is right and stays: a
// dispatcher whose routing engine is down still needs a plan, and
// refreshRoadLegs is a cache warm, not a dependency.
//
// What was wrong is that the fallback was invisible. `await
// refreshRoadLegs(orgId, day)` discarded its result, so a day measured against
// the road network and a day invented from straight lines produced identical
// output.
//
// That is not "the ETA may be off". road-legs.server.ts opens with the
// measurement: the road runs 1.44x to 2.42x the straight line against a model
// assuming a flat 1.45x, a hop OSRM drives in 22 minutes was costed at 66.7,
// and a solver minimising the wrong quantity picks the wrong ORDER. The
// dispatcher then drives that order.

const LEGS = readFileSync(join(process.cwd(), "src/lib/road-legs.server.ts"), "utf8");
const VISITS = readFileSync(join(process.cwd(), "src/lib/visits.functions.ts"), "utf8");
const PANEL = readFileSync(
  join(process.cwd(), "src/components/routes/AutoRoutingPanel.tsx"),
  "utf8",
);

const legsCode = LEGS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

describe("the six ways to measure nothing are no longer one number", () => {
  it("returns a result rather than a bare count", () => {
    expect(legsCode).toMatch(/Promise<RoadLegResult>/);
    expect(legsCode).toMatch(/export type RoadLegProblem =/);
  });

  it("names each cause", () => {
    for (const p of [
      "too_many_points",
      "router_unreachable",
      "router_error",
      "wrong_region",
      "nothing_usable",
      "save_failed",
    ]) {
      expect(legsCode, `no cause named ${p}`).toMatch(new RegExp(`"${p}"`));
    }
  });

  it("does not call an empty day a degraded one", () => {
    // A day with fewer than two points has nothing to measure. Reporting it as
    // a problem would put a warning on the screen of every workspace with a
    // single stop, which is the mirror of the fault being fixed.
    expect(legsCode).toMatch(/if \(points\.length < 2\) return nothingToMeasure;/);
    expect(legsCode).toMatch(/const nothingToMeasure: RoadLegResult = \{ measured: 0, problem: null/);
  });

  it("keeps the partial case separate from the total one", () => {
    // Some points outside the graph means the day is neither cleanly measured
    // nor cleanly estimated, and a single problem code cannot say that.
    expect(legsCode).toMatch(/pointsOutsideGraph: bad\.size/);
  });

  it("still writes what it did measure when only some points were bad", () => {
    // The mutation this guards: treating any bad point as a whole-day failure.
    // Only ALL points bad is `wrong_region`.
    expect(legsCode).toMatch(/if \(bad\.size === points\.length\) return failed\("wrong_region"\)/);
  });
});

describe("the planner collects it instead of discarding it", () => {
  it("no longer throws the result away", () => {
    expect(VISITS).not.toMatch(/^\s*await refreshRoadLegs\(orgId, day\);\s*$/m);
    expect(VISITS).toMatch(/const legs = await refreshRoadLegs\(orgId, day\)/);
  });

  it("returns both lists to the caller", () => {
    expect(VISITS).toMatch(/return \{ stops, skipped, balance, forecast, estimatedDays, partlyEstimatedDays \}/);
  });

  it("counts a thrown import as an outage rather than leaving it out", () => {
    // refreshRoadLegs returns its own failures, so a throw here is something
    // below it. The day is on estimates either way.
    const block = VISITS.slice(VISITS.indexOf("const legs = await refreshRoadLegs"));
    const cat = block.slice(block.indexOf("} catch"), block.indexOf("plan_day_across_staff"));
    expect(cat).toMatch(/estimatedDays\.push/);
  });

  it("still does not fail the run when measurement fails", () => {
    // It is a cache warm, not a dependency. A dispatcher whose router is down
    // must still get a plan.
    const block = VISITS.slice(
      VISITS.indexOf("const legs = await refreshRoadLegs"),
      VISITS.indexOf("plan_day_across_staff"),
    );
    expect(block).not.toMatch(/\bthrow\b/);
  });
});

describe("and the dispatcher is told before they drive it", () => {
  it("warns about days planned from estimates", () => {
    expect(PANEL).toMatch(/r\.estimatedDays\.length > 0/);
    expect(PANEL).toMatch(/straight-line estimates, not measured roads/);
  });

  it("says the ORDER may be wrong, not merely the times", () => {
    // The whole argument of road-legs.server.ts is that the objective, not the
    // display, is what goes wrong. "ETA may be off" would understate it.
    expect(PANEL).toMatch(/stop order may not be the best road route/i);
  });

  it("names the cause, checked by the type rather than by hand", () => {
    expect(PANEL).toMatch(/const ROAD_LEG_REASON: Record<RoadLegProblem, string>/);
    for (const p of [
      "router_unreachable",
      "router_error",
      "wrong_region",
      "too_many_points",
      "nothing_usable",
      "save_failed",
    ]) {
      expect(PANEL, `no sentence for ${p}`).toMatch(new RegExp(`${p}:\\s*\\n?\\s*"`));
    }
  });

  it("keeps the partial case a different sentence", () => {
    // Folding it into the other warning would overstate it; leaving it out
    // would understate it.
    expect(PANEL).toMatch(/r\.partlyEstimatedDays\.length > 0/);
    expect(PANEL).toMatch(/some stops sit outside the routing map/);
  });

  it("holds both longer than the default toast", () => {
    const i = PANEL.indexOf("r.estimatedDays.length > 0");
    expect(PANEL.slice(i, i + 700)).toMatch(/duration: 12000/);
    const j = PANEL.indexOf("r.partlyEstimatedDays.length > 0");
    expect(PANEL.slice(j, j + 500)).toMatch(/duration: 12000/);
  });
});
