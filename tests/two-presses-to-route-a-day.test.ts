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
const applyBlock = () => {
  const src = fns();
  const at = src.indexOf("export const applyOptimize");
  expect(at, "applyOptimize is gone").toBeGreaterThan(-1);
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
  it("applyOptimize measures before it writes", () => {
    const apply = applyBlock();
    const measured = apply.indexOf("forecastPlan(");
    const wrote = apply.indexOf('rpc("plan_day_across_staff"');
    expect(measured, "applyOptimize no longer measures at all").toBeGreaterThan(-1);
    expect(wrote).toBeGreaterThan(-1);
    // Order is the whole of it. Run afterwards, the same measurement finds an
    // empty day — the visits it would have planned are assigned and sequenced
    // by then — and reports a confident zero violations for every run.
    expect(measured, "the measurement runs after the write").toBeLessThan(wrote);
  });

  it("it measures with the read-only twin, not with the writer", () => {
    const src = fns();
    const at = src.indexOf("async function forecastPlan");
    expect(at, "forecastPlan is gone").toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("export const applyOptimize"));
    expect(body).toMatch(/rpc\("preview_optimize"/);
    // `plan_day_across_staff` and `plan_day_across_staff_dryrun` differ by a
    // suffix; `preview_optimize` reaches the second. Either writing name here
    // means Apply plans the day twice, the second time over the first.
    expect(body, "the measurement reaches a function that writes").not.toMatch(
      /rpc\("plan_day_across_staff/,
    );
    expect(body, "the measurement reaches a function that writes").not.toMatch(
      /rpc\("optimize_route_v3"/,
    );
  });

  it("a failed measurement does not cost the dispatcher their Apply", () => {
    // They asked for the day to be routed, not for a report.
    const apply = applyBlock();
    expect(apply).toMatch(/try \{\s*\n\s*forecast = await forecastPlan\(/);
    expect(apply).toMatch(/catch \{\s*\n\s*forecast = null;/);
  });

  it("and the panel says so rather than printing a zero", () => {
    // "The check found nothing" and "the check did not run" must not be the
    // same sentence on screen. `?? 0` on a null forecast is the second
    // wearing the first's clothes, which is why the null is warned about.
    const ui = panel();
    expect(ui).toMatch(/if \(!r\.forecast\) \{/);
    expect(ui).toMatch(/arrival-window check could not run/);
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
    expect(fns()).toMatch(/skipped\.push\(/);
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

  it("but preview_optimize the SQL function still has a real caller", () => {
    // This is what check-dead-machinery's rule 1 asks. It is asserted here as
    // well because the answer is the entire justification for the shape above:
    // the dry-run machinery stays in SQL, called, rather than being kept alive
    // by a note in a file.
    expect(fns()).toMatch(/rpc\("preview_optimize"/);
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
