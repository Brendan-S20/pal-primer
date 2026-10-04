// Routing a day took two presses, and the first one only bought a warning.
//
// Owner QA, 2026-08-19: "Also remove the preview, let's just have apply."
//
// The panel made Preview mandatory. It ran the read-only planner, printed a
// headline in a box on the card, and only then did Apply become pressable —
// the safeguard being that nothing rearranges a day somebody has not first
// been shown. That safeguard was worth stating and is not worth two presses on
// a phone in a driveway, which is where this panel is actually used.
//
// ── WHAT REMOVING A STEP MUST NOT REMOVE ──────────────────────────────────
//
// The preview was carrying one fact nothing else knows. `plan_day_across_staff`
// — the writer — returns stops and minutes per technician and NO violation
// count, so "3 of these stops will still miss their arrival window" existed
// only in what `preview_optimize` measured. Delete the step naively and that
// warning does not become quieter, it stops existing, and the dispatcher's
// day looks perfect.
//
// So the step went and the measurement stayed: applyOptimize calls
// `preview_optimize` itself, immediately before the write, and returns what it
// said as `forecast`. Two planner runs per Apply, which is exactly what
// Preview-then-Apply already cost, minus a press.
//
// ── WHAT THIS FILE PINS, AND WHY EACH ONE ─────────────────────────────────
//
// Three things could quietly undo it, and all three look like tidying up:
//
//   1. Someone deletes the measurement because "Apply doesn't need a preview".
//      The button keeps working. The warning silently stops.
//   2. Someone points the measurement at `plan_day_across_staff` — one
//      identifier away, nearly the same rows — and the day gets planned for
//      real twice, the second time over the first.
//   3. Someone lets a failed measurement fail the Apply, or report a zero.
//      A dispatcher reading "no stops miss their window" cannot tell that from
//      "nobody looked".
//
// ── WHAT IT CANNOT SHOW ───────────────────────────────────────────────────
//
// That the number is right. Text cannot run a planner. The measurement and the
// write are separate round trips, so a visit edited between them makes the
// reported count describe a plan one edit older than the one written — the
// same window that existed between pressing Preview and pressing Apply, and
// narrower now, because nothing waits on a human in between.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Comments are not code. The prose above and in both sources under test
 *  quotes the very things being banned — "Preview", `previewOptimize` — so a
 *  rule that reads comments reports the explanation as the violation. */
const codeOnly = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*"));
    })
    .join("\n");

const panel = () => codeOnly(read("src/components/routes/AutoRoutingPanel.tsx"));
const fns = () => codeOnly(read("src/lib/visits.functions.ts"));
// CHANGED 2026-10-04: auto-routing became a background run and left
// visits.functions.ts. applyOptimize, the server function, is gone (an
// export with no caller is a live endpoint); the work it did is
// runAutoRouting in auto-routing.server.ts, which is what these read now.
const applyBlock = () => {
  const src = codeOnly(read("src/lib/auto-routing.server.ts"));
  const at = src.indexOf("export async function runAutoRouting");
  expect(at, "runAutoRouting is gone").toBeGreaterThan(-1);
  return src.slice(at);
};

