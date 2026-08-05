// A button labelled "Optimize", sitting under text that said it "re-sequences
// what they already have", reassigned every visit on the day to one person.
//
//   routes.tsx  optimize({ staffId, day, reassign: true })
//   optimize_route_v2  WHERE ... AND (_reassign OR assigned_staff_id IS NULL
//                                      OR assigned_staff_id = _staff_id)
//                      UPDATE visits SET assigned_staff_id = _staff_id
//
// With _reassign true the WHERE stops filtering by tech, so the selection is
// every scheduled visit in the org on that date, and the UPDATE writes the
// chosen tech onto all of them. Pick a tech, press Optimize, and one person
// owned the entire day. No confirm, no preview, no undo — one toast saying
// "Optimized N stops".
//
// The card is gone. Everything it did is reachable from Auto-routing, which
// previews before it writes and never silently reassigns unless you turn that
// on yourself.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const routes = readFileSync(
  join(import.meta.dirname, "..", "src/routes/_authenticated/routes.tsx"),
  "utf8",
);

describe("the silent whole-day reassignment is gone", () => {
  it("nothing on the routes page calls optimize with reassign: true", () => {
    // The precise shape of the bug. `reassign` is still a legitimate OPTION in
    // the auto-routing card — the difference is that it is off by default,
    // labelled, and previewed before it writes.
    expect(routes).not.toMatch(/optimize\(\{\s*data:\s*\{[^}]*reassign:\s*true/);
  });

  it("the legacy one-tech card and its mutations are removed", () => {
    // Checks DECLARATIONS, not mentions. The first version of this test
    // searched for the bare names and failed on the comment that explains why
    // they were deleted — a comment naming a removed thing is exactly what you
    // want to survive, so the test was wrong, not the code.
    for (const decl of [
      "const assignMut = useMutation",
      "const optimizeMut = useMutation",
      "const weekMut = useMutation",
      "const reoptMut = useMutation",
      "const [assignStaffId",
      "const [weekDays",
    ]) {
      expect(routes, `${decl} should be gone`).not.toContain(decl);
    }
    // The card's own heading, which appears nowhere else.
    expect(routes).not.toMatch(/>\s*One tech, one day\s*</);
  });

  it("removes the claim that Optimize only re-sequences", () => {
    expect(routes).not.toMatch(/re-sequences what they\s+already have/);
  });

  it("keeps the Settings pointer the card carried", () => {
    // The one thing on that card with no equivalent elsewhere.
    expect(routes).toMatch(/settings\/scheduling/);
  });
});

describe("week and month can draw a route again", () => {
  it("no longer disables routes on the multi-day map", () => {
    expect(routes).not.toMatch(/drawRoutes=\{false\}/);
    expect(routes).toMatch(/drawRoutes\s*\n\s*multiDay/);
  });

  it("groups per day when the map spans days", () => {
    // `sequence` restarts at 1 each morning. Grouped by tech alone, a week
    // sorted by sequence interleaves days and the polyline zig-zags — which is
    // why routes were switched off here rather than fixed.
    const map = readFileSync(
      join(import.meta.dirname, "..", "src/components/RouteMap.tsx"),
      "utf8",
    );
    expect(map).toMatch(/perDay = false/);
    expect(map).toMatch(/groups\.push\(\{ \.\.\.base, day, visits: dayVisits \}\)/);
    // One colour per tech, taken before the per-day split — otherwise a tech
    // with five days would eat five colours and every calendar chip would
    // disagree with its own pin.
    expect(map).toMatch(/const color = TECH_COLORS\[ci % TECH_COLORS\.length\];\s*\n\s*ci\+\+;/);
  });

  it("hovering lights the whole day, not two legs", () => {
    const map = readFileSync(
      join(import.meta.dirname, "..", "src/components/RouteMap.tsx"),
      "utf8",
    );
    expect(map).toMatch(/dayLegRefs/);
    expect(map).toMatch(/groupOfVisit/);
    // And the faint base style must match what was drawn, or the first
    // hover-out promotes every week line to full strength permanently.
    expect(map).toMatch(/multiDay\s*\n?\s*\?\s*\{ weight: dashed \? 1\.5 : 2, opacity: 0\.12 \}/);
  });
});
