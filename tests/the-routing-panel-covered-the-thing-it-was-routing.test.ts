// Auto-routing was correct and unusable.
//
// It rendered as a full-width block between the toolbar and the board, so
// opening it pushed the schedule off-screen at the moment you started
// rearranging the schedule. Every control was expanded simultaneously — two
// date inputs, three level buttons each with a paragraph of hint text, a chip
// per tech, a bordered switch with two lines of explanation, two buttons, and
// a result table — roughly 500px before a preview had even run.
//
// The verdict was that it "covers the majority of the screen" and is "very
// much in the way", and that is exactly what it did.
//
// The rebuild is a ~320px card floating over the board. Each input collapses
// to a pill stating its current value and opens only when clicked, one at a
// time. These assertions are the properties that make that true; each is
// something the next "just one more field" would quietly undo.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const panel = readFileSync(join(root, "src/components/routes/AutoRoutingPanel.tsx"), "utf8");
const page = readFileSync(join(root, "src/routes/_authenticated/routes.tsx"), "utf8");

describe("it floats instead of displacing the board", () => {
  it("is fixed-position and bounded in width", () => {
    expect(panel).toMatch(/className="fixed inset-x-3 bottom-3 z-40/);
    expect(panel).toMatch(/sm:w-80/);
  });

  it("cannot grow past a third of the viewport", () => {
    // Without this, a long tech list or a long preview turns the floating card
    // back into the full-height slab it replaced.
    expect(panel).toMatch(/max-h-\[min\(32rem,calc\(100vh-6rem\)\)\] overflow-y-auto/);
  });

  it("is reachable as a dialog and closes the ways people expect", () => {
    expect(panel).toMatch(/role="dialog"/);
    expect(panel).toMatch(/aria-label="Close auto-routing"/);
    // Escape backs out one level — open section first, then the card.
    expect(panel).toMatch(/if \(e\.key !== "Escape"\) return;/);
    expect(panel).toMatch(/if \(section\) setSection\(null\);\s*\n\s*else onClose\(\);/);
  });

  it("the page passes it a way to close itself", () => {
    // It was previously closed only by the toolbar toggle that opened it,
    // which is behind the card on a narrow screen.
    expect(page).toMatch(/onClose=\{\(\) => setToolsOpen\(false\)\}/);
  });
});

describe("one control open at a time", () => {
  it("sections are mutually exclusive by construction", () => {
    // A single `section` value rather than three booleans: three booleans can
    // all be true, and that is how the slab came back.
    expect(panel).toMatch(/type Section = "dates" \| "techs" \| "level" \| null/);
    expect(panel).toMatch(/const \[section, setSection\] = useState<Section>\(null\)/);
    for (const s of ["dates", "techs", "level"]) {
      expect(panel).toMatch(
        new RegExp(`setSection\\(section === "${s}" \\? null : "${s}"\\)`),
      );
    }
  });

  it("each pill states its current value while collapsed", () => {
    // The pill is the control AND the summary — otherwise you would have to
    // open the panel to find out what it is about to do.
    expect(panel).toMatch(/value=\{dateLabel\}/);
    expect(panel).toMatch(/value=\{techLabel\}/);
    expect(panel).toMatch(/value=\{LEVELS\.find\(\(l\) => l\.value === level\)!\.label\}/);
    expect(panel).toMatch(/from === to \? shortDay\(from\) :/);
    expect(panel).toMatch(/picked\.size === 0\s*\n?\s*\? "All techs"/);
  });
});

describe("the safeguards survived the redesign", () => {
  it("Apply is still unreachable until a preview exists", () => {
    expect(panel).toMatch(/disabled=\{!p \|\| applyMut\.isPending/);
  });

  it("changing any input still invalidates the preview", () => {
    // Otherwise you preview Monday, switch the date to Friday, and Apply runs
    // against a plan nobody was shown.
    expect(panel).toMatch(/const dirty = \(\) => \{\s*\n\s*previewMut\.reset\(\);/);
    const dirtyCalls = panel.match(/dirty\(\);/g) ?? [];
    // dates x2, techs toggle, techs clear, level, reassign.
    expect(dirtyCalls.length).toBeGreaterThanOrEqual(6);
  });

  it("still refuses to invent a saving for a day that had no route", () => {
    expect(panel).toMatch(/New route/);
    expect(panel).toMatch(/the current\s+order is already better/);
  });

  it("still surfaces skipped days rather than swallowing them", () => {
    expect(panel).toMatch(/r\.skipped\.slice\(0, 3\)/);
  });

  it("the reassign control stays visible instead of hiding behind a pill", () => {
    // It is the only control that can move a stop between people. Collapsing
    // it to save space would make that discoverable only after the fact.
    expect(panel).toMatch(/Also move work between techs/);
    const reassignIdx = panel.indexOf("Also move work between techs");
    const sectionIdx = panel.indexOf('{section === "level" &&');
    expect(reassignIdx).toBeGreaterThan(sectionIdx);
  });
});

describe("preview detail moved out of the card", () => {
  it("the per-day table is gone", () => {
    // Fourteen rows of before/after is not what a dispatcher deciding whether
    // to apply is reading.
    expect(panel).not.toMatch(/<table/);
    expect(panel).not.toMatch(/before_known/);
  });

  it("but the fact that would change your mind is a toast", () => {
    expect(panel).toMatch(/would still miss its arrival window/);
    expect(panel).toMatch(/had no route to compare/);
  });

  it("the headline and stop count remain in the card", () => {
    expect(panel).toMatch(/Saves about <strong>\{mins\(t!\.savedMin\)\}<\/strong>/);
    expect(panel).toMatch(/\{t!\.stops\} stop/);
  });
});
