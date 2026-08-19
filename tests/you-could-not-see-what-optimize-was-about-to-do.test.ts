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

function lastBody(name: string) {
  const at = SQL.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(at, `${name} is not defined`).toBeGreaterThan(-1);
  const end = SQL.indexOf("$$;", SQL.indexOf("AS $$", at));
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
    const plan = lastBody("plan_route");
    expect(plan).toMatch(/SELECT array_agg\(x ORDER BY ord DESC\) INTO _rev/);
    expect(
      plan.match(/_order\[1:_i-1\] \|\| _rev \|\| _order\[_j\+1:array_length\(_order,1\)\]/g)
        ?.length,
    ).toBe(2);
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
});
