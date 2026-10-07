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
    //
    // 100vh -> 100dvh, 2026-08-25. This was the only 100vh left in the app and
    // on iOS it resolves to the LARGE viewport, so the clamp was computed
    // against a taller box than the one on screen. Everything else here —
    // MobileTabBar's sheet, both dialogs — already used dvh.
    //
    // The "third of the viewport" in this test's name was only ever true on a
    // desktop: 32rem is 512px, which is 66% of a 780px phone. The phone clamp
    // below is the one that makes the name true there.
    expect(panel).toMatch(/max-h-\[min\(32rem,calc\(100dvh-6rem\)\)\] overflow-y-auto/);
    expect(panel).toMatch(/max-md:max-h-\[calc\(100dvh-11rem\)\]/);
  });

  it("clears the tab bar instead of hiding Apply behind it", () => {
    // The fault this pins, measured on an iPhone 17 Pro 2026-08-25: the panel
    // ended at y=846 and MobileTabBar began at y=789, so Apply (y 793-837) and
    // Cancel were ENTIRELY inside the bar. Both are z-40 and the nav renders
    // after <main>, so the nav painted over them; the panel is also too short
    // for its own scroller to engage, so no gesture reached the button.
    //
    // The offset has to carry the home-indicator inset as well as the bar's
    // height — on the web the overlap was 23px and survivable, and it was the
    // 34pt inset that turned it into "the primary action does not exist".
    // Same shape as InstallBanner.tsx:71, and it stops at md because that is
    // where the bar stops. The bar's height is --tab-bar-h (styles.css) since
    // 2026-10-07, the one number MobileTabBar is drawn at, rather than a 3.5rem
    // each caller wrote down for itself.
    expect(panel).toMatch(
      /max-md:bottom-\[calc\(var\(--tab-bar-h\)\+env\(safe-area-inset-bottom\)\+0\.75rem\)\]/,
    );
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
    // Two sections since 2026-08-26, not three: the level control is gone.
    // Fast/Balanced/Thorough offered one answer that always won and one that
    // silently discarded a customer's arrival window. See the LEVEL note in
    // the panel, and the measurements in
    // routing-said-nothing-about-the-technician-with-no-start-address.
    //
    // Three again since 2026-10-02, and the third is not the level: it is
    // the owner's arrival-window choice for this one run (honour them, or
    // shortest driving with every miss named). Still one value, so still one
    // open at a time.
    expect(panel).toMatch(/type Section = "dates" \| "techs" \| "windows" \| null/);
    expect(panel).toMatch(/const \[section, setSection\] = useState<Section>\(null\)/);
    for (const s of ["dates", "techs", "windows"]) {
      expect(panel).toMatch(new RegExp(`setSection\\(section === "${s}" \\? null : "${s}"\\)`));
    }
  });

  it("each pill states its current value while collapsed", () => {
    // The pill is the control AND the summary — otherwise you would have to
    // open the panel to find out what it is about to do.
    expect(panel).toMatch(/value=\{dateLabel\}/);
    expect(panel).toMatch(/value=\{techLabel\}/);
    // There is no third pill. A pill that always reads the same word is not a
    // summary of anything, and the level it would have shown is now fixed.
    expect(panel).not.toMatch(/value=\{LEVELS\./);
    expect(panel).toMatch(/from === to \? shortDay\(from\) :/);
    expect(panel).toMatch(/picked\.size === 0\s*\n?\s*\? "All techs"/);
  });
});

describe("the safeguards survived the redesign", () => {
  it("Apply is gated on the inputs it needs, now that there is no preview", () => {
    // CHANGED 2026-08-19, when the preview STEP was removed. `!p` meant "a
    // preview has been run and is still current" — a gate that only existed
    // because a second press did. What Apply can still be unreachable for is
    // the thing it could never work without: a bad range, or nobody selected.
    expect(panel).toMatch(/disabled=\{!rangeValid \|\| techs\.length === 0 \|\| busy\}/);
    expect(panel).not.toMatch(/previewMut/);
  });

  // REMOVED 2026-08-19 with the preview step: "changing any input still
  // invalidates the preview". It guarded a stored plan going stale — preview
  // Monday, switch the date to Friday, Apply runs the plan nobody was shown.
  // There is no stored plan now; Apply reads `from`, `to`, `chosen`, `level`
  // and `reassign` at the moment it is pressed, so the fault is
  // unrepresentable rather than prevented. Re-asserting `dirty()` here would
  // only pin the removed machinery back into place.

  it("still refuses to invent a saving for a day that had no route", () => {
    // Same property, moved: the sentence is now the success toast's
    // description, composed by drivingLine(). A day whose stops carried no
    // sequence is not a slower route, it is no route.
    expect(panel).toMatch(/if \(f\.daysMeasured === 0\) \{/);
    expect(panel).toMatch(/New route, so these days had no order to compare against\./);
    // And it still reports a WORSE result rather than rounding it out of view.
    expect(panel).toMatch(/the order it replaced was quicker/);
  });

  it("still surfaces skipped days rather than swallowing them", () => {
    expect(panel).toMatch(/r\.skipped\.slice\(0, 3\)/);
  });

  it("has no reassign control at all any more", () => {
    // REPLACED 2026-08-26. This used to assert the checkbox was VISIBLE rather
    // than collapsed behind a pill, and it kept passing after the checkbox was
    // deleted -- because the comment left in its place quotes the label, and a
    // match against the whole file finds the tombstone. It was also comparing
    // against `{section === "level" &&`, which no longer exists either, so
    // indexOf returned -1 and every index beat it. Two dead assertions, both
    // green, over a control that was gone.
    //
    // So: match CODE, not comments, and assert the absence.
    const code = panel.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/Also move work between techs/);
    expect(code).not.toMatch(/setReassign/);
    expect(code).not.toMatch(/<Checkbox/);
  });

  it("and always re-plans the selected people's day", () => {
    // The consent the checkbox asked for is given by the selection itself: the
    // planner only touches visits that are unassigned or already belong to a
    // SELECTED technician. Verified against production -- selecting everyone
    // except the technician holding all 21 of a day's stops returns zero rows.
    expect(panel).toMatch(/reassign:\s*true/);
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
    // CHANGED 2026-08-19: present tense, because by the time this is said the
    // write has already happened — "would still miss" described a plan being
    // offered, and there is no offer any more.
    expect(panel).toMatch(/1 stop still misses its arrival window\./);
    expect(panel).toMatch(/stops still miss their arrival windows\./);
    // "had no route to compare" has gone deliberately: it was a footnote to a
    // per-day comparison the card no longer shows, and the "New route" line
    // above carries the part of it a dispatcher acts on.
  });

  it("the headline and stop count moved to the toast, and both are still said", () => {
    // The card has no result box left to hold them. Losing one of the two
    // would be the regression — the count alone cannot tell a dispatcher
    // whether the reorder was worth anything.
    expect(panel).toMatch(/description: drivingLine\(r\.forecast\)/);
    expect(panel).toMatch(/`Routed \$\{r\.stops\} stop\$\{r\.stops === 1 \? "" : "s"\}`/);
  });
});
