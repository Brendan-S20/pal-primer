// Optimize was a button that rearranged the day and told you afterwards.
//
// On a route a dispatcher had already ordered by hand, pressing it was
// destructive and irreversible — the only way back was to re-drag the day.
// And the thing it reported, `assigned`, is a count of stops touched, which is
// not a question anybody has.
//
// The design that matters here is ONE PLANNER, TWO CALLERS. `plan_route`
// computes an ordering and writes nothing; `optimize_route_v3` applies it and
// `preview_optimize` measures it. A preview backed by its own estimate drifts
// from what Apply does, and the drift is invisible until somebody trusts the
// number. Most of these assertions exist to keep that single-source property.
//
// UPDATED 2026-08-19. "Preview" is no longer a button — QA asked for one press,
// not two, and the panel now has only Apply. Every SQL assertion below is
// untouched by that, because the measuring caller did not go anywhere: it moved
// inside applyOptimize, which runs `preview_optimize` immediately before it
// writes and reports what it said. Two callers, one planner, one press. The
// three assertions that named the removed UI say so where they stand.
//
// Probed live before this was written, acting as a real org owner via
// request.jwt.claims so the authz path ran rather than being bypassed:
//   * fast / balanced / thorough all returned 22.3 min over 6 stops
//   * thorough <= balanced held
//   * level 'turbo' raised "Unknown optimization level: turbo"
//   * preview said before=26.9 after=22.3 before_known=true
//   * apply then produced 22.2 actual against 22.3 promised — MATCH
//
// The 0.1 gap is per-row rounding summed vs summed-then-rounded, not drift.
//
// WHAT THE LIVE PROBE COULD NOT SHOW: 2-opt improving anything. The demo org's
// busiest day is 6 stops at the same six recurring properties, where greedy
// nearest-neighbour is already optimal — every day measured 22.3 at every
// level, so the gain was 0.0 everywhere. The pass was verified separately by
// feeding `route_segment_km` a deliberately self-crossing square: the crossed
// order measured 40.51 km and the uncrossed 30.33 km, a 10.18 km difference it
// correctly sees and would accept. So the comparison 2-opt rests on is proven;
// its benefit on real routes is not, and will not be until an org has days long
// enough to contain a crossing.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..", "supabase/migrations");
const SQL = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(dir, f), "utf8"))
  .join("\n");

// Reads the tag rather than assuming it. This used to hunt for a literal
// `AS $$` and then the next `$$;`, which is right for every definition that
// happened to be written with an anonymous dollar quote and quietly wrong for
// any other: `AS $fn$ ... $fn$;` does not contain `AS $$` at all, so
// `indexOf` ran on to the NEXT function in the concatenated file and returned
// either a slice of somebody else's body or "". Both are worse than failing,
// because every assertion below is a `toMatch` — and a pattern that is absent
// from the wrong body fails with a message about the right one.
//
// Found when 20260831130000 rewrote plan_route as `AS $fn$`, which is the tag
// most of this repo's newer migrations use.
function lastBody(name: string) {
  const at = SQL.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(at, `${name} is not defined`).toBeGreaterThan(-1);
  const open = /\sAS\s+(\$[A-Za-z_]*\$)/.exec(SQL.slice(at));
  expect(open, `${name} has no dollar-quoted body`).not.toBeNull();
  const bodyAt = at + open!.index + open![0].length;
  const end = SQL.indexOf(open![1], bodyAt);
  return SQL.slice(at, end === -1 ? undefined : end);
}

