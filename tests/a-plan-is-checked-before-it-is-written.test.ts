// apply_route_plan (20261002090700) writes whatever order the TypeScript
// solver hands it -- so it must refuse a plan that is not a plan for THIS day.
//
// route_day_inputs and apply_route_plan are separate statements with the
// solver between them, and a dispatcher can add, cancel or reassign a visit
// in that gap. plan_day_across_staff never had the gap: it read and wrote in
// one statement. So the write checks, against the database as it is now,
// that the plan covers exactly the stops in play, each once, on people who
// can run today -- and, without reassign, leaves what was already somebody's
// with them. Each case below is a plan the write must refuse, and one it must
// take; all inside BEGIN ... ROLLBACK on the local stack, the way the routing
// trials run.

import { describe, expect, it } from "vitest";
import {
  DB_URL,
  buildSql,
  databaseReachable,
  runSql,
  uuidFor,
} from "../scripts/routing-trials/harness";
import { scenarioById } from "../scripts/routing-trials/scenarios";

const reachable = databaseReachable();
if (!reachable) {
  console.warn(
    `\n  SKIPPED: no database answered at ${DB_URL}; apply_route_plan was not checked.\n`,
  );
}

const sc = scenarioById("tiny");
const staff = uuidFor(sc.id, "staff", sc.techs[0].key);
const visits = sc.stops.map((st) => uuidFor(sc.id, "visit", st.key));

/** The write's error for this plan, or null when it was accepted. */
function apply(routes: unknown): string | null {
  const { tags, stderr } = runSql(buildSql(sc, [], { kind: "apply", routes, honourWindows: true }));
  const step = tags.steps?.find((s) => s.step === "apply");
  if (!step) throw new Error(`the apply step did not run:\n${stderr.slice(-800)}`);
  return step.ok ? null : step.err;
}

describe.skipIf(!reachable)("apply_route_plan refuses a plan that is not for this day", () => {
  it("takes a plan that covers every stop once, on someone who can run", () => {
    expect(apply([{ staff_id: staff, visit_ids: visits }])).toBeNull();
  });

  it("refuses a plan missing a stop: the day changed after it was read", () => {
    expect(apply([{ staff_id: staff, visit_ids: visits.slice(1) }])).toMatch(
      /day changed while it was being planned/,
    );
  });

  it("refuses a plan with a stop that is not in play", () => {
    const stranger = uuidFor("some other day", "visit", "x");
    expect(apply([{ staff_id: staff, visit_ids: [...visits, stranger] }])).toMatch(
      /day changed while it was being planned/,
    );
  });

  it("refuses a stop planned twice", () => {
    expect(apply([{ staff_id: staff, visit_ids: [...visits, visits[0]] }])).toMatch(/twice/);
  });

  it("refuses a route for somebody who cannot be routed", () => {
    const nobody = uuidFor(sc.id, "staff", "not-a-technician");
    expect(
      apply([
        { staff_id: staff, visit_ids: visits.slice(1) },
        { staff_id: nobody, visit_ids: visits.slice(0, 1) },
      ]),
    ).toMatch(/cannot be routed/);
  });
});