describe("the dispatcher presses one button", () => {
  it("the card has no Preview control and no preview mutation", () => {
    const ui = panel();
    expect(ui, "a Preview button is back").not.toMatch(/>\s*Preview/);
    expect(ui, "the preview mutation is back").not.toMatch(/previewMut/);
    expect(ui, "the panel imports the deleted server function").not.toMatch(/previewOptimize/);
  });

  it("Apply is the only thing that runs the planner from this card", () => {
    const mutates = panel().match(/\w+Mut\.mutate\(\)/g) ?? [];
    expect(mutates).toEqual(["applyMut.mutate()"]);
  });

  it("and it is pressable without one, guarded by the inputs instead", () => {
    // The old gate was `!p` — no preview, no Apply. What it protected against
    // was a run the planner would refuse anyway: a backwards range, or nobody
    // to route. Those are the conditions, so those are the gate.
    expect(panel()).toMatch(/disabled=\{!rangeValid \|\| techs\.length === 0 \|\| busy\}/);
  });

  it("what the box used to say, the toast says", () => {
    // The two halves of the old headline: the stop count, and the driving
    // line. Neither was allowed to just disappear with the box that held them.
    const ui = panel();
    expect(ui).toMatch(/`Routed \$\{r\.stops\} stop/);
    expect(ui).toMatch(/description: drivingLine\(r\.forecast\)/);
  });

  it("and it can still say that there was nothing to route", () => {
    // The other sentence the box carried, and the one place `r.stops` lies:
    // with nothing to plan, plan_day_across_staff returns each technician's
    // CURRENT load, so a run that touched no row reports the whole day as
    // routed. `daysPlanned === 0` from the measurement is what distinguishes
    // them, which is a second reason the measurement is not optional.
    const ui = panel();
    expect(ui).toMatch(/r\.forecast && r\.forecast\.daysPlanned === 0/);
    expect(ui).toMatch(/Nothing to route in that range/);
  });

  it("the result box went with it — the card states inputs, not outcomes", () => {
    // Its content is the toast's now. Left on the card it would be a stale
    // reading of a day that has already been rearranged.
    const ui = panel();
    expect(ui).not.toMatch(/previewMut\.data/);
    expect(ui).not.toMatch(/\bt!\./);
  });
});

describe("the measurement survived the step", () => {
  // CHANGED 2026-10-02. The planner moved out of Postgres (route-solver.ts):
  // each day is read (route_day_inputs), solved here, and written
  // (apply_route_plan). The write itself now returns what only the dry run
  // used to know -- late stops per technician, and every window missed, by
  // name -- so there is no second planner run to take before the write, and
  // nothing for it to disagree with. These pin that the facts still arrive.
  const plan = () => codeOnly(read("src/lib/route-plan.server.ts"));

  // CHANGED 2026-10-04: still read, solve, write, in that order -- but the
  // write is once per RUN, after every day is solved, in one transaction
  // (apply_route_plans), so a run cut off part-way has written nothing.
  it("the run reads and solves each day, then writes them all, in that order", () => {
    const p = plan();
    const readAt = p.indexOf('rpc("route_day_inputs"');
    const solvedAt = p.indexOf("planDay(");
    const wroteAt = p.indexOf('rpc("apply_route_plans"');
    expect(readAt).toBeGreaterThan(-1);
    expect(readAt).toBeLessThan(solvedAt);
    expect(solvedAt).toBeLessThan(wroteAt);
    const apply = applyBlock();
    expect(apply).toMatch(/await planDayRoutes\(/);
    const loopAt = apply.indexOf("for (const day of days)");
    const planAt = apply.indexOf("await planDayRoutes(");
    const writeAt = apply.indexOf("await applyRoutePlans(");
    expect(loopAt).toBeGreaterThan(-1);
    expect(loopAt).toBeLessThan(planAt);
    expect(planAt).toBeLessThan(writeAt);
    // Exactly one write, and it is outside the day loop: the loop's body
    // ends (its `continue` and `solved++`) before the write is reached.
    expect(apply.match(/applyRoutePlans\(/g)).toHaveLength(1);
    expect(apply.slice(planAt, writeAt)).toMatch(/solved\+\+;\s*\}\s*\}/);
  });

  it("the read writes nothing that outlives the call", () => {
    // The trap the old file named -- a "measurement" one identifier away from
    // a writer -- now has this shape: the read must not write. Its only
    // statements that change anything touch its own temp table.
    const sql = read(
      "supabase/migrations/20261002090700_the-route-is-solved-outside-the-database.sql",
    );
    const body = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.route_day_inputs"),
      sql.indexOf("CREATE OR REPLACE FUNCTION public.apply_route_plan"),
    );
    const writes = [...body.matchAll(/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+([\w.]+)/gi)].map(
      (m) => m[1],
    );
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(w).toBe("_rdi_pts");
  });

  it("the late count comes back from the write, per technician", () => {
    expect(applyBlock()).toMatch(/violations \+= r\.late;/);
    expect(plan()).toMatch(/late: Number\(r\.late \?\? 0\)/);
  });

  it("a day that cannot be planned is reported, and the other days still run", () => {
    const apply = applyBlock();
    expect(apply).toMatch(/skipped\.push\(\{ staffId: "", day, reason:/);
    expect(apply).toMatch(/continue;/);
  });

  it("and the panel says when nothing at all was routed rather than printing a zero", () => {
    const ui = panel();
    expect(ui).toMatch(/\} else if \(!r\.forecast\) \{/);
    expect(ui).toMatch(/Nothing was routed\./);
  });
});

describe("both refusals still reach the person who pressed the button", () => {
  it("a stop that will still miss its arrival window", () => {
    const ui = panel();
    expect(ui).toMatch(/r\.forecast\?\.violations/);
    expect(ui).toMatch(/still misses its arrival window/);
    expect(ui).toMatch(/still miss their arrival windows/);
  });

  it("a day the planner refused", () => {
    // Unchanged by any of this, and asserted here anyway: the skipped days are
    // the other half of "refusals are surfaced, not swallowed", and the two
    // now arrive through the same toast handler.
    expect(applyBlock()).toMatch(/skipped\.push\(/);
    expect(panel()).toMatch(/r\.skipped\.slice\(0, 3\)/);
  });
});

describe("nothing was left lying around, and nothing was silenced", () => {
  it("previewOptimize is not an exported server function any more", () => {
    // It was the only caller of the SQL preview and it had no caller of its
    // own once the step went. An exported createServerFn with no UI behind it
    // is still a live endpoint anybody who can post can reach — the reason
    // assignRoute and its three siblings were deleted rather than kept.
    expect(fns(), "previewOptimize is exported again").not.toMatch(/export const previewOptimize/);
  });

  it("and preview_optimize the SQL function is no longer an endpoint", () => {
    // CHANGED 2026-10-02: the app stopped calling it (the write reports what
    // it measured). It stays defined because the routing trials hold the new
    // planner to the old one, but it is no longer granted to `authenticated`:
    // an RPC with no caller is still an endpoint anybody signed in can post
    // to. Its caller is the benchmark, and that is asserted, not noted.
    expect(fns()).not.toMatch(/rpc\("preview_optimize"/);
    const sql = read(
      "supabase/migrations/20261002090700_the-route-is-solved-outside-the-database.sql",
    );
    expect(sql).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.preview_optimize\(uuid, uuid\[\], date, date, text, boolean\) FROM authenticated;/,
    );
    expect(read("scripts/routing-trials/harness.ts")).toMatch(/public\.preview_optimize\(/);
  });

  it("and it was not written into the baseline instead", () => {
    // A baseline entry is a record of a decision, never a mute button. If a
    // future change does leave preview_optimize uncalled, the fix is to delete
    // it or to call it — this assertion is here so that adding a line to the
    // JSON is not quietly the third option.
    const baseline = JSON.parse(read("scripts/dead-machinery-baseline.json"));
    expect(baseline.uncalled_rpcs).not.toHaveProperty("preview_optimize");
    expect(baseline.unwired_server_fns).not.toHaveProperty("previewOptimize");
  });
});
