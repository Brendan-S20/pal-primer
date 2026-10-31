// Auto-routing gave the whole day to one technician.
//
// Owner report, 2026-08-15: "I am attempting to utilize the functions with 3
// techs; it doesn't split the route, it assigns it all to one."
//
// ── THE SHAPE OF THE BUG, WHICH IS WHY THIS TEST IS SHAPED LIKE THIS ──────
//
// Nothing was broken. The step was missing. Every planner in the database
// takes ONE `_staff_id` and selects the whole organisation's day:
//
//   AND (_reassign OR v.assigned_staff_id IS NULL
//                  OR v.assigned_staff_id = _staff_id)
//
// and applyOptimize looped the selected technicians calling it once each:
//
//   for (const staffId of data.staffIds)
//     for (const day of days)
//       rpc("optimize_route_v3", { _staff_id: staffId, ... })
//
// Three calls, each claiming every visit. With reassign on the LAST technician
// kept the day; with it off the FIRST took it and the other two found nothing.
// Both are "all on one", which is what was reported, and re-running never
// helped because the second run did the same thing.
//
// So the regression this guards is not a wrong number — it is a loop of the
// wrong shape. A test that mocked the RPC and counted stops would have passed
// happily before the fix: 20 stops were routed, all to one person. What has to
// be pinned is that ONE call receives ALL the technicians.
//
// Verified against the live demo organisation before this was written, since a
// structural test cannot prove the planner works:
//
//   before   2026-08-18   20 visits, techs_used = 1
//   after    2026-08-18   7 / 7 / 6 stops, sequenced 1..n, 0 window breaches,
//                         11.4 / 14.2 / 16.4 km, 221 / 243 / 249 minutes
//
// and the unassigned-only mode on a day with nothing unassigned correctly did
// nothing at all rather than erroring.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Comments are not code — the prose above quotes the very loop being banned. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