describe("one planner, two callers", () => {
  it("apply calls the planner rather than reimplementing it", () => {
    // The single most important assertion in this file. If optimize_route_v3
    // ever grows its own ordering loop, the preview becomes a lie.
    const apply = lastBody("optimize_route_v3");
    expect(apply).toMatch(/FROM public\.plan_route\(_org_id, _staff_id, _day, _reassign, _level\)/);
    expect(apply).not.toMatch(/haversine_km/);
    expect(apply).not.toMatch(/ORDER BY tmin/);
  });

  it("preview calls the same planner and writes nothing", () => {
    // UPDATED 2026-08-15 by 20260815190000. This used to read
    //
    //   expect(prev).toMatch(/FROM public\.plan_route\(_org_id, _s, _d, ...)/)
    //
    // and it was pinning the bug. `plan_route` plans ONE VEHICLE over the whole
    // organisation's day, so a preview that loops the selected technicians
    // calling it once each shows every one of them the entire day: 20 + 20 + 20
    // stops for a twenty-stop day. Correct as "preview and apply share a
    // planner" — which was true while both were single-technician — and wrong
    // from the moment Apply learned to divide a day between people.
    //
    // The planner they now share is the one that divides it, in its read-only
    // form. The property being pinned is unchanged: ONE planner, and the
    // preview is not allowed to be the caller that writes.
    const prev = lastBody("preview_optimize");
    expect(prev).toMatch(/FROM public\.plan_day_across_staff_dryrun\(_org_id, _staff_ids, _d,/);
    expect(prev).not.toMatch(/UPDATE public\.visits/);
    expect(prev).not.toMatch(/INSERT INTO public\.visits/);
    // And not the writing twin, whose name differs by a suffix.
    expect(prev).not.toMatch(/plan_day_across_staff\(/);
  });

  it("the planner itself never touches visits", () => {
    const plan = lastBody("plan_route");
    expect(plan).toMatch(/RETURN NEXT/);
    // It reads visits and writes only the temp table.
    expect(plan).not.toMatch(/UPDATE public\.visits/);
  });
});

describe("levels mean what they say", () => {
  it("rejects an unknown level rather than defaulting", () => {
    // Silently falling back would let a typo in a caller produce a different
    // route from the one the preview measured.
    expect(lastBody("plan_route")).toMatch(/RAISE EXCEPTION 'Unknown optimization level: %'/);
  });

  it("only 'fast' drops the window and preference penalties", () => {
    // A "better" level that quietly stopped honouring arrival windows would be
    // worse, not better. thorough = balanced + a pass, never balanced - rules.
    expect(lastBody("plan_route")).toMatch(/_use_penalties := \(_level <> 'fast'\)/);
  });

  it("bounds the 2-opt loop", () => {
    // This runs inside a request. An unbounded improvement loop on a
    // pathological day holds a connection instead of finishing.
    expect(lastBody("plan_route")).toMatch(/EXIT WHEN _pass > 8/);
  });

  it("compares and assigns the same reversed slice", () => {
    // Recomputing the reversal separately for the comparison and the
    // assignment is how a 2-opt pass ends up applying a move it did not
    // actually evaluate.
    //
    // This used to count the slice expression and require exactly 2 -- once
    // compared, once assigned -- which was the best available reading of "the
    // same" while the expression was written out twice. 20260831130000
    // materialises it into `_cand` instead, so the property is now structural
    // rather than textual: there is ONE candidate, it is the thing scored, and
    // it is the thing assigned. Requiring 2 here would now fail against the
    // version that cannot get this wrong, so the assertion follows the
    // variable.
    const plan = lastBody("plan_route");
    expect(plan).toMatch(/SELECT array_agg\(x ORDER BY ord DESC\) INTO _rev/);
    // Built exactly once. A second slice expression is a second reversal, and
    // whether it agrees with the first is exactly what this test exists to
    // stop anyone having to check by eye.
    expect(
      plan.match(/_order\[1:_i-1\] \|\| _rev \|\| _order\[_j\+1:array_length\(_order,1\)\]/g)
        ?.length,
    ).toBe(1);
    expect(plan).toMatch(
      /_cand := _order\[1:_i-1\] \|\| _rev \|\| _order\[_j\+1:array_length\(_order,1\)\];/,
    );
    // Scored and assigned, both by name.
    expect(plan).toMatch(/_cand_min := public\.route_segment_min\(_cand\);/);
    expect(plan).toMatch(/IF _cand_min < _base THEN/);
    expect(plan).toMatch(/_order := _cand;/);
  });

  it("scores the improvement pass in road minutes, not straight-line km", () => {
    // The half of 20260826180000 that was never finished. That migration
    // taught nearest-neighbour to score on drive_minutes and left the 2-opt
    // calling route_segment_km, so `thorough` built a route on road time and
    // then reordered it to shorten a straight line -- the improvement pass
    // undoing the objective the construction pass had just been given.
    //
    // Comments are stripped first: the fix carries a comment that names
    // route_segment_km in order to say it is gone, and a check answered by the
    // prose describing it is the fault this repo keeps re-finding.
    const code = lastBody("plan_route").replace(/--[^\n]*/g, "");
    expect(code).not.toMatch(/route_segment_km/);
    expect(code).toMatch(/route_segment_min/);
  });

  it("lets the 2-opt reach the last stop", () => {
    // `_j` ran to array_length - 1, so no segment ending at the final stop was
    // ever reversed. This is an open path -- the planner does not return to a
    // depot -- so reversing the tail changes exactly one edge and is an
    // ordinary improving move that was simply unreachable.
    const code = lastBody("plan_route").replace(/--[^\n]*/g, "");
    expect(code).toMatch(/FOR _j IN _i \+ 1 \.\. array_length\(_order,1\) LOOP/);
    expect(code).not.toMatch(/FOR _j IN _i \+ 1 \.\. array_length\(_order,1\) - 1 LOOP/);
  });

  it("reports a distance and a time that describe the same journey", () => {
    // The owner-visible half. travel_km was haversine while travel_min was the
    // cached road time plus park_walk_min, so the route screen printed pairs
    // like "0.21 km · 7.1 min" -- 1.8 km/h. Both now come from the same cached
    // leg, and the parking constant stays in the CLOCK rather than in the
    // number labelled travel.
    const code = lastBody("plan_route").replace(/--[^\n]*/g, "");
    expect(code).toMatch(/_tkm\s*:=\s*COALESCE\(public\.road_km\(/);
    expect(code).not.toMatch(/_tkm\s*:=\s*COALESCE\(public\.haversine_km\(/);
    // The clock still spends it; only the reported figure drops it.
    expect(code).toMatch(/_tmin\s*:=\s*GREATEST\(_drive - _park, 0\)/);
    expect(code).toMatch(/_es := _clock \+ make_interval\(mins => COALESCE\(_drive,0\)::int\)/);
  });
});

describe("it refuses to invent a saving", () => {
  it("reports whether the day had a route at all", () => {
    // An unsequenced day is not a slower route, it is no route. Measuring
    // against insertion order and calling the difference a saving is fiction.
    const cost = lastBody("route_cost_current");
    expect(cost).toMatch(/sequenced := \(_n > 0 AND _unseq = 0\)/);
    expect(lastBody("preview_optimize")).toMatch(/before_known := _cur\.sequenced/);
  });

  it("sums the saving only over days that had one", () => {
    const fn = readFileSync(join(import.meta.dirname, "..", "src/lib/visits.functions.ts"), "utf8");
    expect(fn).toMatch(/const measured = days\.filter\(\(d\) => d\.before_known\)/);
    expect(fn).toMatch(/measured\.reduce/);
  });

  it("the UI says 'new route' rather than a number when nothing was ordered", () => {
    // CHANGED 2026-08-19. The sentences moved: the preview STEP is gone, so
    // this is no longer a result box the dispatcher reads before deciding, it
    // is the description line on the toast Apply raises afterwards. The
    // property is the same one and is the reason this `it` was written — the
    // panel must not put a number on a day that had no route to compare
    // against — so it is repointed rather than deleted.
    const ui = readFileSync(
      join(import.meta.dirname, "..", "src/components/routes/AutoRoutingPanel.tsx"),
      "utf8",
    );
    expect(ui).toMatch(/New route/);
    // The saving is fenced behind that same question, and this is the fence.
    // Without it "Saves about 0 min" is what an unordered day would print.
    expect(ui).toMatch(/if \(f\.daysMeasured === 0\)/);
    // And it is still willing to say the optimizer made things worse — in the
    // past tense now, because by the time anybody reads it, it has.
    expect(ui).toMatch(/the order it replaced was quicker/);
  });
});

describe("the guards still apply, and refusals are visible", () => {
  it("apply checks eligibility and availability", () => {
    const apply = lastBody("optimize_route_v3");
    expect(apply).toMatch(/PERFORM public\.assert_runs_routes\(_staff_id\)/);
    expect(apply).toMatch(/PERFORM public\.assert_available_on\(_staff_id, _day\)/);
  });

  it("preview skips days the tech is away rather than planning them", () => {
    // Otherwise the preview offers a route whose Apply the trigger refuses.
    //
    // UPDATED 2026-08-15 by 20260815190000. The test used to look for
    // `IF NOT public.is_staff_off(_s, _d) THEN` inside preview_optimize, which
    // was the whole of the preview's idea of eligibility — time off, and
    // nothing else. It offered routes for people who do not run routes and for
    // people switched off entirely, and Apply refused every one of them.
    //
    // The question is now asked once, by routable_staff, for all three callers.
    // Pinned in two halves, because either alone can go green while the
    // eligibility is gone: the preview reaches the planner that asks, and the
    // thing it asks still knows about time off.
    expect(lastBody("preview_optimize")).toMatch(/plan_day_across_staff_dryrun\(/);
    expect(lastBody("plan_day_across_staff_dryrun")).toMatch(/public\.routable_staff\(/);
    expect(lastBody("routable_staff")).toMatch(/NOT public\.is_staff_off\(s\.id, _day\)/);
  });

  it("a skipped day is reported, not swallowed", () => {
    const fn = readFileSync(join(import.meta.dirname, "..", "src/lib/visits.functions.ts"), "utf8");
    expect(fn).toMatch(/skipped\.push\(/);
    const ui = readFileSync(
      join(import.meta.dirname, "..", "src/components/routes/AutoRoutingPanel.tsx"),
      "utf8",
    );
    expect(ui).toMatch(/r\.skipped\.slice\(0, 3\)/);
  });

  it("Apply is guarded by its inputs, now that there is no preview to gate it", () => {
    // CHANGED 2026-08-19 — QA: "Also remove the preview, let's just have
    // apply." This used to read
    //
    //   expect(ui).toMatch(/disabled=\{!p \|\| applyMut\.isPending/);
    //
    // and there is no `p` any more. Deleting the assertion would have left the
    // one button in this panel with nothing said about when it may be pressed,
    // so it is repointed at what the gate actually protected against: a range
    // that runs backwards, and a run with nobody in it. The planner rejects
    // both, and a disabled button says so before the round trip.
    const ui = readFileSync(
      join(import.meta.dirname, "..", "src/components/routes/AutoRoutingPanel.tsx"),
      "utf8",
    );
    expect(ui).toMatch(/disabled=\{!rangeValid \|\| techs\.length === 0 \|\| busy\}/);
    expect(ui, "the preview gate is back").not.toMatch(/previewMut/);
  });
  it("costs the drive from the last stop to where the day ends", () => {
    // Before 20260831150000 the planner resolved a START and then planned an
    // OPEN path: the last stop of the day was chosen as though the van
    // evaporates on arrival. staff.end_latitude has existed since 20260703 and
    // Settings has always collected it under "Route end (dump, home, shop)";
    // RouteMap even drew the marker. The solver had never read it.
    //
    // Measured on the demo day with the dump at a cached coordinate: the
    // end-blind order left 116.3 minutes of driving still to do, the end-aware
    // one 22.3. Same stops, same technicians.
    const code = lastBody("plan_route").replace(/--[^\n]*/g, "");
    expect(code).toMatch(/public\.staff_end_point\(_org_id, _staff_id\)/);
    // The closing leg goes into the same matrix as every other leg, so it is
    // priced by the road and not by the 11 km/h fallback.
    expect(code).toMatch(/INSERT INTO _legs \(from_id, to_id, minutes\)[\s\S]{0,400}_END/);
  });

  it("degrades to an open path when nothing resolves an end", () => {
    // Most orgs have neither a technician end address nor a geocoded dump
    // today — 2 of 7 and 0 of 6 on 2026-08-31 — so the no-end case is the
    // common one and must be exactly the old behaviour. The END rows are
    // inserted only inside the guard, so route_segment_min finds nothing to
    // add. Verified in Postgres: 38.0 / 35.5 / 17.4, bit-identical.
    const code = lastBody("plan_route").replace(/--[^\n]*/g, "");
    expect(code).toMatch(/IF _end_lat IS NOT NULL AND _end_lon IS NOT NULL THEN/);
  });
  it("refuses an end point no stop of the day can reach", () => {
    // Found in production an hour after 20260831150000 shipped: five demo
    // technicians carried 40.748,-73.986 — the Empire State Building — seeded
    // when that data was New York based and left behind when the stops moved to
    // Michigan, 784 km away. Inert while the solver ignored the end point.
    //
    // The size is not the damage; a constant cancels out of every comparison.
    // The SPREAD is. Measured on those twenty stops: closing legs of 6,195 to
    // 6,249 minutes, so 54 minutes between the best and worst last stop against
    // a real route improvement worth 2.4 minutes. The 2-opt would have spent the
    // whole pass ranking stops by closeness to Manhattan.
    //
    // The threshold is the org's own max_drive_minutes, not a literal: if the
    // CLOSEST stop cannot reach the end point inside it, no ordering ends there.
    // The minimum is the right statistic — a dump at one edge of a wide rural
    // territory is legitimately far from the stops at the other edge.
    const code = lastBody("plan_route").replace(/--[^\n]*/g, "");
    expect(code).toMatch(/max_drive_minutes/);
    expect(code).toMatch(/SELECT min\(lg\.minutes\) INTO _nearest_close FROM _legs lg WHERE lg\.to_id = _END/);
    expect(code).toMatch(/IF _nearest_close IS NOT NULL AND _nearest_close > _max_drive THEN/);
    // Dropped, not clamped: the day reverts to the open path it had before the
    // end point existed, which is strictly better than a wrong one.
    expect(code).toMatch(/DELETE FROM _legs WHERE to_id = _END/);
    // And it says so somewhere a person can find it.
    expect(code).toMatch(/RAISE WARNING/);
  });
});