describe("applying auto-routing hands the whole team to one planner", () => {
  // CHANGED 2026-10-04: the run moved to auto-routing.server.ts when it
  // became a background job; the server function applyOptimize is gone.
  const fn = codeOnly(read("src/lib/auto-routing.server.ts"));
  // CHANGED 2026-10-31 (#609): the days are planned by planAutoRouting (the
  // preview) and written by runAutoRouting, which follows it in the file, so
  // the slice starts at the planner and still covers the write.
  const apply = fn.slice(fn.indexOf("export async function planAutoRouting"));

  it("plans each day for the selected technicians together", () => {
    // CHANGED 2026-10-02: the planner moved out of plan_day_across_staff into
    // route-plan.server.ts (read, solve, write), and the whole selected team
    // still goes to it at once. The plural is the entire fix: the selected
    // technicians passed whole is what makes a split possible at all.
    //
    // CHANGED 2026-10-04: the write is apply_route_plans, once per run, and
    // it takes the people from the RUN's own row rather than from the caller,
    // so the read is the one place the app passes them and the write cannot
    // be handed somebody the run was not started for.
    expect(apply).toMatch(/planDayRoutes\(supabase, \{/);
    expect(apply).toMatch(/staffIds:\s*data\.staffIds/);
    const plan = codeOnly(read("src/lib/route-plan.server.ts"));
    expect(plan).toMatch(/rpc\("route_day_inputs"/);
    expect(plan).toMatch(/rpc\("apply_route_plans"/);
    expect(plan.match(/_staff_ids:\s*args\.staffIds/g)).toHaveLength(1);
    const runs = read("supabase/migrations/20261004160000_routing-runs-in-the-background.sql");
    expect(runs).toMatch(/public\.apply_route_plan\(\s*_run\.organization_id, _run\.staff_ids, _day/);
  });

  it("no longer calls the single-technician planner once per technician", () => {
    // optimize_route_v3 is not deleted — it is still the right thing for one
    // person's day, and preview/other callers use it. What must not come back
    // is applyOptimize reaching for it, because it cannot divide anything.
    expect(apply).not.toMatch(/rpc\("optimize_route_v3"/);
    expect(apply).not.toMatch(/rpc\("assign_route_for_day"/);
  });

  it("loops days only, never technicians", () => {
    // The tell of the original bug: a loop over staffIds around the RPC call.
    // One call per day is correct; one call per technician per day is the bug.
    const loopVars = [...apply.matchAll(/for\s*\(\s*const\s+(\w+)\s+of\s+([\w.]+)\s*\)/g)].map(
      (m) => `${m[1]} of ${m[2]}`,
    );
    expect(loopVars, "applyOptimize must not iterate the technicians").not.toContain(
      "staffId of data.staffIds",
    );
    expect(loopVars.some((l) => l.endsWith("of days"))).toBe(true);
  });

  it("reports the split back, so the screen can show it happened", () => {
    // "Re-ordered 20 stops" was equally true before and after the fix. The
    // per-technician breakdown is what tells a dispatcher the work was
    // actually divided.
    expect(apply).toMatch(/const balance =/);
    // CHANGED 2026-08-19, when the preview STEP was removed from the panel.
    // The return grew a fourth member, `forecast` — the read-only planner's
    // measurement, taken by applyOptimize just before it writes, because it is
    // the only thing that still knows how many stops will miss their arrival
    // window. The three that were here are named individually rather than
    // relaxed to a wildcard: this assertion exists to notice a member going
    // MISSING, and /return \{ stops, .* \}/ would not have.
    //
    // CHANGED 2026-09-08: two more members, `estimatedDays` and
    // `partlyEstimatedDays` — which days were planned from straight-line
    // estimates because the road legs could not be measured, and which were
    // only partly measured. Still named individually rather than relaxed to a
    // wildcard, for the reason above: this assertion exists to notice a member
    // going MISSING.
    //
    // CHANGED 2026-10-02: a seventh, `fit` -- which technician-days finish
    // after the workday ends or run past capacity, and which stops have no
    // location -- because the routing trials planned a day to 02:51 the next
    // morning and the toast said only "Routed 40 stops". Named individually,
    // for the same reason as the others.
    //
    // CHANGED 2026-10-02 again, with the TypeScript solver: three more --
    // whether arrival windows were honoured, and the windows the plan misses
    // (named, and counted past the fifty it names) -- so a run that set
    // windows aside cannot drop them silently. The return is now one member
    // per line; the order is still pinned.
    expect(apply).toMatch(
      /return \{\s*stops,\s*skipped,\s*balance,\s*forecast,\s*estimatedDays,\s*partlyEstimatedDays,\s*fit,\s*windowsHonoured,[\s\S]{0,200}windowMisses:[\s\S]{0,80}windowMissCount:/,
    );

    const panel = codeOnly(read("src/components/routes/AutoRoutingPanel.tsx"));
    expect(panel).toMatch(/r\.balance/);
    expect(panel).toMatch(/nameOf\(/);
  });
});

describe("the planner that does the splitting", () => {
  const sql = read(
    "supabase/migrations/20260815170000_auto-routing-gave-the-whole-day-to-one-technician.sql",
  );

  it("takes an array of technicians, unlike every planner before it", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.plan_day_across_staff/);
    expect(sql).toMatch(/_staff_ids uuid\[\]/);
  });

  it("balances on measured minutes, which is what the owner asked for", () => {
    // Owner call, 2026-08-15: even means equal WORKING TIME, service plus
    // drive — not equal stop count. The sweep alone cannot deliver that,
    // because drive time is unknown until a cluster has been sequenced.
    expect(sql).toMatch(/staff_day_minutes/);
    expect(sql).toMatch(/_spread/);
    expect(sql).toMatch(/service_duration_min, 8\) \+ COALESCE\(v\.travel_min, 0\)/);
  });

  it("undoes a rebalancing move that did not help", () => {
    // Without this the loop can hand the same visit back and forth until it
    // runs out of passes, leaving the routes churned and no better.
    expect(sql).toMatch(/IF _new_spread >= _spread THEN/);
    expect(sql).toMatch(/UPDATE public\.visits SET assigned_staff_id = _hi WHERE id = _move_id;/);
  });

  it("will not touch somebody who was not selected", () => {
    // Even with reassign on. A technician the dispatcher deliberately left
    // out, or who is on leave, keeps their work.
    expect(sql).toMatch(/v\.assigned_staff_id = ANY\(_eligible\)/);
  });

  it("refuses people who cannot be routed, and says why", () => {
    expect(sql).toMatch(/is_field_tech/);
    expect(sql).toMatch(/is_staff_off/);
    expect(sql).toMatch(/check "Runs routes" and time off/);
  });

  it("resolves a start point through a chain rather than reading staff directly", () => {
    // A technician with no start address was routed from NULL, and the solver
    // does not fail on that — it coalesces every candidate to a flat 5.0 km,
    // so the first stop is whichever row came back first and the route can
    // begin in the middle and cross itself getting out. Two of the three demo
    // technicians are in exactly that state, which is also what a new account
    // looks like before anybody fills in the team page.
    const chain = read(
      "supabase/migrations/20260815180000_a-technician-with-no-start-address-started-from-nowhere.sql",
    );
    expect(chain).toMatch(/CREATE OR REPLACE FUNCTION public\.staff_start_point/);
    for (const tier of ["'staff'", "'business'", "'disposal'", "'route'", "'none'"]) {
      expect(chain, `the ${tier} tier is missing from the chain`).toContain(tier);
    }
    // The order is the whole point: a personal address beats the depot, which
    // beats a dump site, which beats guessing from the work.
    const order = ["'staff'", "'business'", "'disposal'", "'route'"].map((t) => chain.indexOf(t));
    expect(order, "the fallback tiers are out of order").toEqual([...order].sort((a, b) => a - b));

    // And plan_route must actually USE it. Splicing into pg_get_functiondef
    // means the check has to be that the old read is gone, not that a new
    // line was added to a file.
    expect(chain).toMatch(/strpos\(_after, 'start_latitude'\) > 0 THEN/);
    expect(chain).toMatch(/plan_route still reads staff\.start_latitude directly/);
  });

  it("adds the columns tiers 2 and 3 need", () => {
    const chain = read(
      "supabase/migrations/20260815180000_a-technician-with-no-start-address-started-from-nowhere.sql",
    );
    expect(chain).toMatch(/ALTER TABLE public\.organizations[\s\S]*ADD COLUMN IF NOT EXISTS latitude/);
    expect(chain).toMatch(
      /ALTER TABLE public\.waste_disposal_facilities[\s\S]*ADD COLUMN IF NOT EXISTS latitude/,
    );
  });

  it("and something actually fills them, on save and for the existing rows", () => {
    // Two columns nobody writes to are two dead columns, and the chain tier
    // above them is decoration. Geocoding runs in TypeScript, not SQL, so the
    // wiring lives in three places and all three are pinned here.
    const org = codeOnly(read("src/lib/org.functions.ts"));
    expect(org).toMatch(/geocodeAddress\(\{ street: data\.contactAddress \}\)/);
    expect(org).toMatch(/patch\.latitude = geo\?\.latitude \?\? null/);

    const stations = codeOnly(read("src/lib/stations.functions.ts"));
    expect(stations).toMatch(/geocodeAddress\(\{ street: data\.address \}\)/);
    expect(stations).toMatch(/payload\.latitude = geo\?\.latitude \?\? null/);

    // And the rows already on file, which no one is going to re-save.
    const nightly = codeOnly(read("src/routes/api/public/hooks/nightly.ts"));
    expect(nightly).toMatch(/routing_anchors:/);
    expect(nightly).toMatch(/\.is\("latitude", null\)/);
    expect(nightly).toMatch(/orgs_pending/);
    expect(nightly).toMatch(/facilities_pending/);
  });

  it("clears the coordinates when the address is cleared", () => {
    // Stale coordinates are worse than none: the planner cannot doubt them, so
    // every route would keep starting from the previous premises.
    const org = codeOnly(read("src/lib/org.functions.ts"));
    const stations = codeOnly(read("src/lib/stations.functions.ts"));
    expect(org).toMatch(/else \{\s*patch\.latitude = null;\s*patch\.longitude = null;/);
    expect(stations).toMatch(/else \{\s*payload\.latitude = null;\s*payload\.longitude = null;/);
  });

  it("reuses the existing solver rather than replacing it", () => {
    // The single-vehicle solver was never the problem. Rewriting it would
    // have thrown away the time windows, the preference penalties and the
    // 2-opt pass for no reason.
    expect(sql).toMatch(/public\.plan_route\(_org_id, _staff_id, _day, false, _level\)/);
  });
});
